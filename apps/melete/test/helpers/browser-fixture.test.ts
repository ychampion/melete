import { expect, test } from 'bun:test';
import { startBrowserFixture } from './browser-fixture.ts';

test('two browser fixtures coexist on independent ephemeral ports and keep separate effects', async () => {
  const first = startBrowserFixture();
  let second: ReturnType<typeof startBrowserFixture> | undefined;
  try {
    second = startBrowserFixture();
    expect(first.url).not.toBe(second.url);
    expect((await fetch(`${first.url}/form/baseline`)).status).toBe(200);
    expect((await fetch(`${second.url}/form/baseline`)).status).toBe(200);
    expect(
      (await fetch(`${first.url}/effect?run=first`, { method: 'POST', body: 'name=First' })).status,
    ).toBe(200);
    expect(first.effects).toEqual([{ run: 'first', fields: { name: 'First' } }]);
    expect(second.effects).toEqual([]);
  } finally {
    await second?.close();
    await first.close();
  }
});
