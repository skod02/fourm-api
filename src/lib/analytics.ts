// ============================================================
// lib/analytics.ts — Workers Analytics Engine write helpers
// ============================================================
// Analytics Engine uses writeDataPoint() with blobs (strings),
// doubles (numbers), and an optional index (for fast filtering).
// See: https://developers.cloudflare.com/analytics/analytics-engine/
// ============================================================

import type { AnalyticsEngineDataset } from '@cloudflare/workers-types';

export type EventType =
  | 'key_validate'
  | 'key_bind'
  | 'user_signup'
  | 'user_login'
  | 'thread_view'
  | 'thread_create'
  | 'reply_create'
  | 'listing_view'
  | 'listing_create'
  | 'vip_request'
  | 'dmca_request'
  | 'api_error';

export interface AnalyticsEvent {
  event: EventType;
  userId?: string;
  targetId?: string;
  appId?: string;
  ip?: string;
  meta?: string;
  value?: number;
}

/**
 * Write a structured analytics event to Workers Analytics Engine.
 *
 * Blob layout:
 *   blobs[0] = event type
 *   blobs[1] = user_id (or 'anon')
 *   blobs[2] = target_id (key, thread, listing, etc.)
 *   blobs[3] = app_id
 *   blobs[4] = ip
 *   blobs[5] = meta (freeform)
 *
 * Double layout:
 *   doubles[0] = timestamp (unix seconds)
 *   doubles[1] = value (count, score, etc.)
 *
 * Index: event type (for fast GROUP BY filtering in SQL)
 */
export function writeAnalyticsEvent(
  engine: AnalyticsEngineDataset,
  event: AnalyticsEvent
): void {
  try {
    engine.writeDataPoint({
      blobs: [
        event.event,
        event.userId ?? 'anon',
        event.targetId ?? '',
        event.appId ?? '',
        event.ip ?? '',
        event.meta ?? '',
      ],
      doubles: [
        Math.floor(Date.now() / 1000),
        event.value ?? 1,
      ],
      indexes: [event.event],
    });
  } catch (err) {
    // Analytics writes must never crash the main request
    console.error('[analytics] write failed:', err);
  }
}

/**
 * Convenience: track a license key validation event.
 */
export function trackKeyValidation(
  engine: AnalyticsEngineDataset,
  opts: { keyId: string; appId: string; ip: string; status: string }
): void {
  writeAnalyticsEvent(engine, {
    event: 'key_validate',
    targetId: opts.keyId,
    appId: opts.appId,
    ip: opts.ip,
    meta: opts.status,
  });
}

/**
 * Convenience: track a thread view.
 */
export function trackThreadView(
  engine: AnalyticsEngineDataset,
  opts: { threadId: string; userId?: string; ip: string }
): void {
  writeAnalyticsEvent(engine, {
    event: 'thread_view',
    targetId: opts.threadId,
    userId: opts.userId,
    ip: opts.ip,
  });
}
