import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth } from '../middleware/auth.js';
import { ok, created, notFound, badRequest, forbidden } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const messages = new Hono<HonoType>();

// ── GET /api/messages ───────────────────────────────────────
messages.get('/', sessionAuth, async (c) => {
  const user = c.get('user')!;
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10));
  const offset = (page - 1) * limit;
  const folder = c.req.query('folder') ?? 'inbox'; // inbox | sent

  let sql: string;
  if (folder === 'sent') {
    sql = `
      SELECT m.id, m.content, m.read_at, m.created_at,
             u.id as other_id, u.username as other_username
      FROM messages m JOIN users u ON m.to_id = u.id
      WHERE m.from_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `;
  } else {
    sql = `
      SELECT m.id, m.content, m.read_at, m.created_at,
             u.id as other_id, u.username as other_username
      FROM messages m JOIN users u ON m.from_id = u.id
      WHERE m.to_id = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `;
  }

  const rows = await c.env.DB.prepare(sql).bind(user.id, limit, offset).all();

  if (rows.results.length === 0 && page === 1) {
    return ok([], { page, limit, total: 0 });
  }

  return ok(rows.results, { page, limit });
});

// ── POST /api/messages ──────────────────────────────────────
messages.post('/', sessionAuth, async (c) => {
  const user = c.get('user')!;

  let body: { to_username?: string; content?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { to_username, content } = body;
  if (!to_username || !content) return badRequest('to_username and content required');
  if (content.length < 1) return badRequest('Content too short');
  if (content.length > 5000) return badRequest('Content too long');

  const recipient = await c.env.DB.prepare(
    'SELECT id, is_banned FROM users WHERE username = ?'
  ).bind(to_username.toLowerCase()).first<{ id: string; is_banned: number }>();

  if (!recipient) return notFound('User not found');
  if (recipient.id === user.id) return badRequest('Cannot message yourself');
  if (recipient.is_banned) return badRequest('Cannot message banned users');

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    'INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, user.id, recipient.id, content, nowTs).run();

  return created({ id, to: to_username, created_at: nowTs });
});

// ── GET /api/messages/:uuid ─────────────────────────────────
messages.get('/:uuid', sessionAuth, async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const msg = await c.env.DB.prepare(
    `SELECT m.*, f.username as from_username, t.username as to_username
     FROM messages m
     JOIN users f ON m.from_id = f.id
     JOIN users t ON m.to_id = t.id
     WHERE m.id = ?`
  ).bind(uuid).first<Record<string, unknown>>();

  if (!msg) return notFound();
  if (msg.from_id !== user.id && msg.to_id !== user.id) return forbidden();

  // Auto-mark as read if recipient
  if (msg.to_id === user.id && !msg.read_at) {
    await c.env.DB.prepare('UPDATE messages SET read_at = ? WHERE id = ?')
      .bind(now(), uuid).run();
  }

  return ok(msg);
});

// ── POST /api/messages/:uuid/read ───────────────────────────
messages.post('/:uuid/read', sessionAuth, async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const msg = await c.env.DB.prepare('SELECT to_id FROM messages WHERE id = ?')
    .bind(uuid).first<{ to_id: string }>();

  if (!msg) return notFound();
  if (msg.to_id !== user.id) return forbidden();

  await c.env.DB.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .bind(now(), uuid).run();

  return ok({ id: uuid, read: true });
});

// ── DELETE /api/messages/:uuid ───────────────────────────────
messages.delete('/:uuid', sessionAuth, async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const msg = await c.env.DB.prepare('SELECT from_id, to_id FROM messages WHERE id = ?')
    .bind(uuid).first<{ from_id: string; to_id: string }>();

  if (!msg) return notFound();
  if (msg.from_id !== user.id && msg.to_id !== user.id) return forbidden();

  await c.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(uuid).run();
  return ok({ id: uuid, deleted: true });
});

export default messages;
