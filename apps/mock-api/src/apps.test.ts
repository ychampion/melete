import { afterEach, expect, test } from 'bun:test';
import { appDetail, appListResponse, appView } from '@melete/contracts';
import { isIsolated } from '../../melete/src/viewer/headers.ts';
import { createMock } from './index.ts';

const mock = () => createMock({ speed: 0, experience: { seed: true } });
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

afterEach(() => {
  delete process.env.MELETE_MOCK_APP_FRAMES;
});

test('the mock lists its apps and shows one, as the contract describes them', async () => {
  const { app } = mock();
  const list = appListResponse.parse(await (await app.request('/apps')).json());
  expect(list.apps.map((entry) => [entry.name, entry.role])).toEqual([
    ['Deals', 'manage'],
    ['Team tracker', 'view'],
  ]);
  const deals = appDetail.parse(await (await app.request(`/apps/${list.apps[0]?.id}`)).json());
  expect(deals.versions?.map((version) => version.current)).toEqual([true, false, false]);
  const tracker = appDetail.parse(await (await app.request(`/apps/${list.apps[1]?.id}`)).json());
  expect(tracker.versions).toBeNull();
});

test("the mock serves a view's files isolated, and ends the view when the grants change", async () => {
  process.env.MELETE_MOCK_APP_FRAMES = 'self';
  const { app } = mock();
  const [deals] = appListResponse.parse(await (await app.request('/apps')).json()).apps;
  const view = appView.parse(
    await (await app.request(`/apps/${deals?.id}/views`, json('POST'))).json(),
  );
  const page = await app.request(view.view_path);
  expect(page.status).toBe(200);
  expect(isIsolated(page.headers)).toBe(true);
  expect(await page.text()).toContain('<title>Open deals</title>');
  const data = (await (await app.request(`/apps/${deals?.id}/data/deals`)).json()) as {
    value: unknown[];
  };
  expect(data.value).toHaveLength(3);

  await app.request(`/apps/${deals?.id}/grants`, json('PUT', { grants: [] }));
  const after = await app.request(view.view_path);
  expect(after.status).toBe(404);
  expect(isIsolated(after.headers)).toBe(true);
});
