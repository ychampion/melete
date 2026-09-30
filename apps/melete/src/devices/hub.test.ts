import { describe, expect, test } from 'bun:test';
import { DeviceHub } from './hub.ts';
import { DevicePathError, devicePath, namesLocalNetwork, openableUrl } from './paths.ts';

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

  test('turning something off withdraws what waits for it, and only that', async () => {
    const hub = new DeviceHub();
    hub.touch('dev_a');
    const run = hub.call('dev_a', { id: 'a1', tool: 'run', arguments: { command: 'x' } }, 10_000);
    const read = hub.call('dev_a', { id: 'a2', tool: 'read_file', arguments: {} }, 10_000);
    const other = hub.call('dev_b', { id: 'b1', tool: 'run', arguments: {} }, 50);
    expect(hub.withdraw('dev_a', (request) => request.tool !== 'run')).toBe(1);
    expect(await run).toEqual({ kind: 'not_delivered', reason: 'capability_off' });
    // What is still allowed is still handed over.
    const [collected] = await hub.poll('dev_a', 1_000);
    expect(collected?.id).toBe('a2');
    // Once collected, it is the computer's to refuse; the hub does not pretend otherwise.
    expect(hub.withdraw('dev_a', () => false)).toBe(0);
    hub.settle('dev_a', 'a2', { ok: true, result: {} });
    expect((await read).kind).toBe('reply');
    expect(await other).toEqual({ kind: 'not_delivered', reason: 'offline' });
  });

  test('what waits for the browser is withdrawn when the browser is turned off', async () => {
    const hub = new DeviceHub();
    hub.touch('dev_a', 'browser');
    const open = hub.call(
      'dev_a',
      { id: 'b1', tool: 'browser_open', arguments: { url: 'https://example.com' } },
      10_000,
      undefined,
      'browser',
    );
    expect(hub.withdraw('dev_a', (request) => !request.tool.startsWith('browser_'))).toBe(1);
    expect(await open).toEqual({ kind: 'not_delivered', reason: 'capability_off' });
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
  test('an address on the computer or its network is told apart by itself', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://LOCALHOST./admin',
      'http://app.localhost/',
      'http://127.0.0.1:8080/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://10.1.2.3/',
      'http://172.20.0.1/',
      'http://192.168.0.1/',
      'http://169.254.169.254/latest',
      'http://100.100.1.1/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://router/',
      'http://printer.local/',
      'http://nas.lan/',
      'http://wiki.internal/',
      'http://box.home.arpa/',
    ])
      expect([url, namesLocalNetwork(url)]).toEqual([url, true]);
    for (const url of ['https://example.com/', 'https://93.184.215.14/', 'https://[2606:4700::1]/'])
      expect([url, namesLocalNetwork(url)]).toEqual([url, false]);
  });

  test('only http and https pages open', () => {
    expect(openableUrl('https://example.com/a')).toBe('https://example.com/a');
    for (const url of ['file:///c:/x', 'javascript:1', 'ms-settings:', 'https://u:p@example.com'])
      expect(() => openableUrl(url)).toThrow(DevicePathError);
  });
});
