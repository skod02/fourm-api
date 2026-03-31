import type { Queue } from '@cloudflare/workers-types';
import type { WebhookMessage } from '../types.js';

/**
 * Enqueue a webhook for async delivery.
 * The queue consumer (in index.ts) handles retries.
 */
export async function enqueueWebhook(
  queue: Queue<WebhookMessage>,
  url: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  await queue.send({
    url,
    event,
    payload,
    attempt: 1,
  });
}

/**
 * Deliver a webhook immediately (used by the Queue consumer).
 * Retries are handled by the Queue's built-in retry mechanism.
 */
export async function deliverWebhook(
  message: WebhookMessage
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(message.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forum-Event': message.event,
      'X-Forum-Delivery': crypto.randomUUID(),
    },
    body: JSON.stringify({
      event: message.event,
      timestamp: Math.floor(Date.now() / 1000),
      data: message.payload,
    }),
    cf: {
      connectTimeout: 5000,
      readTimeout: 10000,
    } as RequestInit['cf'],
  });

  return { ok: res.ok, status: res.status };
}

/**
 * Build a standard webhook payload for key validation events.
 */
export function buildKeyValidationPayload(opts: {
  key: string;
  deviceId: string;
  ip: string;
  status: string;
  action: string;
}): Record<string, unknown> {
  return {
    key: opts.key,
    device_id: opts.deviceId,
    ip: opts.ip,
    status: opts.status,
    action: opts.action,
    ts: Math.floor(Date.now() / 1000),
  };
}
