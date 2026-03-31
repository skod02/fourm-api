import { expect, test, describe } from 'vitest';
import { generateLicenseKey, validateHwid, validateKeyFormat } from '../src/lib/keys.js';

describe('License Keys Utilities', () => {
  test('License Key format validation', () => {
    const key = generateLicenseKey();
    
    // Check format
    expect(key).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    
    // Validation function
    expect(validateKeyFormat(key)).toBe(true);
    
    // Invalid keys
    expect(validateKeyFormat('INVALID-KEY-FORMAT')).toBe(false);
    expect(validateKeyFormat('abcd-efgh-ijkl-mnop-qrst')).toBe(false); // lowercase
    expect(validateKeyFormat('1ABC-2EFG-3IJK-4MNO-5QRS')).toBe(false); // 0 and 1 not in base32 regex
  });

  test('HWID format validation', () => {
    // Valid 32-char hex (like sha256 output truncated)
    const validHwid = 'a1b2c3d4e5f60789a1b2c3d4e5f60789';
    expect(validateHwid(validHwid)).toBe(true);
    
    // Too short
    expect(validateHwid('a1b2c3d4')).toBe(false);
    
    // Not hex
    expect(validateHwid('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });
});
