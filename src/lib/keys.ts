const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Base32 no ambiguous chars

/**
 * Generate a license key in XXXX-XXXX-XXXX-XXXX-XXXX format.
 * Each segment is 4 chars from the base32 charset.
 * Total entropy: 4 chars × 5 groups = 20 chars from 32-char alphabet
 * ≈ 100 bits of entropy.
 */
export function generateLicenseKey(): string {
  const segments: string[] = [];
  const randomBytes = crypto.getRandomValues(new Uint8Array(20));

  for (let seg = 0; seg < 5; seg++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) {
      chunk += CHARSET[randomBytes[seg * 4 + i] % CHARSET.length];
    }
    segments.push(chunk);
  }

  return segments.join('-');
}

/**
 * Validate HWID format: sha256(MAC)[:32] — 32 hex chars.
 */
export function validateHwid(hwid: string): boolean {
  if (typeof hwid !== 'string') return false;
  if (hwid.length !== 32) return false;
  return /^[0-9a-f]{32}$/i.test(hwid);
}

/**
 * Validate license key format: XXXX-XXXX-XXXX-XXXX-XXXX
 */
export function validateKeyFormat(key: string): boolean {
  if (typeof key !== 'string') return false;
  const pattern = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
  return pattern.test(key);
}

/**
 * Parse device_ids JSON stored in D1.
 */
export function parseDeviceIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
