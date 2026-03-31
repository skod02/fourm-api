import { Hono } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { sessionAuth } from '../middleware/auth.js';
import { ok, created, badRequest } from '../lib/response.js';
import { generateUUID, now } from '../lib/auth.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const reports = new Hono<HonoType>();

const VALID_TARGET_TYPES = ['thread', 'reply', 'listing', 'user'];

// ── POST /api/reports ───────────────────────────────────────
reports.post('/', sessionAuth, async (c) => {
  const user = c.get('user')!;

  let body: { target_type?: string; target_id?: string; reason?: string };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { target_type, target_id, reason } = body;
  if (!target_type || !target_id || !reason) return badRequest('target_type, target_id, and reason are required');
  if (!VALID_TARGET_TYPES.includes(target_type)) return badRequest('Invalid target_type');
  if (reason.length < 10) return badRequest('Please provide a detailed reason');
  if (reason.length > 1000) return badRequest('Reason too long');

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).bind(id, user.id, target_type, target_id, reason, nowTs, nowTs).run();

  return created({
    id,
    message: 'Report submitted. Moderation team will review it.',
  });
});

// ── POST /api/dmca ──────────────────────────────────────────
reports.post('/dmca', async (c) => {
  let body: {
    requester_name?: string;
    requester_email?: string;
    target_type?: string;
    target_id?: string;
    description?: string;
  };
  try { body = await c.req.json(); } catch { return badRequest('Invalid JSON'); }

  const { requester_name, requester_email, target_type, target_id, description } = body;

  if (!requester_name || !requester_email || !target_type || !target_id || !description) {
    return badRequest('All fields are required: requester_name, requester_email, target_type, target_id, description');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requester_email)) return badRequest('Invalid email');
  if (!['thread', 'listing'].includes(target_type)) return badRequest('target_type must be: thread | listing');
  if (description.length < 50) return badRequest('Please provide a detailed description (min 50 chars)');
  if (description.length > 5000) return badRequest('Description too long');

  const id = generateUUID();
  const nowTs = now();

  await c.env.DB.prepare(
    `INSERT INTO dmca_requests (id, requester_name, requester_email, target_type, target_id, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, requester_name, requester_email, target_type, target_id, description, nowTs, nowTs).run();

  // Trigger DMCA takedown workflow
  try {
    const instance = await c.env.DMCA_TAKEDOWN_WORKFLOW.create({
      params: {
        dmcaId: id,
        targetType: target_type as 'thread' | 'listing',
        targetId: target_id,
        requesterEmail: requester_email,
        requesterName: requester_name,
      },
    });

    await c.env.DB.prepare('UPDATE dmca_requests SET workflow_instance_id = ? WHERE id = ?')
      .bind(instance.id, id).run();
  } catch (e) {
    console.error('[dmca] workflow trigger failed:', e);
  }

  return created({
    id,
    message: 'DMCA request received. Content has been temporarily locked pending review within 48 hours.',
  });
});

export default reports;
