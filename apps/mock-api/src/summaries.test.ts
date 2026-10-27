/**
 * "Show me only what needs me" in the mock, answered as the service answers
 * it: the seeded space starts with it on, its saved files refuse their content
 * route and open only as originals, and each open and change is in Activity.
 */
import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { createMock } from './index.ts';

async function session(mock: ReturnType<typeof createMock>): Promise<string> {
  const spaces = await mock.app.fetch(new Request('http://mock.test/spaces'));
  return spaces.headers.get('set-cookie')?.split(';')[0] ?? '';
}

test('the fixture shows a summaries-only space with saved files and the notes they left', async () => {
  const mock = createMock({ speed: 0, summariesOnly: true });
  const cookie = await session(mock);
  const call = (path: string, init: RequestInit = {}) =>
    mock.app.fetch(
      new Request(`http://mock.test${path}`, {
        ...init,
        headers: { cookie, 'content-type': 'application/json' },
      }),
    );

  const setting = C.summariesOnlySetting.parse(
    await (await call(`/spaces/${mock.spaceId}/summaries-only`)).json(),
  );
  expect(setting.on).toBe(true);

  const files = C.personFileList.parse(await (await call('/files')).json()).files;
  expect(files.map((file) => file.name)).toContain('Electric bill, October.txt');
  const bill = files.find((file) => file.name === 'Electric bill, October.txt');
  if (!bill) throw new Error('No bill');

  const refused = await call(`/files/${bill.id}/content`);
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
    C.SUMMARIES_ONLY_CODE,
  );

  const opened = await call(`/files/${bill.id}/original?disposition=inline`, { method: 'POST' });
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain('Amount due');

  const activity = async () =>
    C.activityList.parse(await (await call('/activity')).json()).activity;
  expect((await activity())[0]).toMatchObject({
    note: 'original_opened',
    what: 'Opened the original',
    destination: 'Electric bill, October.txt',
  });

  const off = await call(`/spaces/${mock.spaceId}/summaries-only`, {
    method: 'PUT',
    body: JSON.stringify({ on: false }),
  });
  expect(C.summariesOnlySetting.parse(await off.json()).on).toBe(false);
  expect((await activity())[0]).toMatchObject({ note: 'summaries_off' });
  expect((await call(`/files/${bill.id}/content`)).status).toBe(200);
});
