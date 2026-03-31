import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth, requireRole } from '../middleware/auth.js';
import { ok, notFound, badRequest, created } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';
import { generateLicenseKey } from '../lib/keys.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const admin = new Hono<HonoType>();

// All admin routes require auth + admin role
admin.use('*', sessionAuth, requireRole('admin'));

// ── GET /api/admin/users ─────────────────────────────────────
admin.get('/users', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '50', 10));
  const offset = (page - 1) * limit;

  const rows = await c.env.DB.prepare(
    `SELECT id, username, email, role, is_vip, is_banned, reputation, username_changes, created_at
     FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const total = await c.env.DB.prepare('SELECT COUNT(*) as total FROM users')
    .first<{ total: number }>();

  return ok(rows.results, { page, limit, total: total?.total ?? 0 });
});

// ── PATCH /api/admin/users/:id/ban ───────────────────────────
admin.patch('/users/:id/ban', async (c) => {
  const { id } = c.req.param();
  let body: { banned?: boolean; reason?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { banned = true } = body;

  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(id).first<{ id: string; role: string }>();
  if (!user) return notFound('User not found');
  if (user.role === 'admin') return badRequest('Cannot ban admin users');

  await c.env.DB.prepare('UPDATE users SET is_banned = ?, updated_at = ? WHERE id = ?')
    .bind(banned ? 1 : 0, now(), id).run();

  return ok({ id, is_banned: banned });
});

// ── PATCH /api/admin/users/:id/role ──────────────────────────
admin.patch('/users/:id/role', async (c) => {
  const { id } = c.req.param();
  let body: { role?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { role } = body;
  if (!role || !['user', 'mod', 'admin'].includes(role)) {
    return badRequest('role must be: user | mod | admin');
  }

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(id).first<{ id: string }>();
  if (!user) return notFound();

  await c.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .bind(role, now(), id).run();

  return ok({ id, role });
});

// ── GET /api/admin/reports ───────────────────────────────────
admin.get('/reports', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10));
  const offset = (page - 1) * limit;

  const rows = await c.env.DB.prepare(
    `SELECT r.*, u.username as reporter_username
     FROM reports r JOIN users u ON r.reporter_id = u.id
     WHERE r.status = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
  ).bind(status, limit, offset).all();

  return ok(rows.results, { page, limit });
});

// ── PATCH /api/admin/reports/:id ─────────────────────────────
admin.patch('/reports/:id', async (c) => {
  const adminUser = c.get('user')!;
  const { id } = c.req.param();
  let body: { status?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { status } = body;
  if (!status || !['resolved', 'dismissed'].includes(status)) {
    return badRequest('status must be: resolved | dismissed');
  }

  await c.env.DB.prepare(
    'UPDATE reports SET status = ?, resolved_by = ?, updated_at = ? WHERE id = ?'
  ).bind(status, adminUser.id, now(), id).run();

  return ok({ id, status });
});

// ── GET /api/admin/dmca ──────────────────────────────────────
admin.get('/dmca', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const rows = await c.env.DB.prepare(
    'SELECT * FROM dmca_requests WHERE status = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(status).all();
  return ok(rows.results);
});

// ── PATCH /api/admin/dmca/:id ────────────────────────────────
admin.patch('/dmca/:id', async (c) => {
  const adminUser = c.get('user')!;
  const { id } = c.req.param();
  let body: { status?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { status } = body;
  if (!status || !['upheld', 'dismissed', 'under_review'].includes(status)) {
    return badRequest('status must be: upheld | dismissed | under_review');
  }

  await c.env.DB.prepare(
    'UPDATE dmca_requests SET status = ?, resolved_by = ?, updated_at = ? WHERE id = ?'
  ).bind(status, adminUser.id, now(), id).run();

  return ok({ id, status });
});

// ── GET /api/admin/vip-queue ─────────────────────────────────
admin.get('/vip-queue', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT v.*, u.username, u.reputation, u.created_at as user_created_at
     FROM vip_requests v JOIN users u ON v.user_id = u.id
     WHERE v.status = 'pending' ORDER BY v.created_at ASC LIMIT 50`
  ).all();
  return ok(rows.results);
});

// ── POST /api/admin/vip-queue/:id/approve ────────────────────
admin.post('/vip-queue/:id/approve', async (c) => {
  const adminUser = c.get('user')!;
  const { id } = c.req.param();
  const nowTs = now();

  const request = await c.env.DB.prepare(
    "SELECT user_id FROM vip_requests WHERE id = ? AND status = 'pending'"
  ).bind(id).first<{ user_id: string }>();
  if (!request) return notFound('VIP request not found or already processed');

  const vipKey = `VIP-${generateLicenseKey().replace(/-/g, '').slice(0, 16)}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE vip_requests SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?'
    ).bind('approved', adminUser.id, nowTs, id),
    c.env.DB.prepare(
      'UPDATE users SET is_vip = 1, vip_key = ?, updated_at = ? WHERE id = ?'
    ).bind(vipKey, nowTs, request.user_id),
    c.env.DB.prepare(
      `INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, 'system', ?, ?, ?)`
    ).bind(
      generateUUID(),
      request.user_id,
      `✅ Your VIP request has been approved! Your VIP key: ${vipKey}`,
      nowTs
    ),
  ]);

  return ok({ id, status: 'approved', vip_key: vipKey });
});

// ── POST /api/admin/vip-queue/:id/deny ───────────────────────
admin.post('/vip-queue/:id/deny', async (c) => {
  const adminUser = c.get('user')!;
  const { id } = c.req.param();
  const nowTs = now();

  const request = await c.env.DB.prepare(
    "SELECT user_id FROM vip_requests WHERE id = ? AND status = 'pending'"
  ).bind(id).first<{ user_id: string }>();
  if (!request) return notFound('VIP request not found or already processed');

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE vip_requests SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?'
    ).bind('denied', adminUser.id, nowTs, id),
    c.env.DB.prepare(
      `INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, 'system', ?, ?, ?)`
    ).bind(
      generateUUID(),
      request.user_id,
      '❌ Your VIP request was reviewed and denied at this time.',
      nowTs
    ),
  ]);

  return ok({ id, status: 'denied' });
});

// ── GET /api/admin/listings/pending ──────────────────────────
admin.get('/listings/pending', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.*, u.username as seller_username
     FROM listings l JOIN users u ON l.seller_id = u.id
     WHERE l.status = 'pending' ORDER BY l.created_at ASC LIMIT 50`
  ).all();
  return ok(rows.results);
});

// ── GET /api/admin/stats ─────────────────────────────────────
admin.get('/stats', async (c) => {
  const [users, threads, keys, listings, reports] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM users'),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM threads WHERE status = 'active'"),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM license_keys'),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM listings WHERE status = 'active'"),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM reports WHERE status = 'open'"),
  ]);

  // Online count from DO
  let onlineCount = 0;
  try {
    const trackerId = c.env.ONLINE_TRACKER.idFromName('global');
    const stub = c.env.ONLINE_TRACKER.get(trackerId);
    const res = await stub.fetch(new Request('https://do/count'));
    const data = await res.json<{ count: number }>();
    onlineCount = data.count;
  } catch {}

  return ok({
    users: (users.results[0] as { total: number }).total,
    threads: (threads.results[0] as { total: number }).total,
    license_keys: (keys.results[0] as { total: number }).total,
    active_listings: (listings.results[0] as { total: number }).total,
    open_reports: (reports.results[0] as { total: number }).total,
    online_now: onlineCount,
  });
});

// ── POST /api/admin/announcements ────────────────────────────
admin.post('/announcements', async (c) => {
  const user = c.get('user')!;
  let body: { title?: string; content?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { title, content } = body;
  if (!title || !content) return badRequest('title and content required');
  if (title.length > 200) return badRequest('Title too long');

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO announcements (id, title, content, author_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).bind(id, title, content, user.id, nowTs, nowTs),
    // Also create as thread in announcements section
    c.env.DB.prepare(
      `INSERT INTO threads (id, title, content, author_id, section, vip_only, is_announcement, status, view_count, reply_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'announcements', 0, 1, 'active', 0, 0, ?, ?)`
    ).bind(generateUUID(), title, content, user.id, nowTs, nowTs),
    // Invalidate announcements cache
    c.env.DB.prepare('SELECT 1'), // Placeholder; cache invalidation via KV below
  ]);

  // Invalidate announcements cache
  await c.env.CACHE_KV.delete('announcements:active');

  return created({ id, title, created_at: nowTs });
});

export default admin;
