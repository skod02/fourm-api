import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  generateUUID,
  now,
  SESSION_TTL_SECONDS,
} from '../lib/auth.js';
import { validateTurnstile } from '../middleware/turnstile.js';
import { sessionAuth } from '../middleware/auth.js';
import { ok, created, badRequest, unauthorized, conflict, internalError, notFound } from '../lib/response.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const auth = new Hono<HonoType>();

// ── POST /api/auth/register ─────────────────────────────────
auth.post('/register', validateTurnstile, async (c) => {
  let body: { username?: string; email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { username, email, password } = body;

  if (!username || !email || !password) {
    return badRequest('username, email, and password are required');
  }
  if (username.length < 3 || username.length > 32) {
    return badRequest('Username must be 3-32 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return badRequest('Username may only contain letters, numbers, underscores, hyphens');
  }
  if (password.length < 8) {
    return badRequest('Password must be at least 8 characters');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return badRequest('Invalid email format');
  }

  // Check uniqueness
  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ?'
  ).bind(username.toLowerCase(), email.toLowerCase()).first<{ id: string }>();

  if (existing) return conflict('Username or email already in use');

  const userId = generateUUID();
  const passwordHash = await hashPassword(password);
  const nowTs = now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, is_vip, is_banned, reputation,
       api_secret_hash, vip_key, username_changes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 0, 0, 0, NULL, NULL, 0, ?, ?)`
    )
      .bind(userId, username.toLowerCase(), email.toLowerCase(), passwordHash, nowTs, nowTs)
      .run();
  } catch (e) {
    console.error('[register] D1 insert error:', e);
    return conflict('Username or email already in use');
  }

  // Trigger onboarding workflow
  try {
    await c.env.USER_ONBOARDING_WORKFLOW.create({
      params: { userId, username: username.toLowerCase(), email: email.toLowerCase() },
    });
  } catch (e) {
    console.error('[register] workflow trigger failed:', e);
  }

  return created({
    id: userId,
    username: username.toLowerCase(),
    message: 'Account created successfully. Check your inbox for a welcome message.',
  });
});

// ── POST /api/auth/login ────────────────────────────────────
auth.post('/login', validateTurnstile, async (c) => {
  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { username, password } = body;
  if (!username || !password) return badRequest('username and password required');

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ?'
  )
    .bind(username.toLowerCase(), username.toLowerCase())
    .first<import('../types.js').User>();

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  const ua = c.req.header('User-Agent') ?? '';
  const nowTs = now();

  if (!user) {
    // Constant-time: still run password hash to prevent user enumeration
    await verifyPassword(password, 'fake:fakefakefakefakefake==');
    await c.env.DB.prepare(
      'INSERT INTO login_history (user_id, ip, user_agent, success, created_at) VALUES (?, ?, ?, 0, ?)'
    ).bind('unknown', ip, ua, nowTs).run();
    return unauthorized('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.password_hash);

  await c.env.DB.prepare(
    'INSERT INTO login_history (user_id, ip, user_agent, success, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(user.id, ip, ua, valid ? 1 : 0, nowTs).run();

  if (!valid) return unauthorized('Invalid credentials');
  if (user.is_banned) return unauthorized('Your account has been banned');

  // Issue session
  const rawToken = generateSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = nowTs + SESSION_TTL_SECONDS;

  await c.env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(tokenHash, user.id, ip, ua, expiresAt, nowTs).run();

  // Cache in KV
  const kvKey = `session:${tokenHash}`;
  const safeUser = { ...user, password_hash: '' };
  await c.env.SESSIONS_KV.put(kvKey, JSON.stringify({ user: safeUser, expires_at: expiresAt }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return ok({
    token: rawToken,
    expires_at: expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      is_vip: Boolean(user.is_vip),
      reputation: user.reputation,
    },
  });
});

// ── POST /api/auth/logout ───────────────────────────────────
auth.post('/logout', sessionAuth, async (c) => {
  const rawToken = c.get('sessionToken');
  if (!rawToken) return unauthorized();

  const tokenHash = await hashToken(rawToken);
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  await c.env.SESSIONS_KV.delete(`session:${tokenHash}`);

  return ok({ message: 'Logged out successfully' });
});

// ── GET /api/auth/me ────────────────────────────────────────
auth.get('/me', sessionAuth, (c) => {
  const user = c.get('user')!;
  return ok({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    is_vip: Boolean(user.is_vip),
    is_banned: Boolean(user.is_banned),
    reputation: user.reputation,
    username_changes: user.username_changes,
    created_at: user.created_at,
  });
});

// ── GET /api/auth/login-history ─────────────────────────────
auth.get('/login-history', sessionAuth, async (c) => {
  const user = c.get('user')!;
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10));
  const offset = (page - 1) * limit;

  const rows = await c.env.DB.prepare(
    'SELECT id, ip, user_agent, success, created_at FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  )
    .bind(user.id, limit, offset)
    .all();

  return ok(rows.results, { page, limit });
});

// ── POST /api/auth/reset-password ───────────────────────────
auth.post('/reset-password', validateTurnstile, async (c) => {
  let body: { email?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { email } = body;
  if (!email) return badRequest('email is required');

  // Always return 200 to prevent email enumeration
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first<{ id: string }>();

  if (user) {
    // Enqueue password reset email via Queue
    try {
      await c.env.EMAIL_QUEUE.send({
        to: email.toLowerCase(),
        subject: 'Password Reset Request',
        body: `A password reset was requested for your account. If you did not request this, ignore this message.`,
        type: 'password_reset',
      });
    } catch (e) {
      console.error('[reset-password] queue error:', e);
    }
  }

  return ok({ message: 'If your email is registered, a reset link has been sent.' });
});

export default auth;
