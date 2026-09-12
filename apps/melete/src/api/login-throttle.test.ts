import { describe, expect, test } from 'bun:test';
import { LoginThrottle } from './login-throttle.ts';

describe('per-source login throttle', () => {
  test('reserves a small burst synchronously and increases retry backoff', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    expect(Array.from({ length: 8 }, () => throttle.admit('192.0.2.1'))).toEqual([
      0, 0, 0, 0, 0, 1, 1, 1,
    ]);
    expect(throttle.admit('192.0.2.2')).toBe(0);
    now = 1000;
    expect(throttle.admit('192.0.2.1')).toBe(0);
    expect(throttle.admit('192.0.2.1')).toBe(2);
    now = 3000;
    expect(throttle.admit('192.0.2.1')).toBe(0);
    expect(throttle.admit('192.0.2.1')).toBe(4);
    for (let i = 0; i < 10; i++) {
      now += 60_000;
      expect(throttle.admit('192.0.2.1')).toBe(0);
    }
    expect(throttle.admit('192.0.2.1')).toBe(60);
  });

  test('success and fifteen minutes of inactivity restore the burst', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let i = 0; i < 5; i++) throttle.admit('192.0.2.1');
    throttle.succeeded('192.0.2.1');
    expect(throttle.admit('192.0.2.1')).toBe(0);
    for (let i = 0; i < 4; i++) throttle.admit('192.0.2.1');
    expect(throttle.admit('192.0.2.1')).toBe(1);
    now = 15 * 60_000;
    expect(throttle.admit('192.0.2.1')).toBe(0);
  });

  test('new sources cannot evict penalties or grow the bucket map without bound', () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 1024; i++) for (let j = 0; j < 5; j++) throttle.admit(`source-${i}`);
    expect(throttle.admit('source-0')).toBe(1);
    expect(Array.from({ length: 8 }, (_, i) => throttle.admit(`overflow-${i}`))).toEqual([
      0, 0, 0, 0, 0, 1, 1, 1,
    ]);
    expect(throttle.admit('source-0')).toBe(1);
  });
});
