// ============================================================
// lib/auth.ts — Web Crypto auth primitives
// No external dependencies. Pure Workers runtime APIs.
// ============================================================

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Hash a password using PBKDF2-SHA256.
 * Returns a storable string: "salt:hash" (both base64url encoded).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    KEY_BYTES * 8
  );

  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(derived)));

  return `${saltB64}:${hashB64}`;
}

/**
 * Verify a password against a stored PBKDF2 hash string.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;

  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const expectedHash = Uint8Array.from(atob(hashB64), (c) => c.charCodeAt(0));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    KEY_BYTES * 8
  );

  const derivedArray = new Uint8Array(derived);

  // Constant-time comparison
  if (derivedArray.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < derivedArray.length; i++) {
    diff |= derivedArray[i] ^ expectedHash[i];
  }
  return diff === 0;
}

/**
 * Generate a cryptographically secure random session token.
 * Returns 64-char hex string (256 bits of entropy).
 */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256 hash of a token for storage.
 * Tokens stored as their hash — raw token only sent to client.
 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a random API secret.
 * Format: 64-char hex string.
 */
export function generateApiSecret(): string {
  return generateSessionToken(); // Same entropy - SHA-256 random
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a UUID v4.
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Get current Unix timestamp in seconds.
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Session TTL: 30 days in seconds.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
