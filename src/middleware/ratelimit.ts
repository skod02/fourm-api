import type { Context, Next } from 'hono';
import type { Env, ContextVariables } from '../types.js';
import { rateLimit } from '../lib/response.js';

interface RateLimitConfig {
  window: number;    // seconds
  max: number;       // max requests per window
}

const DEFAULTS: RateLimitConfig = { window: 60, max: 60 };

// Strict limits for auth endpoints
export const AUTH_LIMIT: RateLimitConfig = { window: 60, max: 5 };

// Standard API limits
export const API_LIMIT: RateLimitConfig = { window: 60, max: 60 };

// External API limits (higher throughput for tools)
export const EXT_LIMIT: RateLimitConfig = { window: 60, max: 120 };

/**
 * Create a rate limit middleware with custom config.
 */
export function rateLimitMiddleware(config: RateLimitConfig = DEFAULTS) {
  return async (
    c: Context<{ Bindings: Env; Variables: ContextVariables }>,
    next: Next
  ): Promise<Response | void> => {
    const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

    // Use CF Bot Management score to skip rate limiting for trusted bots
    // cf.botManagement.score > 90 = likely human
    const cfData = (c.req.raw as Request).cf;
    if (cfData && (cfData as Record<string, unknown>).botManagement) {
      const bm = (cfData as Record<string, unknown>).botManagement as Record<string, unknown>;
      if (typeof bm.score === 'number' && bm.score < 30) {
        // Very likely a bot — strict limit
        return rateLimit('Bot traffic is rate limited');
      }
    }

    try {
      // One DO per IP (named by IP string)
      const id = c.env.RATE_LIMITER.idFromName(`ip:${ip}`);
      const stub = c.env.RATE_LIMITER.get(id);

      const res = await stub.fetch(
        new Request(
          `https://do/check?window=${config.window}&max=${config.max}`
        )
      );
      const result = await res.json<{ allowed: boolean; remaining: number; resetAt: number }>();

      c.res.headers.set('X-RateLimit-Limit', String(config.max));
      c.res.headers.set('X-RateLimit-Remaining', String(result.remaining));
      c.res.headers.set('X-RateLimit-Reset', String(result.resetAt));

      if (!result.allowed) {
        return rateLimit(`Rate limit exceeded. Try again after ${new Date(result.resetAt * 1000).toISOString()}`);
      }
    } catch (e) {
      // If rate limiter fails, fail open (allow request) but log
      console.error('[ratelimit] DO error:', e);
    }

    return next();
  };
}
