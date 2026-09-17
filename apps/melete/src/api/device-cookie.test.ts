import { describe, expect, test } from 'bun:test';
import { DEVICE_TTL_SECONDS, DeviceCookies } from './device-cookie.ts';

const secret = 'a-deployment-secret-of-at-least-32-bytes';

describe('known-device cookie', () => {
  test('names the account it was issued for without carrying the email', () => {
    const cookies = new DeviceCookies(secret, () => 0);
    const value = cookies.issue('owner@example.test');
    expect(value).not.toContain('owner');
    expect(value).toMatch(/^v1\.[\w-]+\.[\w-]+\.\d+\.[\w-]+$/);
    const known = cookies.verify(value);
    expect(known?.account).toBe(cookies.account('owner@example.test'));
    expect(known?.account).not.toBe(cookies.account('second@example.test'));
    // Every issued cookie has its own identity and therefore its own attempt budget.
    expect(cookies.verify(cookies.issue('owner@example.test'))?.nonce).not.toBe(known?.nonce);
  });

  test('anything altered, foreign, expired or malformed is no proof at all', () => {
    let now = 0;
    const cookies = new DeviceCookies(secret, () => now);
    const value = cookies.issue('owner@example.test');
    const parts = value.split('.');
    const swapped = [...parts];
    swapped[1] = cookies.account('second@example.test');
    const later = [...parts];
    later[3] = String(Number(parts[3]) + 1);
    for (const forged of [
      swapped.join('.'),
      later.join('.'),
      `${value}x`,
      value.slice(0, -1),
      parts.slice(0, 4).join('.'),
      `v2.${parts.slice(1).join('.')}`,
      '',
      'v1....',
      'x'.repeat(300),
      undefined,
    ])
      expect(cookies.verify(forged)).toBeNull();
    expect(
      new DeviceCookies('another-deployment-secret-32-bytes!!', () => 0).verify(value),
    ).toBeNull();
    expect(new DeviceCookies(undefined, () => 0).verify(value)).toBeNull();
    now = DEVICE_TTL_SECONDS * 1000 - 1;
    expect(cookies.verify(value)).not.toBeNull();
    now = DEVICE_TTL_SECONDS * 1000;
    expect(cookies.verify(value)).toBeNull();
  });

  test('a deployment secret keeps known devices across a restart; without one they start over', () => {
    const value = new DeviceCookies(secret, () => 0).issue('owner@example.test');
    expect(new DeviceCookies(secret, () => 0).verify(value)).not.toBeNull();
    const ephemeral = new DeviceCookies(undefined, () => 0).issue('owner@example.test');
    expect(new DeviceCookies(undefined, () => 0).verify(ephemeral)).toBeNull();
  });
});
