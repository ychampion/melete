import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { createMock } from './index.ts';
import { RECORD_PAGE } from './runs.ts';

const call = async (
  mock: ReturnType<typeof createMock>,
  path: string,
  method = 'GET',
  body?: unknown,
) => {
  const response = await mock.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
const runOf = (body: unknown) => C.runResponse.parse(body).run;

const seeded = () => createMock({ speed: 0, experience: { seed: true } });

test('the seed holds work under way, work waiting on the person, and finished work', async () => {
  const mock = seeded();
  const { runs } = C.runListResponse.parse((await call(mock, '/runs')).body);
  const byStatus = new Map(runs.map((run) => [run.status, run]));
  const working = byStatus.get('working');
  expect(working?.experiments.count).toBeGreaterThan(0);
  expect(working?.experiments.best?.checked).toBe(true);
  expect(working?.steps.length).toBe(2);
  expect(working?.latest_report).not.toBeNull();
  expect(working?.status_line).toMatch(/^Working on it · 14 tries, best price \d+/);
  const needs = byStatus.get('needs_you');
  expect(needs?.question).toBeTruthy();
  expect(needs?.status_line).toBe(needs?.question ?? '');
  expect(byStatus.get('done')?.result).toBeTruthy();

  // A chat finds the work it started.
  const chatId = working?.conversation_id;
  if (!chatId) throw new Error('The working fixture belongs to a chat');
  const inChat = C.runListResponse.parse(
    (await call(mock, `/runs?conversation_id=${chatId}`)).body,
  ).runs;
  expect(inChat.map((run) => run.id)).toEqual([working.id]);
});

test('the seed has work that repeats, and new work can repeat from the start', async () => {
  const { runs } = C.runListResponse.parse((await call(seeded(), '/runs')).body);
  const standing = runs.find((run) => run.standing);
  expect(standing?.standing).toMatchObject({
    kind: 'schedule',
    description: 'Every weekday at 9:00',
  });
  expect(standing?.standing?.next_wake_at).toBeTruthy();
  expect(standing?.status_line).toBe('Waiting until next time');

  const mock = createMock({ speed: 0 });
  const created = runOf(
    (
      await call(mock, '/runs', 'POST', {
        goal: 'Check the price list',
        repeat: { cron: '30 8 * * 1' },
      })
    ).body,
  );
  expect(created.standing?.description).toBe('Every Monday at 8:30');
  const stopped = runOf((await call(mock, `/runs/${created.id}/stop`, 'POST')).body);
  expect(stopped.standing).toBeNull();
});

test('the record pages oldest first and ends with no cursor', async () => {
  const mock = seeded();
  const { runs } = C.runListResponse.parse((await call(mock, '/runs')).body);
  const working = runs.find((run) => run.status === 'working');
  if (!working) throw new Error('missing fixture');
  const first = C.runRecordResponse.parse((await call(mock, `/runs/${working.id}/record`)).body);
  expect(first.entries).toHaveLength(RECORD_PAGE);
  expect(first.entries[0]?.kind).toBe('plan');
  expect(first.next_cursor).not.toBeNull();
  const second = C.runRecordResponse.parse(
    (await call(mock, `/runs/${working.id}/record?after=${first.next_cursor}`)).body,
  );
  expect(second.entries.length).toBeGreaterThan(0);
  expect(second.next_cursor).toBeNull();
  const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  const exported = C.runExportResponse.parse((await call(mock, `/runs/${working.id}/export`)).body);
  expect(exported.markdown).toStartWith(`# ${working.title}\n`);
});

test('pause, resume, reply, limit and stop change the view as the service does', async () => {
  const mock = seeded();
  const { runs } = C.runListResponse.parse((await call(mock, '/runs')).body);
  const working = runs.find((run) => run.status === 'working');
  const needs = runs.find((run) => run.status === 'needs_you');
  if (!working || !needs) throw new Error('missing fixture');

  const paused = runOf((await call(mock, `/runs/${working.id}/pause`, 'POST')).body);
  expect(paused.status).toBe('waiting');
  expect(paused.status_line).toStartWith('Paused');
  const resumed = runOf((await call(mock, `/runs/${working.id}/resume`, 'POST')).body);
  expect(resumed.status).toBe('working');

  const limited = runOf(
    (await call(mock, `/runs/${working.id}/limit`, 'PUT', { limit: { max_hours: 12 } })).body,
  );
  expect(limited.limit).toEqual({ max_hours: 12 });

  const replied = runOf(
    (await call(mock, `/runs/${needs.id}/message`, 'POST', { text: 'Only Oakline.' })).body,
  );
  expect(replied.status).toBe('working');
  expect(replied.question).toBeNull();

  const stopped = runOf((await call(mock, `/runs/${working.id}/stop`, 'POST')).body);
  expect(stopped.status).toBe('stopped');
  expect(stopped.finished_at).not.toBeNull();
  expect(stopped.steps.every((step) => step.status !== 'working')).toBe(true);
  const refused = await call(mock, `/runs/${working.id}/message`, 'POST', { text: 'More' });
  expect(refused.status).toBe(409);
});

test('new work starts working, and an unknown id is not found', async () => {
  const mock = createMock({ speed: 0 });
  const created = await call(mock, '/runs', 'POST', {
    goal: 'Compare three phone plans',
    done_when: 'One plan picked',
  });
  const run = runOf(created.body);
  expect(run.status).toBe('working');
  expect(run.done_when).toBe('One plan picked');
  expect(C.runListResponse.parse((await call(mock, '/runs')).body).runs).toHaveLength(1);
  expect((await call(mock, '/runs/job_missing')).status).toBe(404);
});

test('a message takes finished work up again, and the export uses plain labels', async () => {
  const mock = seeded();
  const { runs } = C.runListResponse.parse((await call(mock, '/runs')).body);
  const done = runs.find((run) => run.status === 'done');
  if (!done) throw new Error('missing fixture');
  const exported = C.runExportResponse.parse((await call(mock, `/runs/${done.id}/export`)).body);
  expect(exported.markdown).toContain(' · Tried: ');
  expect(exported.markdown).not.toMatch(/ · (experiment|checkpoint|finished):/);
  const again = runOf(
    (await call(mock, `/runs/${done.id}/message`, 'POST', { text: 'Find one more option.' })).body,
  );
  expect(again.status).toBe('working');
  expect(again.finished_at).toBeNull();
});
