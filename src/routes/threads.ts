// ============================================================
// routes/threads.ts — Thread Board Routes
// GET    /api/threads
// GET    /api/threads/:uuid
// POST   /api/threads
// PATCH  /api/threads/:uuid
// DELETE /api/threads/:uuid
// GET    /api/threads/:uuid/replies
// POST   /api/threads/:uuid/replies
// DELETE /api/threads/:uuid/replies/:replyId
// POST   /api/threads/pong (online presence heartbeat)
// ============================================================

import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth, optionalSessionAuth, requireRole } from '../middleware/auth.js';
import { ok, created, notFound, badRequest, forbidden, unauthorized } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';
import { trackThreadView, writeAnalyticsEvent } from '../lib/analytics.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const threads = new Hono<HonoType>();

const VALID_SECTIONS = ['general', 'exploits', 'tools', 'ctf', 'disclosure', 'offtopic', 'announcements'];

// ── GET /api/threads ────────────────────────────────────────
threads.get('/', optionalSessionAuth, async (c) => {
  const user = c.get('user');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10));
  const offset = (page - 1) * limit;
  const section = c.req.query('section');
  const search = c.req.query('search');

  const isVipOrStaff = user && (user.is_vip || user.role === 'admin' || user.role === 'mod');

  let sql = `
    SELECT t.id, t.title, t.section, t.vip_only, t.is_announcement,
           t.status, t.view_count, t.reply_count, t.created_at,
           u.username as author_username, u.id as author_id, u.is_vip as author_is_vip,
           u.role as author_role
    FROM threads t
    JOIN users u ON t.author_id = u.id
    WHERE t.status = 'active'
  `;
  const binds: unknown[] = [];

  if (!isVipOrStaff) {
    sql += ' AND t.vip_only = 0';
  }
  if (section && VALID_SECTIONS.includes(section)) {
    sql += ' AND t.section = ?';
    binds.push(section);
  }
  if (search) {
    sql += ' AND (t.title LIKE ? OR t.content LIKE ?)';
    const q = `%${search.slice(0, 100)}%`;
    binds.push(q, q);
  }

  sql += ' ORDER BY t.is_announcement DESC, t.created_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  // Count total
  let countSql = `SELECT COUNT(*) as total FROM threads t WHERE t.status = 'active'`;
  const countBinds: unknown[] = [];
  if (!isVipOrStaff) countSql += ' AND t.vip_only = 0';
  if (section && VALID_SECTIONS.includes(section)) {
    countSql += ' AND t.section = ?'; countBinds.push(section);
  }
  const total = await c.env.DB.prepare(countSql).bind(...countBinds).first<{ total: number }>();

  return ok(rows.results, { page, limit, total: total?.total ?? 0 });
});

// ── GET /api/threads/:uuid ──────────────────────────────────
threads.get('/:uuid', optionalSessionAuth, async (c) => {
  const { uuid } = c.req.param();
  const user = c.get('user');

  const thread = await c.env.DB.prepare(
    `SELECT t.*, u.username as author_username, u.is_vip as author_is_vip, u.role as author_role
     FROM threads t JOIN users u ON t.author_id = u.id
     WHERE t.id = ? AND t.status != 'removed'`
  ).bind(uuid).first<Record<string, unknown>>();

  if (!thread) return notFound('Thread not found');

  // VIP gate
  if (thread.vip_only) {
    const allowed = user && (user.is_vip || user.role === 'admin' || user.role === 'mod');
    if (!allowed) return forbidden('This thread requires VIP membership');
  }

  // Increment view count (fire-and-forget)
  c.env.DB.prepare('UPDATE threads SET view_count = view_count + 1 WHERE id = ?')
    .bind(uuid).run().catch(() => {});

  // Analytics Engine track
  const ip = c.req.header('CF-Connecting-IP') ?? '';
  trackThreadView(c.env.ANALYTICS, { threadId: uuid, userId: user?.id, ip });

  return ok(thread);
});

// ── POST /api/threads ───────────────────────────────────────
threads.post('/', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;

  let body: { title?: string; content?: string; section?: string; vip_only?: boolean };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { title, content, section = 'general', vip_only = false } = body;

  if (!title || !content) return badRequest('title and content are required');
  if (title.length < 5 || title.length > 200) return badRequest('Title must be 5-200 characters');
  if (content.length < 20) return badRequest('Content too short (min 20 characters)');
  if (content.length > 50000) return badRequest('Content too long (max 50000 characters)');
  if (!VALID_SECTIONS.includes(section)) return badRequest(`Invalid section. Valid: ${VALID_SECTIONS.join(', ')}`);

  // VIP-only threads require VIP or staff
  if (vip_only && !user.is_vip && user.role === 'user') {
    return forbidden('Only VIP members can create VIP-gated threads');
  }

  // Announcements are admin-only
  const isAnnouncement = section === 'announcements';
  if (isAnnouncement && user.role !== 'admin') {
    return forbidden('Only admins can post announcements');
  }

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    `INSERT INTO threads (id, title, content, author_id, section, vip_only, is_announcement, status, view_count, reply_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?)`
  ).bind(id, title, content, user.id, section, vip_only ? 1 : 0, isAnnouncement ? 1 : 0, nowTs, nowTs).run();

  writeAnalyticsEvent(c.env.ANALYTICS, { event: 'thread_create', userId: user.id, targetId: id });

  return created({ id, title, section, created_at: nowTs });
});

// ── PATCH /api/threads/:uuid ────────────────────────────────
threads.patch('/:uuid', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const thread = await c.env.DB.prepare('SELECT * FROM threads WHERE id = ?')
    .bind(uuid).first<import('../types.js').Thread>();
  if (!thread) return notFound();

  const canEdit = thread.author_id === user.id || user.role === 'mod' || user.role === 'admin';
  if (!canEdit) return forbidden('You cannot edit this thread');

  let body: { title?: string; content?: string; status?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { title, content, status } = body;
  const nowTs = now();
  const updates: string[] = [];
  const binds: unknown[] = [];

  if (title) { updates.push('title = ?'); binds.push(title); }
  if (content) { updates.push('content = ?'); binds.push(content); }
  if (status && (user.role === 'mod' || user.role === 'admin')) {
    updates.push('status = ?'); binds.push(status);
  }
  if (updates.length === 0) return badRequest('No fields to update');

  updates.push('updated_at = ?');
  binds.push(nowTs, uuid);

  await c.env.DB.prepare(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds).run();

  return ok({ id: uuid, updated_at: nowTs });
});

// ── DELETE /api/threads/:uuid ───────────────────────────────
threads.delete('/:uuid', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const thread = await c.env.DB.prepare('SELECT author_id FROM threads WHERE id = ?')
    .bind(uuid).first<{ author_id: string }>();
  if (!thread) return notFound();

  const canDelete = thread.author_id === user.id || user.role === 'mod' || user.role === 'admin';
  if (!canDelete) return forbidden('You cannot delete this thread');

  await c.env.DB.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
    .bind('removed', now(), uuid).run();

  return ok({ id: uuid, status: 'removed' });
});

// ── GET /api/threads/:uuid/replies ──────────────────────────
threads.get('/:uuid/replies', optionalSessionAuth, async (c) => {
  const { uuid } = c.req.param();
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '50', 10));
  const offset = (page - 1) * limit;

  const thread = await c.env.DB.prepare('SELECT vip_only FROM threads WHERE id = ? AND status != ?')
    .bind(uuid, 'removed').first<{ vip_only: number }>();
  if (!thread) return notFound('Thread not found');

  const user = c.get('user');
  if (thread.vip_only && !user?.is_vip && user?.role !== 'admin' && user?.role !== 'mod') {
    return forbidden('VIP required');
  }

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.content, r.status, r.created_at, r.updated_at,
            u.id as author_id, u.username as author_username, u.role as author_role, u.is_vip as author_is_vip
     FROM replies r JOIN users u ON r.author_id = u.id
     WHERE r.thread_id = ? AND r.status = 'active'
     ORDER BY r.created_at ASC LIMIT ? OFFSET ?`
  ).bind(uuid, limit, offset).all();

  return ok(rows.results, { page, limit });
});

// ── POST /api/threads/:uuid/replies ─────────────────────────
threads.post('/:uuid/replies', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  let body: { content?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { content } = body;
  if (!content || content.length < 2) return badRequest('Content too short');
  if (content.length > 20000) return badRequest('Content too long');

  const thread = await c.env.DB.prepare('SELECT id, vip_only, status FROM threads WHERE id = ?')
    .bind(uuid).first<{ id: string; vip_only: number; status: string }>();
  if (!thread) return notFound('Thread not found');
  if (thread.status === 'removed') return notFound('Thread not found');
  if (thread.status === 'locked' && user.role === 'user') return forbidden('Thread is locked');

  if (thread.vip_only && !user.is_vip && user.role !== 'admin' && user.role !== 'mod') {
    return forbidden('VIP required to reply to this thread');
  }

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO replies (id, thread_id, author_id, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, uuid, user.id, content, nowTs, nowTs),
    c.env.DB.prepare('UPDATE threads SET reply_count = reply_count + 1, updated_at = ? WHERE id = ?')
      .bind(nowTs, uuid),
  ]);

  writeAnalyticsEvent(c.env.ANALYTICS, { event: 'reply_create', userId: user.id, targetId: uuid });

  return created({ id, thread_id: uuid, created_at: nowTs });
});

// ── DELETE /api/threads/:uuid/replies/:replyId ──────────────
threads.delete('/:uuid/replies/:replyId', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid, replyId } = c.req.param();

  const reply = await c.env.DB.prepare('SELECT author_id FROM replies WHERE id = ? AND thread_id = ?')
    .bind(replyId, uuid).first<{ author_id: string }>();
  if (!reply) return notFound('Reply not found');

  const canDelete = reply.author_id === user.id || user.role === 'mod' || user.role === 'admin';
  if (!canDelete) return forbidden('You cannot delete this reply');

  await c.env.DB.prepare('UPDATE replies SET status = ?, updated_at = ? WHERE id = ?')
    .bind('removed', now(), replyId).run();

  return ok({ id: replyId, status: 'removed' });
});

// ── POST /api/threads/pong ──────────────────────────────────
// Online presence heartbeat endpoint
threads.post('/pong', optionalSessionAuth, async (c) => {
  const user = c.get('user');
  const userId = user?.id ?? `anon-${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;

  try {
    const trackerId = c.env.ONLINE_TRACKER.idFromName('global');
    const stub = c.env.ONLINE_TRACKER.get(trackerId);
    await stub.fetch(new Request(`https://do/pong?userId=${encodeURIComponent(userId)}`));
  } catch (e) {
    console.error('[pong] online tracker error:', e);
  }

  return ok({ ok: true });
});

export default threads;
