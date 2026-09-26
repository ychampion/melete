/**
 * The Notifications tab speaks plainly: quiet hours come from the person's day,
 * each device says when it was added and last used, and a device is named the
 * way its owner would name it.
 */
import { expect, test } from 'bun:test';
import { deviceLabel } from '../experience/push.ts';
import type { PushSettings } from '../experience/types.ts';
import { BATCH_OPTIONS, CAP_OPTIONS, deviceLine, quietLine } from './Notifications.tsx';

const settings: PushSettings = {
  decisions: true,
  settled: true,
  weekly_summary: true,
  daily_cap: 4,
  batch_minutes: 10,
  quiet_hours: { from: '22:00', until: '08:00', time_zone: 'Europe/London' },
};

test('quiet hours are the day hours read the other way round', () => {
  expect(quietLine(settings)).toBe(
    'Nothing is sent from 22:00 until 08:00 (Europe/London), outside your day.',
  );
});

test('a device says when it was added and whether anything reached it', () => {
  const device = {
    id: 'psub_01M0000000000000000000000A',
    device_label: 'iPhone · Safari',
    created_at: '2026-09-20T09:00:00.000Z',
    last_used_at: null,
  };
  expect(deviceLine(device)).toBe('Added Sep 20 · nothing sent yet');
  expect(deviceLine({ ...device, last_used_at: '2026-09-26T09:00:00.000Z' })).toBe(
    'Added Sep 20 · last push Sep 26',
  );
});

test('devices are named the way a person would name them', () => {
  expect(
    deviceLabel(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    ),
  ).toBe('iPhone · Safari');
  expect(
    deviceLabel(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
    ),
  ).toBe('Android · Chrome');
  expect(
    deviceLabel(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
    ),
  ).toBe('Windows · Edge');
});

test('the choices offered match what the service accepts', () => {
  for (const option of CAP_OPTIONS) expect(Number(option.value)).toBeGreaterThanOrEqual(1);
  for (const option of CAP_OPTIONS) expect(Number(option.value)).toBeLessThanOrEqual(20);
  for (const option of BATCH_OPTIONS) expect(Number(option.value)).toBeLessThanOrEqual(240);
});
