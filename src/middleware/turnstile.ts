import type { Context } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { badRequest, forbidden } from '../lib/response.js';
import { now } from '../lib/auth.js';

const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const EPHEMERAL_ID_BLOCK_THRESHOLD = 10; // Block after 10 suspicious actions

interface TurnstileResponse {
  success: boolean;
  'error-codes': string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  metadata?: {
    ephemeral_id?: string;
    interactive?: boolean;
  };
}

/**
 * Validate a Turnstile token from the request body.
 * Requires `cf-turnstile-response` in the JSON body.
 * Optionally checks Ephemeral ID fraud signals.
 */
export async function validateTurnstile(
  c: Context<{ Bindings: Env; Variables: ContextVariables }>,
  next: () => Promise<void>
): Promise<Response | void> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
    // Re-inject for downstream handlers
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });
  } catch {
    return badRequest('Invalid JSON body');
  }

  const token = body['cf-turnstile-response'] as string | undefined;
  if (!token || typeof token !== 'string') {
    return badRequest('Missing cf-turnstile-response token');
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

  const formData = new FormData();
  formData.append('secret', c.env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  formData.append('remoteip', ip);

  const tsRes = await fetch(TURNSTILE_SITEVERIFY_URL, {
    method: 'POST',
    body: formData,
  });

  if (!tsRes.ok) {
    console.error('[turnstile] siteverify HTTP error:', tsRes.status);
    return badRequest('Turnstile verification failed');
  }

  const tsData = (await tsRes.json()) as TurnstileResponse;

  if (!tsData.success) {
    console.warn('[turnstile] verification failed:', tsData['error-codes']);
    return forbidden('Turnstile challenge failed. Please try again.');
  }

  // ── Ephemeral ID Fraud Detection ──────────────────────────
  const ephemeralId = tsData.metadata?.ephemeral_id;
  if (ephemeralId) {
    const signal = await c.env.DB.prepare(
      'SELECT action_count, blocked FROM fraud_signals WHERE ephemeral_id = ?'
    )
      .bind(ephemeralId)
      .first<{ action_count: number; blocked: number }>();

    if (signal?.blocked) {
      return forbidden('Your request has been blocked due to suspicious activity.');
    }

    const nowTs = now();
    if (signal) {
      const newCount = signal.action_count + 1;
      const shouldBlock = newCount >= EPHEMERAL_ID_BLOCK_THRESHOLD ? 1 : 0;

      await c.env.DB.prepare(
        'UPDATE fraud_signals SET action_count = ?, last_ip = ?, last_seen = ?, blocked = ? WHERE ephemeral_id = ?'
      )
        .bind(newCount, ip, nowTs, shouldBlock, ephemeralId)
        .run();

      if (shouldBlock) {
        return forbidden('Your request has been blocked due to suspicious activity.');
      }
    } else {
      await c.env.DB.prepare(
        'INSERT INTO fraud_signals (ephemeral_id, action_count, last_ip, blocked, first_seen, last_seen) VALUES (?, 1, ?, 0, ?, ?)'
      )
        .bind(ephemeralId, ip, nowTs, nowTs)
        .run();
    }
  }

  return next();
}
