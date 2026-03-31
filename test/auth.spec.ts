import { expect, test, describe } from 'vitest';
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from '../src/lib/auth.js';

describe('Auth Utilities', () => {
  test('Password hashing and verification', async () => {
    const password = 'SuperSecretPassword123!';
    
    // Hash the password
    const hash = await hashPassword(password);
    expect(hash).toContain(':');
    
    // Split to get salt and iterations
    const parts = hash.split(':');
    expect(parts.length).toBe(2); // salt:hash
    
    // Verify valid password
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
    
    // Verify invalid password
    const isInvalid = await verifyPassword('wrongpassword', hash);
    expect(isInvalid).toBe(false);
  });

  test('Session token generation and hashing', async () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThan(40);
    
    const tokenHash = await hashToken(token);
    expect(tokenHash.length).toBe(64); // SHA-256 hex is 64 chars
    expect(tokenHash).not.toBe(token);
  });
});
