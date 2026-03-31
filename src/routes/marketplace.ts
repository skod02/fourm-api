// ============================================================
// routes/marketplace.ts — Marketplace Listing Routes
// GET    /api/listings
// GET    /api/listings/:uuid
// POST   /api/listings
// PATCH  /api/listings/:uuid
// PATCH  /api/listings/:uuid/status (admin)
// DELETE /api/listings/:uuid
// ============================================================

import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth, optionalSessionAuth, requireRole, requireVip } from '../middleware/auth.js';
import { ok, created, notFound, badRequest, forbidden } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';
import { writeAnalyticsEvent } from '../lib/analytics.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const marketplace = new Hono<HonoType>();

const VALID_CATEGORIES = ['tools', 'exploits', 'services', 'courses', 'configs', 'other'];

// ── GET /api/listings ───────────────────────────────────────
marketplace.get('/', optionalSessionAuth, async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10));
  const offset = (page - 1) * limit;
  const category = c.req.query('category');
  const search = c.req.query('search');

  let sql = `
    SELECT l.id, l.title, l.description, l.category, l.status, l.vip_required,
           l.price, l.created_at,
           u.id as seller_id, u.username as seller_username, u.is_vip as seller_is_vip
    FROM listings l JOIN users u ON l.seller_id = u.id
    WHERE l.status = 'active'
  `;
  const binds: unknown[] = [];

  if (category && VALID_CATEGORIES.includes(category)) {
    sql += ' AND l.category = ?'; binds.push(category);
  }
  if (search) {
    sql += ' AND (l.title LIKE ? OR l.description LIKE ?)';
    const q = `%${search.slice(0, 100)}%`;
    binds.push(q, q);
  }

  sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM listings WHERE status = 'active'`
  ).first<{ total: number }>();

  return ok(rows.results, { page, limit, total: total?.total ?? 0 });
});

// ── GET /api/listings/:uuid ─────────────────────────────────
marketplace.get('/:uuid', optionalSessionAuth, async (c) => {
  const { uuid } = c.req.param();
  const user = c.get('user');

  const listing = await c.env.DB.prepare(
    `SELECT l.*, u.username as seller_username, u.is_vip as seller_is_vip
     FROM listings l JOIN users u ON l.seller_id = u.id
     WHERE l.id = ? AND l.status != 'removed'`
  ).bind(uuid).first<Record<string, unknown>>();

  if (!listing) return notFound('Listing not found');

  // VIP-required gate: VIP members skip download gate
  const isVipOrStaff = user && (user.is_vip || user.role === 'admin' || user.role === 'mod');
  const downloadUrl = (listing.vip_required && !isVipOrStaff) ? null : listing.download_url;

  writeAnalyticsEvent(c.env.ANALYTICS, { event: 'listing_view', targetId: uuid, userId: user?.id });

  return ok({ ...listing, download_url: downloadUrl });
});

// ── POST /api/listings ──────────────────────────────────────
marketplace.post('/', sessionAuth, requireVip, async (c) => {
  const user = c.get('user')!;

  let body: {
    title?: string; description?: string; category?: string;
    vip_required?: boolean; price?: number; download_url?: string;
  };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { title, description, category = 'other', vip_required = false, price, download_url } = body;

  if (!title || !description) return badRequest('title and description are required');
  if (title.length > 200) return badRequest('Title too long');
  if (description.length < 20) return badRequest('Description too short');
  if (description.length > 10000) return badRequest('Description too long');
  if (!VALID_CATEGORIES.includes(category)) return badRequest('Invalid category');
  if (price !== undefined && (typeof price !== 'number' || price < 0)) return badRequest('Invalid price');

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    `INSERT INTO listings (id, title, description, seller_id, category, status, vip_required, price, download_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).bind(id, title, description, user.id, category, vip_required ? 1 : 0, price ?? null, download_url ?? null, nowTs, nowTs).run();

  writeAnalyticsEvent(c.env.ANALYTICS, { event: 'listing_create', userId: user.id, targetId: id });

  return created({
    id,
    status: 'pending',
    message: 'Listing submitted for review. It will be visible once approved by moderation.',
  });
});

// ── PATCH /api/listings/:uuid ────────────────────────────────
marketplace.patch('/:uuid', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const listing = await c.env.DB.prepare('SELECT seller_id, status FROM listings WHERE id = ?')
    .bind(uuid).first<{ seller_id: string; status: string }>();
  if (!listing) return notFound();

  const canEdit = listing.seller_id === user.id || user.role === 'admin';
  if (!canEdit) return forbidden('You cannot edit this listing');
  if (listing.status === 'removed') return forbidden('Removed listings cannot be edited');

  let body: { title?: string; description?: string; price?: number; download_url?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.title) { updates.push('title = ?'); binds.push(body.title); }
  if (body.description) { updates.push('description = ?'); binds.push(body.description); }
  if (body.price !== undefined) { updates.push('price = ?'); binds.push(body.price); }
  if (body.download_url !== undefined) { updates.push('download_url = ?'); binds.push(body.download_url); }

  if (updates.length === 0) return badRequest('No fields to update');

  updates.push('updated_at = ?');
  binds.push(now(), uuid);

  await c.env.DB.prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds).run();

  return ok({ id: uuid, updated: true });
});

// ── PATCH /api/listings/:uuid/status (Admin) ─────────────────
marketplace.patch('/:uuid/status', sessionAuth, requireRole('mod'), async (c) => {
  const { uuid } = c.req.param();

  let body: { status?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { status } = body;
  if (!status || !['active', 'pending', 'removed'].includes(status)) {
    return badRequest('status must be: active | pending | removed');
  }

  const listing = await c.env.DB.prepare('SELECT id FROM listings WHERE id = ?')
    .bind(uuid).first<{ id: string }>();
  if (!listing) return notFound();

  await c.env.DB.prepare('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, now(), uuid).run();

  return ok({ id: uuid, status });
});

// ── DELETE /api/listings/:uuid ───────────────────────────────
marketplace.delete('/:uuid', sessionAuth, requireRole('user'), async (c) => {
  const user = c.get('user')!;
  const { uuid } = c.req.param();

  const listing = await c.env.DB.prepare('SELECT seller_id FROM listings WHERE id = ?')
    .bind(uuid).first<{ seller_id: string }>();
  if (!listing) return notFound();

  const canDelete = listing.seller_id === user.id || user.role === 'admin';
  if (!canDelete) return forbidden('Cannot delete this listing');

  await c.env.DB.prepare('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')
    .bind('removed', now(), uuid).run();

  return ok({ id: uuid, status: 'removed' });
});

export default marketplace;
