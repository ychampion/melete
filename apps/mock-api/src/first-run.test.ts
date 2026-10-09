import { expect, test } from 'bun:test';
import { automationList, automationResponse, MORNING_BRIEF_TITLE } from '@melete/contracts';
import { createMock } from './index.ts';

const json = { 'Content-Type': 'application/json' };
// biome-ignore lint/suspicious/noExplicitAny: a test reads the mock's answers as plain JSON
const read = async (response: Response): Promise<any> => response.json();

test('the first-run mock is a fresh install with nothing connected, seeded or waiting', async () => {
  const { app } = createMock({ speed: 0, firstRun: true, experience: { seed: true } });
  expect((await read(await app.request('/setup'))).needed).toBe(true);
  expect((await app.request('/profile')).status).toBe(401);
  const made = await app.request('/setup', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email: 'sam@example.test', password: 'a-long-password' }),
  });
  expect(made.status).toBe(201);
  const get = (path: string) => app.request(path);
  expect((await read(await get('/profile'))).profile.onboarded).toBe(false);
  const home = await read(await get('/home'));
  expect(Array.isArray(home.upcoming)).toBe(false);
  expect(home.tasks).toEqual([]);
  const { connections } = await read(await get('/experience/connections'));
  expect(connections.filter((item: { builtin?: boolean }) => item.builtin !== true)).toEqual([]);
  expect(automationList.parse(await (await get('/automations')).json()).automations).toEqual([]);
  const waiting = await read(await get('/waiting-on'));
  expect(waiting.top).toEqual([]);
  expect(waiting.scan.connected).toBe(false);
  expect((await read(await get('/profile'))).profile.sending_address).toBeNull();
});

test('a morning brief made with nothing connected still reads as a brief', async () => {
  const { app } = createMock({ speed: 0 });
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: json,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const made = await post('/automations/morning-brief', { at: '08:00', topics: ['Tech', 'AI'] });
  expect(made.status).toBe(200);
  const { automation } = automationResponse.parse(await made.json());
  expect(automation.title).toBe(MORNING_BRIEF_TITLE);
  expect(automation.schedule).toContain('8:00 AM');
  expect((await post('/automations/morning-brief', { at: '08:00', topics: ['a\nb'] })).status).toBe(
    400,
  );
  expect((await post(`/automations/${automation.id}/test`)).status).toBe(200);
  const listed = automationList.parse(await (await app.request('/automations')).json());
  const summary = listed.automations.find((row) => row.id === automation.id)?.runs[0]?.summary;
  expect(summary).toContain('18°');
  expect(summary).toContain('News on Tech, AI');
  expect((await post(`/automations/${automation.id}/pause`)).status).toBe(200);
});
