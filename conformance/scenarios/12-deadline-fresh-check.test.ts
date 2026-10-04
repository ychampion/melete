/**
 * Conformance 12. A deadline is checked against fresh state at its time, once.
 *
 * A person sets three deadlines on documents in a scripted source. One is
 * signed before its time, one is not, and one is moved later before its time
 * comes. Two sweeps run at once at each moment, as two service instances
 * would. The clock is the test's; nothing calls a model and nothing leaves
 * the database but the scripted source's reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { owner } from '../../apps/melete/src/db/schema.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { TriggerService } from '../../apps/melete/src/jobs/triggers.ts';
import { SituationService } from '../../apps/melete/src/situations/service.ts';
import { conformanceFixture } from '../helpers/fixture.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(12);
const fixture = await conformanceFixture();
const withDb = fixture ? describe : describe.skip;
const MINUTE = 60_000;

withDb(`conformance 12: ${s.title}`, () => {
  if (!fixture) return;
  let clock = Date.parse('2026-10-05T14:00:00.000Z');
  const docs = new Map<string, { signed: boolean; reads: number[] }>([
    ['doc:signed-early', { signed: false, reads: [] }],
    ['doc:unsigned', { signed: false, reads: [] }],
    ['doc:moved', { signed: false, reads: [] }],
  ]);
  const situations = new SituationService({
    jobs: fixture.jobs,
    triggers: new TriggerService(fixture.jobs, fixture.runner),
    detectors: false,
    now: () => clock,
    connectors: {
      get: () => ({
        subjects: {
          read: async ({ key }) => {
            const doc = docs.get(key);
            if (!doc) return 'gone';
            doc.reads.push(clock);
            return { signed: doc.signed };
          },
        },
      }),
    },
  });
  const due = Date.parse('2026-10-05T15:00:00.000Z');
  const lead = 5 * 60;
  const fireAt = due - lead * 1000;
  const movedDue = due + 60 * MINUTE;
  let principalId = '';

  const set = (subjectKey: string, dueAt: number) =>
    situations.setDeadline({
      spaceId: fixture.spaceId,
      principalId,
      subjectKey,
      connectionId: fixture.connectionId,
      title: 'The contract is signed',
      dueAt: new Date(dueAt),
      leadSeconds: lead,
      atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
      personSet: true,
    });
  const raised = (subjectKey: string) =>
    fixture.handle.sql`select * from situation where subject_key = ${subjectKey}`;
  const intents = (subjectKey: string) =>
    fixture.handle.sql`select p.* from push_intent p join situation s on s.id = p.situation_id
      where s.subject_key = ${subjectKey}`;
  /** Two sweeps at once, as two instances would run them. */
  const sweepTwice = () => Promise.all([situations.sweep(), situations.sweep()]);

  beforeAll(async () => {
    principalId = newId('own');
    await fixture.handle.db.insert(owner).values({ id: principalId, email: 'c12@example.test' });
    await fixture.handle
      .sql`insert into principal (id, email) select id, email from owner where id = ${principalId}`;
    await fixture.handle.sql`update space set owner_principal_id = ${principalId}
      where id = ${fixture.spaceId}`;
    // A device, so what would reach the person is recorded as a push intent.
    await fixture.handle
      .sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
      values (${newId('psub')}, ${principalId}, 'https://push.example.test/c12', 'k', 'a')`;
    await set('doc:signed-early', due);
    await set('doc:unsigned', due);
    await set('doc:moved', due);
    // Before its time nothing is read.
    clock = fireAt - MINUTE;
    await sweepTwice();
    // Signed between the deadline being set and its time.
    const early = docs.get('doc:signed-early');
    if (early) early.signed = true;
    // Moved an hour later before its time came.
    await set('doc:moved', movedDue);
    clock = fireAt;
    await sweepTwice();
    clock = fireAt + MINUTE;
    await sweepTwice();
    clock = movedDue - lead * 1000;
    await sweepTwice();
    await sweepTwice();
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  }, 30_000);

  test(s.assertions[0] ?? '', async () => {
    // a deadline met before its time is checked at its time and says nothing to anyone
    expect(docs.get('doc:signed-early')?.reads).toEqual([fireAt]);
    expect(await raised('doc:signed-early')).toHaveLength(0);
    expect(await intents('doc:signed-early')).toHaveLength(0);
  });

  test(s.assertions[1] ?? '', async () => {
    // an unmet deadline is raised exactly once, with its reason, however many sweeps run at its time
    expect(docs.get('doc:unsigned')?.reads).toEqual([fireAt]);
    const rows = await raised('doc:unsigned');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Due Mon 3:00 PM, and it is not done yet.');
    expect(rows[0]?.because).toHaveLength(1);
    expect(await intents('doc:unsigned')).toHaveLength(1);
  });

  test(s.assertions[2] ?? '', async () => {
    // a deadline moved before its time is read and raised at the new time only
    expect(docs.get('doc:moved')?.reads).toEqual([movedDue - lead * 1000]);
    const rows = await raised('doc:moved');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]?.deadline_at).getTime()).toBe(movedDue);
  });

  test(s.assertions[3] ?? '', async () => {
    // no clock is read before its time, and no model is called
    const [calls] = await fixture.handle.sql`select count(*)::int as n from model_usage`;
    expect(calls?.n).toBe(0);
    for (const doc of docs.values())
      for (const at of doc.reads) expect(at).toBeGreaterThanOrEqual(fireAt);
  });
});
