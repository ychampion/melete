import { describe, expect, test } from 'bun:test';
import { DeviceHub } from './hub.ts';
import { DevicePathError, devicePath, openableUrl } from './paths.ts';

describe('the device hub', () => {
  test('an offline computer is sent nothing', async () => {
    const hub = new DeviceHub();
    expect(await hub.call('dev_a', { id: 'a1', tool: 'status', arguments: {} }, 1_000)).toEqual({
      kind: 'not_delivered',
      reason: 'offline',
    });
  });

  test('a request is handed to the poll and settled by its answer', async () => {
    const hub = new DeviceHub();
    const poll = hub.poll('dev_a', 5_000);
    const call = hub.call('dev_a', { id: 'a1', tool: 'run', arguments: { command: 'x' } }, 5_000);
    const [request] = await poll;
    expect(request?.id).toBe('a1');
    // Another computer cannot answer for it.
    expect(hub.settle('dev_b', 'a1', { ok: true, result: {} })).toBe(false);
    expect(hub.settle('dev_a', 'a1', { ok: true, result: { exit_code: 0 } })).toBe(true);
    expect(await call).toEqual({ kind: 'reply', reply: { ok: true, result: { exit_code: 0 } } });
  });

  test('collected but unanswered is unknown; never collected is not delivered', async () => {
    const hub = new DeviceHub();
    hub.touch('dev_a');
    const uncollected = await hub.call('dev_a', { id: 'a1', tool: 'status', arguments: {} }, 50);
    expect(uncollected).toEqual({ kind: 'not_delivered', reason: 'not_collected' });
    const call = hub.call('dev_a', { id: 'a2', tool: 'status', arguments: {} }, 100);
    await hub.poll('dev_a', 1_000);
    expect(await call).toEqual({ kind: 'no_answer' });
  });

  test('disconnecting answers what waited', async () => {
    const hub = new DeviceHub();
    hub.touch('dev_a');
    const call = hub.call('dev_a', { id: 'a1', tool: 'status', arguments: {} }, 10_000);
    hub.disconnect('dev_a');
    expect(await call).toEqual({ kind: 'not_delivered', reason: 'disconnected' });
    expect(hub.online('dev_a')).toBe(false);
  });
});

describe('paths the service sends', () => {
  const folders = [{ name: 'Projects', path: 'C:\\Users\\me\\Projects' }];
  test.each([
    '../x',
    'Projects/../x',
    'Projects/./x',
    '/etc',
    'C:/x',
    'Projects\\x',
    '~/x',
    'Projects/aux',
    'Projects/x.',
    'Elsewhere/x',
  ])('%s is refused', (path) => {
    expect(() => devicePath(path, folders)).toThrow(DevicePathError);
  });
  test('a plain path names its folder', () => {
    expect(devicePath('Projects/notes/todo.md', folders).segments).toEqual(['notes', 'todo.md']);
  });
  test('only http and https pages open', () => {
    expect(openableUrl('https://example.com/a')).toBe('https://example.com/a');
    for (const url of ['file:///c:/x', 'javascript:1', 'ms-settings:', 'https://u:p@example.com'])
      expect(() => openableUrl(url)).toThrow(DevicePathError);
  });
});
