// ============================================================
// durable-objects/rate-limiter.ts
// Per-IP sliding window rate limiter using Durable Objects.
// Uses Hibernation API for cost efficiency.
// ============================================================

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.js';

interface RateLimitState {
  requests: number[];  // Array of unix timestamps for this window
}

export class RateLimiter extends DurableObject<Env> {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  /**
   * Check if the caller is within rate limits.
   * Uses a sliding window algorithm.
   * @param windowSeconds - Window size in seconds (e.g., 60)
   * @param maxRequests - Max requests within the window
   */
  async check(
    windowSeconds: number,
    maxRequests: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const nowMs = Date.now();
    const windowStart = nowMs - windowSeconds * 1000;

    const stored = (await this.state.storage.get<number[]>('requests')) ?? [];
    const filtered = stored.filter((ts) => ts > windowStart);

    const allowed = filtered.length < maxRequests;
    const remaining = Math.max(0, maxRequests - filtered.length - (allowed ? 1 : 0));
    const resetAt = filtered.length > 0
      ? Math.ceil((filtered[0] + windowSeconds * 1000) / 1000)
      : Math.ceil((nowMs + windowSeconds * 1000) / 1000);

    if (allowed) {
      filtered.push(nowMs);
      await this.state.storage.put('requests', filtered);

      // Schedule alarm to clean up storage after window expires
      await this.state.storage.setAlarm(nowMs + windowSeconds * 1000 + 1000);
    }

    return { allowed, remaining, resetAt };
  }

  /** Clean up expired entries on alarm */
  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const stored = (await this.state.storage.get<number[]>('requests')) ?? [];
    // Keep last 5 min of data max
    const filtered = stored.filter((ts) => ts > nowMs - 300_000);
    if (filtered.length === 0) {
      await this.state.storage.deleteAll();
    } else {
      await this.state.storage.put('requests', filtered);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const window = parseInt(url.searchParams.get('window') ?? '60', 10);
    const max = parseInt(url.searchParams.get('max') ?? '30', 10);

    const result = await this.check(window, max);
    return Response.json(result);
  }
}
