// ============================================================
// middleware/auth.ts — Session + API Secret authentication
// ============================================================

import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import type { Env, ContextVariables, User } from '../types.js';
import { hashToken, constantTimeEqual, now } from '../lib/auth.js';
import { unauthorized, forbidden } from '../lib/response.js';

type HonoType = { Bindings: Env; Variables: ContextVariables };

const SESSION_KV_TTL = 30 * 24 * 60 * 60; // 30 days
const SESSION_KV_PREFIX = 'session:';

/**
 * Validate session token from Authorization: Bearer <token> header.
 * Looks up session in KV cache first, falls back to D1.
 * Attaches user to c.var.user on success.
 */
export async function sessionAuth(
  c: Context<HonoType>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized('Missing or invalid Authorization header');
  }

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken || rawToken.length !== 64) {
    return unauthorized('Invalid session token format');
  }

  const tokenHash = await hashToken(rawToken);
  const kvKey = `${SESSION_KV_PREFIX}${tokenHash}`;

  // 1. Try KV cache first
  const cached = await c.env.SESSIONS_KV.get<{ user: User; expires_at: number }>(
    kvKey,
    'json'
  );

  if (cached) {
    if (cached.expires_at < now()) {
      await c.env.SESSIONS_KV.delete(kvKey);
      return unauthorized('Session expired');
    }
    c.set('user', cached.user);
    c.set('sessionToken', rawToken);
    return next();
  }

  // 2. Fallback to D1
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.id as u_id, u.username, u.email, u.role, u.is_vip, u.is_banned, ' +
    'u.reputation, u.api_secret_hash, u.vip_key, u.username_changes, ' +
    'u.created_at as u_created_at, u.updated_at as u_updated_at ' +
    'FROM sessions s JOIN users u ON s.user_id = u.id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ?'
  )
    .bind(tokenHash, now())
    .first<Record<string, unknown>>();

  if (!session) {
    return unauthorized('Session not found or expired');
  }

  const user: User = {
    id: session.u_id as string,
    username: session.username as string,
    email: session.email as string,
    password_hash: '',
    role: session.role as User['role'],
    is_vip: session.is_vip as number,
    is_banned: session.is_banned as number,
    reputation: session.reputation as number,
    api_secret_hash: session.api_secret_hash as string | null,
    vip_key: session.vip_key as string | null,
    username_changes: session.username_changes as number,
    created_at: session.u_created_at as number,
    updated_at: session.u_updated_at as number,
  };

  if (user.is_banned) {
    return forbidden('Your account has been banned');
  }

  // Cache in KV for future requests
  await c.env.SESSIONS_KV.put(kvKey, JSON.stringify({ user, expires_at: session.expires_at as number }), {
    expirationTtl: Math.min(
      SESSION_KV_TTL,
      Math.max(0, (session.expires_at as number) - now())
    ),
  });

  c.set('user', user);
  c.set('sessionToken', rawToken);
  return next();
}

/**
 * Middleware factory: require a minimum role.
 */
export function requireRole(
  minRole: 'user' | 'mod' | 'admin'
): (c: Context<HonoType>, next: Next) => Promise<Response | void> {
  const roles: Record<string, number> = { guest: 0, user: 1, mod: 2, admin: 3 };
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return unauthorized();
    if ((roles[user.role] ?? 0) < (roles[minRole] ?? 0)) {
      return forbidden(`Requires ${minRole} role or higher`);
    }
    return next();
  };
}

/**
 * Optional session: attach user if token present, otherwise continue as guest.
 */
export async function optionalSessionAuth(
  c: Context<HonoType>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    c.set('user', null);
    c.set('sessionToken', null);
    return next();
  }

  return sessionAuth(c, next);
}

/**
 * External API secret authentication.
 * Validates X-API-Secret header against app.api_secret_hash in D1.
 * Attaches appId to context.
 */
export async function apiSecretAuth(
  c: Context<HonoType>,
  next: Next
): Promise<Response | void> {
  const rawSecret = c.req.header('X-API-Secret');
  if (!rawSecret) {
    return unauthorized('X-API-Secret header required');
  }

  const secretHash = await hashToken(rawSecret);

  const app = await c.env.DB.prepare(
    'SELECT id FROM apps WHERE api_secret_hash = ? LIMIT 1'
  )
    .bind(secretHash)
    .first<{ id: string }>();

  if (!app) {
    return unauthorized('Invalid API secret');
  }

  c.set('appId', app.id);
  return next();
}

/**
 * VIP-only gate middleware. Must be used after sessionAuth.
 */
export async function requireVip(
  c: Context<HonoType>,
  next: Next
): Promise<Response | void> {
  const user = c.get('user');
  if (!user) return unauthorized();
  if (!user.is_vip && user.role !== 'admin' && user.role !== 'mod') {
    return forbidden('VIP membership required');
  }
  return next();
}
