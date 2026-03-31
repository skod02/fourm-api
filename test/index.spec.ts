import { expect, test, describe } from 'vitest';
import { SELF } from 'cloudflare:test';

// ── Test Environment Settings ────────────────────────────────
// The tests run against the Cloudflare Workers runtime
// provided by @cloudflare/vitest-pool-workers.
// ─────────────────────────────────────────────────────────────

describe('Forum API Core functionality', () => {
  test('Health check endpoint returns 200 OK', async () => {
    // Send request via SELF binding which bypasses the network stack
    // and sends it directly to the Worker's fetch handler.
    const response = await SELF.fetch('https://fakeag.com/health');

    expect(response.status).toBe(200);
    
    const body = await response.json<{ status: string; version: string; ts: number; requestId: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.0.0');
    expect(body.ts).toBeGreaterThan(0);
    expect(body.requestId).toBeDefined();
  });

  // Note: Full integration tests for endpoints like \`/api/auth/register\` require
  // mocking Turnstile validation and setting up the D1 database fixture within
  // the vitest environment.
});
