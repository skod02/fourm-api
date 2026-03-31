// ============================================================
// routes/ext.ts — External Developer Licensing API
//
// All routes authenticated via X-API-Secret header.
// This is what external tools embed for license key validation.
//
// POST /api/ext/validate           — Validate key + HWID
// GET  /api/ext/announcements      — Active announcements for tools
// POST /api/ext/announcements      — Create announcement (admin)
// GET  /api/ext/stats              — Platform stats
// GET  /api/ext/keys/summary       — Key counts by status
// GET  /api/ext/users              — User list
// GET  /api/ext/activity           — Recent activity feed
// POST /api/ext/keys               — Create a license key
// DELETE /api/ext/keys/:key        — Revoke a key
// ============================================================

import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { apiSecretAuth } from '../middleware/auth.js';
import { ok, created, notFound, badRequest, forbidden } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';
import { generateLicenseKey, validateHwid, validateKeyFormat, parseDeviceIds } from '../lib/keys.js';
import { trackKeyValidation, writeAnalyticsEvent } from '../lib/analytics.js';
import { enqueueWebhook, buildKeyValidationPayload } from '../lib/webhook.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const ext = new Hono<HonoType>();

// All ext routes require API secret auth
ext.use('*', apiSecretAuth);

// ── POST /api/ext/validate ──────────────────────────────────
// This is the core licensing validation endpoint.
// External tools call this on startup to verify their users' keys.
ext.post('/validate', async (c) => {
  const appId = c.get('appId')!;
  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

  let body: { key?: string; device_id?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { key, device_id: deviceId } = body;

  if (!key || !deviceId) return badRequest('key and device_id are required');
  if (!validateKeyFormat(key)) return badRequest('Invalid key format');
  if (!validateHwid(deviceId)) return badRequest('Invalid device_id format (must be 32-char hex)');

  const licenseKey = await c.env.DB.prepare(
    'SELECT * FROM license_keys WHERE key = ? AND app_id = ?'
  ).bind(key, appId).first<import('../types.js').LicenseKey>();

  if (!licenseKey) {
    trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'not_found' });
    return ok({ status: 'invalid', message: 'Key not found' });
  }

  const nowTs = now();

  // Check expiry
  if (licenseKey.expires_at && licenseKey.expires_at < nowTs) {
    await c.env.DB.prepare('UPDATE license_keys SET status = ? WHERE key = ?')
      .bind('expired', key).run();
    trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'expired' });
    return ok({ status: 'expired', message: 'Key has expired' });
  }

  // Check status
  if (licenseKey.status === 'banned') {
    trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'banned' });
    return ok({ status: 'banned', message: 'Key has been banned' });
  }

  if (licenseKey.status === 'maxed') {
    trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'maxed' });
    return ok({ status: 'maxed', message: 'Key has reached maximum device limit' });
  }

  // HWID binding
  const deviceIds = parseDeviceIds(licenseKey.device_ids);
  let action = 'validate';

  if (!deviceIds.includes(deviceId)) {
    if (deviceIds.length >= licenseKey.max_devices) {
      // Key is now maxed
      await c.env.DB.prepare('UPDATE license_keys SET status = ?, updated_at = ? WHERE key = ?')
        .bind('maxed', nowTs, key).run();
      trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'maxed' });
      return ok({ status: 'maxed', message: 'Key has reached maximum device limit. Contact support.' });
    }

    // Bind new device
    deviceIds.push(deviceId);
    action = 'bind';

    await c.env.DB.prepare(
      `UPDATE license_keys SET device_ids = ?, usage_count = usage_count + 1,
       last_used_at = ?, last_ip = ?, updated_at = ? WHERE key = ?`
    ).bind(JSON.stringify(deviceIds), nowTs, ip, nowTs, key).run();
  } else {
    // Known device — update usage
    await c.env.DB.prepare(
      'UPDATE license_keys SET usage_count = usage_count + 1, last_used_at = ?, last_ip = ?, updated_at = ? WHERE key = ?'
    ).bind(nowTs, ip, nowTs, key).run();
  }

  // Log usage
  await c.env.DB.prepare(
    'INSERT INTO key_usage_logs (key_id, device_id, ip, action, ts) VALUES (?, ?, ?, ?, ?)'
  ).bind(key, deviceId, ip, action, nowTs).run();

  // Track in Analytics Engine
  trackKeyValidation(c.env.ANALYTICS, { keyId: key, appId, ip, status: 'ok' });

  // Enqueue webhook to app's webhook_url
  const app = await c.env.DB.prepare('SELECT webhook_url FROM apps WHERE id = ?')
    .bind(appId).first<{ webhook_url: string | null }>();

  if (app?.webhook_url) {
    try {
      await enqueueWebhook(
        c.env.WEBHOOK_QUEUE,
        app.webhook_url,
        'key.validated',
        buildKeyValidationPayload({ key, deviceId, ip, status: 'ok', action })
      );
    } catch (e) {
      console.error('[ext/validate] webhook enqueue failed:', e);
    }
  }

  return ok({
    status: 'ok',
    action,
    key,
    expires_at: licenseKey.expires_at,
    devices_used: deviceIds.length,
    max_devices: licenseKey.max_devices,
  });
});

// ── GET /api/ext/announcements ──────────────────────────────
ext.get('/announcements', async (c) => {
  // Check KV cache first
  const cached = await c.env.CACHE_KV.get('announcements:active', 'json');
  if (cached) {
    return ok(cached);
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, title, content, created_at
     FROM announcements WHERE active = 1
     ORDER BY created_at DESC LIMIT 20`
  ).all();

  // Cache for 5 minutes
  await c.env.CACHE_KV.put('announcements:active', JSON.stringify(rows.results), {
    expirationTtl: 300,
  });

  return ok(rows.results);
});

// ── POST /api/ext/announcements ─────────────────────────────
ext.post('/announcements', async (c) => {
  let body: { title?: string; content?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { title, content } = body;
  if (!title || !content) return badRequest('title and content required');

  const id = generateUUID();
  const nowTs = now();

  // Find admin user for this app
  const app = await c.env.DB.prepare('SELECT owner_id FROM apps WHERE id = ?')
    .bind(c.get('appId')!).first<{ owner_id: string }>();

  if (!app) return notFound('App not found');

  await c.env.DB.prepare(
    `INSERT INTO announcements (id, title, content, author_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, title, content, app.owner_id, nowTs, nowTs).run();

  // Invalidate cache
  await c.env.CACHE_KV.delete('announcements:active');

  return created({ id, title, created_at: nowTs });
});

// ── GET /api/ext/stats ──────────────────────────────────────
ext.get('/stats', async (c) => {
  const cacheKey = `ext:stats:${c.get('appId')}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, 'json');
  if (cached) return ok(cached);

  const [usersRow, threadsRow, keysRow] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM users'),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM threads WHERE status = 'active'"),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM license_keys WHERE app_id = ?")
      .bind(c.get('appId')!),
  ]);

  let onlineCount = 0;
  try {
    const trackerId = c.env.ONLINE_TRACKER.idFromName('global');
    const stub = c.env.ONLINE_TRACKER.get(trackerId);
    const res = await stub.fetch(new Request('https://do/count'));
    const data = await res.json<{ count: number }>();
    onlineCount = data.count;
  } catch {}

  const stats = {
    total_users: (usersRow.results[0] as { total: number }).total,
    total_threads: (threadsRow.results[0] as { total: number }).total,
    total_keys: (keysRow.results[0] as { total: number }).total,
    online_now: onlineCount,
    ts: Math.floor(Date.now() / 1000),
  };

  await c.env.CACHE_KV.put(cacheKey, JSON.stringify(stats), { expirationTtl: 30 });
  return ok(stats);
});

// ── GET /api/ext/keys/summary ────────────────────────────────
ext.get('/keys/summary', async (c) => {
  const appId = c.get('appId')!;

  const [byStatus, recentUsage] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT status, COUNT(*) as count FROM license_keys WHERE app_id = ? GROUP BY status'
    ).bind(appId),
    c.env.DB.prepare(
      `SELECT l.key_id, l.device_id, l.ip, l.action, l.ts
       FROM key_usage_logs l
       JOIN license_keys k ON l.key_id = k.key
       WHERE k.app_id = ?
       ORDER BY l.ts DESC LIMIT 20`
    ).bind(appId),
  ]);

  return ok({
    by_status: byStatus.results,
    recent_usage: recentUsage.results,
  });
});

// ── GET /api/ext/users ───────────────────────────────────────
ext.get('/users', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '50', 10));
  const offset = (page - 1) * limit;

  const rows = await c.env.DB.prepare(
    `SELECT id, username, role, is_vip, is_banned, reputation, created_at
     FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const total = await c.env.DB.prepare('SELECT COUNT(*) as total FROM users')
    .first<{ total: number }>();

  return ok(rows.results, { page, limit, total: total?.total ?? 0 });
});

// ── GET /api/ext/activity ────────────────────────────────────
ext.get('/activity', async (c) => {
  const cacheKey = 'ext:activity';
  const cached = await c.env.CACHE_KV.get(cacheKey, 'json');
  if (cached) return ok(cached);

  const [threads, listings] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT t.id, t.title, t.section, t.created_at, u.username as author
       FROM threads t JOIN users u ON t.author_id = u.id
       WHERE t.status = 'active' ORDER BY t.created_at DESC LIMIT 10`
    ),
    c.env.DB.prepare(
      `SELECT l.id, l.title, l.category, l.created_at, u.username as seller
       FROM listings l JOIN users u ON l.seller_id = u.id
       WHERE l.status = 'active' ORDER BY l.created_at DESC LIMIT 10`
    ),
  ]);

  const activity = {
    recent_threads: threads.results,
    recent_listings: listings.results,
    ts: Math.floor(Date.now() / 1000),
  };

  await c.env.CACHE_KV.put(cacheKey, JSON.stringify(activity), { expirationTtl: 60 });
  return ok(activity);
});

// ── POST /api/ext/keys ───────────────────────────────────────
ext.post('/keys', async (c) => {
  const appId = c.get('appId')!;

  let body: { max_devices?: number; expires_in_days?: number };
  try { body = await c.req.json(); } catch { body = {}; }

  const maxDevices = Math.min(10, Math.max(1, body.max_devices ?? 1));
  const nowTs = now();
  let expiresAt: number | null = null;

  if (body.expires_in_days && body.expires_in_days > 0) {
    expiresAt = nowTs + body.expires_in_days * 86400;
  }

  const key = generateLicenseKey();

  await c.env.DB.prepare(
    `INSERT INTO license_keys (key, app_id, status, max_devices, device_ids, usage_count, expires_at, created_at)
     VALUES (?, ?, 'valid', ?, '[]', 0, ?, ?)`
  ).bind(key, appId, maxDevices, expiresAt, nowTs).run();

  writeAnalyticsEvent(c.env.ANALYTICS, { event: 'key_bind', targetId: key, appId });

  return created({ key, max_devices: maxDevices, expires_at: expiresAt });
});

// ── DELETE /api/ext/keys/:key ────────────────────────────────
ext.delete('/keys/:key', async (c) => {
  const appId = c.get('appId')!;
  const { key } = c.req.param();

  const existing = await c.env.DB.prepare(
    'SELECT key FROM license_keys WHERE key = ? AND app_id = ?'
  ).bind(key, appId).first();
  if (!existing) return notFound('Key not found');

  await c.env.DB.prepare('UPDATE license_keys SET status = ? WHERE key = ? AND app_id = ?')
    .bind('banned', key, appId).run();

  return ok({ key, status: 'banned' });
});

export default ext;
