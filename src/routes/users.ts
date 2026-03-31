// ============================================================
// routes/users.ts — User Profile & Settings Routes
// GET    /api/users/me
// GET    /api/users/:uuid/profile
// PATCH  /api/users/me/username
// POST   /api/users/me/vip-request
// POST   /api/users/me/api-secret/regenerate
// GET    /api/users/me/api-secret
// ============================================================

import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth } from '../middleware/auth.js';
import { ok, notFound, badRequest, forbidden, conflict } from '../lib/response.js';
import { generateApiSecret, hashToken, generateUUID, now } from '../lib/auth.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const users = new Hono<HonoType>();

// ── GET /api/users/me ────────────────────────────────────────
users.get('/me', sessionAuth, async (c) => {
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
    has_api_secret: Boolean(user.api_secret_hash),
    vip_key: user.is_vip ? user.vip_key : null,
    created_at: user.created_at,
  });
});

// ── GET /api/users/:uuid/profile ─────────────────────────────
users.get('/:uuid/profile', async (c) => {
  const { uuid } = c.req.param();

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.is_vip, u.reputation, u.created_at,
            COUNT(DISTINCT t.id) as thread_count,
            COUNT(DISTINCT r.id) as reply_count
     FROM users u
     LEFT JOIN threads t ON t.author_id = u.id AND t.status = 'active'
     LEFT JOIN replies r ON r.author_id = u.id AND r.status = 'active'
     WHERE u.id = ?
     GROUP BY u.id`
  ).bind(uuid).first<Record<string, unknown>>();

  if (!user) return notFound('User not found');
  return ok(user);
});

// ── PATCH /api/users/me/username ─────────────────────────────
users.patch('/me/username', sessionAuth, async (c) => {
  const user = c.get('user')!;

  let body: { username?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }
  const { username } = body;

  if (!username) return badRequest('username is required');
  if (username.length < 3 || username.length > 32) return badRequest('Username 3-32 chars');
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return badRequest('Invalid username characters');

  // Enforce change limit
  const FREE_CHANGES = 1;
  if (!user.is_vip && user.username_changes >= FREE_CHANGES) {
    return forbidden('Free users get 1 username change. Upgrade to VIP for unlimited changes.');
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?')
    .bind(username.toLowerCase(), user.id).first<{ id: string }>();
  if (existing) return conflict('Username already taken');

  const nowTs = now();
  await c.env.DB.prepare(
    'UPDATE users SET username = ?, username_changes = username_changes + 1, updated_at = ? WHERE id = ?'
  ).bind(username.toLowerCase(), nowTs, user.id).run();

  // Invalidate KV sessions so they reload from D1
  await c.env.SESSIONS_KV.delete(`onboarding_secret:${user.id}`);

  return ok({ username: username.toLowerCase(), changes_used: user.username_changes + 1 });
});

// ── POST /api/users/me/vip-request ───────────────────────────
users.post('/me/vip-request', sessionAuth, async (c) => {
  const user = c.get('user')!;

  if (user.is_vip) return badRequest('You already have VIP membership');

  // Check for pending request
  const existing = await c.env.DB.prepare(
    "SELECT id FROM vip_requests WHERE user_id = ? AND status = 'pending'"
  ).bind(user.id).first<{ id: string }>();
  if (existing) return conflict('You already have a pending VIP request');

  let body: { reason?: string };
  try { body = await c.req.json(); } catch { body = {}; }

  const requestId = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    `INSERT INTO vip_requests (id, user_id, status, reason, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`
  ).bind(requestId, user.id, body.reason ?? null, nowTs, nowTs).run();

  // Trigger VIP approval workflow
  let instanceId: string | null = null;
  try {
    const instance = await c.env.VIP_APPROVAL_WORKFLOW.create({
      params: { requestId, userId: user.id, username: user.username, reason: body.reason },
    });
    instanceId = instance.id;

    await c.env.DB.prepare(
      'UPDATE vip_requests SET workflow_instance_id = ? WHERE id = ?'
    ).bind(instanceId, requestId).run();
  } catch (e) {
    console.error('[vip-request] workflow trigger failed:', e);
  }

  return ok({
    request_id: requestId,
    message: 'VIP request submitted. An admin will review your request within 72 hours.',
  });
});

// ── GET /api/users/me/api-secret ─────────────────────────────
// Returns raw secret only once after creation (from KV)
users.get('/me/api-secret', sessionAuth, async (c) => {
  const user = c.get('user')!;

  const rawSecret = await c.env.SESSIONS_KV.get(`onboarding_secret:${user.id}`);
  if (rawSecret) {
    // Delete after retrieval — one-time access
    await c.env.SESSIONS_KV.delete(`onboarding_secret:${user.id}`);
    return ok({ api_secret: rawSecret, note: 'This is shown only once. Store it securely.' });
  }

  return ok({
    has_api_secret: Boolean(user.api_secret_hash),
    note: 'Your API secret is set. Regenerate to get a new one. Old one cannot be recovered.',
  });
});

// ── POST /api/users/me/api-secret/regenerate ─────────────────
users.post('/me/api-secret/regenerate', sessionAuth, async (c) => {
  const user = c.get('user')!;

  const rawSecret = generateApiSecret();
  const secretHash = await hashToken(rawSecret);
  const nowTs = now();

  await c.env.DB.prepare('UPDATE users SET api_secret_hash = ?, updated_at = ? WHERE id = ?')
    .bind(secretHash, nowTs, user.id).run();

  // Store new raw secret in KV for one-time retrieval
  await c.env.SESSIONS_KV.put(
    `onboarding_secret:${user.id}`,
    rawSecret,
    { expirationTtl: 3600 }
  );

  return ok({
    message: 'API secret regenerated. The old secret is now invalid.',
    note: 'Retrieve your new secret via GET /api/users/me/api-secret within 1 hour.',
  });
});

// ── GET /api/users/me/vip-key ────────────────────────────────
users.get('/me/vip-key', sessionAuth, async (c) => {
  const user = c.get('user')!;
  if (!user.is_vip) return forbidden('VIP membership required');
  return ok({ vip_key: user.vip_key });
});

export default users;
