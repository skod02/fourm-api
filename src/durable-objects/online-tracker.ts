import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.js';

const PRESENCE_TTL_MS = 30_000;  // 30 seconds
const CLEANUP_INTERVAL_MS = 15_000;

export class OnlineTracker extends DurableObject<Env> {
  private state: DurableObjectState;
  private presence: Map<string, number> = new Map(); // userId → lastSeen timestamp
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  private async loadPresence(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<[string, number][]>('presence');
    if (stored) {
      this.presence = new Map(stored);
    }
    this.loaded = true;
  }

  private async savePresence(): Promise<void> {
    await this.state.storage.put('presence', [...this.presence.entries()]);
  }

  /**
   * Record presence for a user (called on heartbeat/pong).
   */
  async pong(userId: string): Promise<void> {
    await this.loadPresence();
    this.presence.set(userId, Date.now());
    await this.savePresence();
    // Set alarm to clean up stale entries
    await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }

  /**
   * Get current online user count.
   */
  async getCount(): Promise<number> {
    await this.loadPresence();
    const threshold = Date.now() - PRESENCE_TTL_MS;
    let count = 0;
    for (const ts of this.presence.values()) {
      if (ts > threshold) count++;
    }
    return count;
  }

  /**
   * Cleanup alarm — remove stale presence entries.
   */
  async alarm(): Promise<void> {
    await this.loadPresence();
    const threshold = Date.now() - PRESENCE_TTL_MS;
    for (const [userId, ts] of this.presence.entries()) {
      if (ts <= threshold) {
        this.presence.delete(userId);
      }
    }
    await this.savePresence();
    // Schedule next cleanup if there are still users
    if (this.presence.size > 0) {
      await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();

    if (action === 'pong') {
      const userId = url.searchParams.get('userId') ?? 'anon';
      await this.pong(userId);
      return Response.json({ ok: true });
    }

    if (action === 'count') {
      const count = await this.getCount();
      return Response.json({ count });
    }

    return new Response('Not found', { status: 404 });
  }
}
