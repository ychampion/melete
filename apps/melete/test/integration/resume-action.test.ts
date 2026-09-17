import { afterAll, expect, test } from 'bun:test';
import type { CapabilityClaims, ConnectorManifest, JsonObject } from '@melete/contracts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { RESUME_ACTION_TOOL } from '../../src/broker/resume.ts';
import { BrokerService } from '../../src/broker/service.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const dbTest = db ? test : test.skip;
afterAll(async () => {
  await db?.close();
});

const manifest: ConnectorManifest = {
  name: 'test',
  provider: 'test',
  version: '0.1.0',
  description: 'Resume fixture',
  credentials: [],
  health: true,
  tools: ['send', 'read'].map((name) => ({
    name: `test.${name}`,
    description: name,
    input_schema: { type: 'object' },
    effect_class: name === 'send' ? 'write_external' : 'read',
    required_scopes: [`test.${name}`],
    requires_approval: name === 'send',
    verify: false,
  })),
};

async function setup(execute?: Connector['execute']) {
  if (!db) throw new Error('Postgres unavailable');
  const seed = await seedJob(db.sql);
  const sent: JsonObject[] = [];
  const connector: Connector = {
    manifest,
    async execute(action, ctx) {
      sent.push(action.canonical_payload);
      if (execute) return execute(action, ctx);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: `receipt:${action.id}`,
          received_at: new Date().toISOString(),
          late: false,
          detail: {},
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  const broker = new BrokerService({
    sql: db.sql,
    connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
  });
  /** What the runner does on the wake after a decision: a new attempt under a new epoch. */
  const nextAttempt = async (previous: CapabilityClaims): Promise<CapabilityClaims> => {
    const id = recordId('att');
    const [job] = await db.sql`update job set state = 'running', lease_epoch = lease_epoch + 1
      where id = ${previous.job_id} returning lease_epoch, revision`;
    await db.sql`update attempt set outcome = 'waiting_for_approval', ended_at = now()
      where id = ${previous.attempt_id}`;
    await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${id}, ${previous.job_id}, ${job?.lease_epoch}, 'fake', 'fake', 'scripted')`;
    return {
      ...previous,
      attempt_id: id,
      epoch: Number(job?.lease_epoch),
      revision: Number(job?.revision),
    };
  };
  const approved = async (payload: JsonObject) => {
    const proposal = await broker.propose(seed.claims, {
      kind: 'test.send',
      connection_id: seed.connectionId,
      payload,
      client_ref: 'first',
    });
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    return proposal;
  };
  return { ...seed, broker, sent, nextAttempt, approved, sql: db.sql };
}

dbTest(
  'an approved action is carried out by id, with the stored bytes and the new attempt authority',
  async () => {
    const s = await setup();
    const proposal = await s.approved({ to: 'alex@example.test', body: 'I can attend Friday.' });
    expect(s.sent).toHaveLength(0);
    const next = await s.nextAttempt(s.claims);
    const resumed = await s.broker.resume(next, proposal.action_id);
    expect(resumed).toMatchObject({
      action_id: proposal.action_id,
      status: 'succeeded',
      payload_hash: proposal.payload_hash,
      repeated: false,
    });
    // The caller supplied an id and no bytes: what left is what the owner read.
    expect(s.sent).toEqual([{ body: 'I can attend Friday.', to: 'alex@example.test' }]);
    const action = await loadAction(s.sql, proposal.action_id);
    expect(action.attempt_id).toBe(next.attempt_id);
    expect(action.authorization_ref).toBe(proposal.approval_id);
    const ledger =
      await s.sql`select attempt_id, reserved, settled from budget_ledger where action_id = ${proposal.action_id}`;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ attempt_id: next.attempt_id, reserved: 1, settled: 1 });
    // A second resume and a byte-identical proposal both read the receipt back.
    const again = await s.broker.resume(next, proposal.action_id);
    expect(again).toMatchObject({ status: 'succeeded', repeated: true });
    expect(again.message).toContain(`receipt receipt:${proposal.action_id}`);
    expect(s.sent).toHaveLength(1);
  },
);

dbTest('a byte-identical proposal after approval still dispatches without resume', async () => {
  const s = await setup();
  const proposal = await s.approved({ to: 'alex@example.test', body: 'Same bytes.' });
  const next = await s.nextAttempt(s.claims);
  const repeated = await s.broker.propose(next, {
    kind: 'test.send',
    connection_id: s.connectionId,
    payload: { body: 'Same bytes.', to: 'alex@example.test' },
    client_ref: 'first',
  });
  expect(repeated).toMatchObject({ action_id: proposal.action_id, status: 'succeeded' });
  expect(s.sent).toHaveLength(1);
});

dbTest('resume refuses whatever the owner has not approved for this job and revision', async () => {
  const s = await setup();
  const undecided = await s.broker.propose(s.claims, {
    kind: 'test.send',
    connection_id: s.connectionId,
    payload: { body: 'undecided' },
  });
  expect(await s.broker.resume(s.claims, undecided.action_id)).toMatchObject({
    status: 'needs_approval',
    requires_approval: true,
  });
  await s.broker.decide(undecided.action_id, {
    decision: 'denied',
    payload_hash: undecided.payload_hash,
  });
  const afterDenial = await s.nextAttempt(s.claims);
  expect(await s.broker.resume(afterDenial, undecided.action_id)).toMatchObject({
    status: 'denied',
  });
  // Another job's approved action is absent, not forbidden.
  const other = await setup();
  const foreign = await other.approved({ body: 'elsewhere' });
  expect(await rejectionOf(s.broker.resume(afterDenial, foreign.action_id))).toMatchObject({
    code: 'action_not_found',
  });
  // The old attempt is fenced, and a revised job no longer matches the approval.
  const revisable = await setup();
  const held = await revisable.approved({ body: 'before the change' });
  const current = await revisable.nextAttempt(revisable.claims);
  expect(
    await rejectionOf(revisable.broker.resume(revisable.claims, held.action_id)),
  ).toMatchObject({ code: 'stale_epoch' });
  await revisable.sql`update job set revision = revision + 1 where id = ${current.job_id}`;
  const revised = await revisable.nextAttempt(current);
  const refusal = await rejectionOf(revisable.broker.resume(revised, held.action_id));
  expect(refusal).toMatchObject({ code: 'revision_mismatch' });
  expect(s.sent).toHaveLength(0);
  expect(other.sent).toHaveLength(0);
  expect(revisable.sent).toHaveLength(0);
  expect(
    await revisable.sql`select * from budget_ledger where action_id = ${held.action_id} and settled is null`,
  ).toHaveLength(0);
});

dbTest('an unknown outcome is never replayed through resume', async () => {
  const s = await setup(async () => {
    throw new Error('accepted, then the acknowledgement was lost');
  });
  const proposal = await s.approved({ body: 'once' });
  const next = await s.nextAttempt(s.claims);
  expect((await s.broker.resume(next, proposal.action_id)).status).toBe('unknown');
  expect(s.sent).toHaveLength(1);
  // needs_reconciliation is terminal for the attempt: a later one still cannot send it again.
  await s.sql`update job set state = 'running' where id = ${next.job_id}`;
  const later = await s.broker.resume(next, proposal.action_id);
  expect(later).toMatchObject({ status: 'unknown', repeated: true });
  expect(later.message).toContain('was not sent again');
  expect(s.sent).toHaveLength(1);
});

dbTest('resume_action is offered first, and only while an approved action waits', async () => {
  const s = await setup();
  const names = async (claims: CapabilityClaims) =>
    (await s.broker.catalog(claims)).map((tool) => tool.name);
  expect(await names(s.claims)).not.toContain(RESUME_ACTION_TOOL.name);
  const proposal = await s.approved({ body: 'offer' });
  const next = await s.nextAttempt(s.claims);
  expect((await names(next)).slice(0, 3)).toEqual(['search_tools', 'load_tool', 'resume_action']);
  await s.broker.resume(next, proposal.action_id);
  expect(await names(next)).not.toContain(RESUME_ACTION_TOOL.name);
  // An approval that has lapsed is not offered either, and admission refuses it.
  const lapsed = await setup();
  const held = await lapsed.approved({ body: 'lapsed' });
  await lapsed.sql`update approval set expires_at = now() - interval '1 minute'
    where action_id = ${held.action_id}`;
  const after = await lapsed.nextAttempt(lapsed.claims);
  expect((await lapsed.broker.catalog(after)).map((tool) => tool.name)).not.toContain(
    RESUME_ACTION_TOOL.name,
  );
  expect(await rejectionOf(lapsed.broker.resume(after, held.action_id))).toMatchObject({
    code: 'approval_required',
  });
  expect(lapsed.sent).toHaveLength(0);
});

dbTest("resume acts for the job's principal, and for no other", async () => {
  const s = await setup();
  const mine = recordId('own');
  const theirs = recordId('own');
  await s.sql`insert into principal (id, email) values
    (${mine}, ${`${mine}@example.test`}), (${theirs}, ${`${theirs}@example.test`})`;
  await s.sql`update space set owner_principal_id = ${mine} where id = ${s.claims.space_id}`;
  await s.sql`update job set principal_id = ${mine} where id = ${s.claims.job_id}`;
  const proposal = await s.approved({ to: 'alex@example.test', body: 'Friday works.' });
  const next = await s.nextAttempt(s.claims);

  // A capability naming somebody else is refused before admission, and sends nothing.
  const refusal = await rejectionOf(
    s.broker.resume({ ...next, principal_id: theirs }, proposal.action_id),
  );
  expect(refusal).toMatchObject({ code: 'scope_denied', message: 'principal_binding' });
  expect(s.sent).toHaveLength(0);
  expect(
    await s.sql`select id from budget_ledger where action_id = ${proposal.action_id}`,
  ).toHaveLength(0);
  expect((await loadAction(s.sql, proposal.action_id)).status).toBe('approved');

  // The principal the job names carries the same approval out, once.
  const resumed = await s.broker.resume({ ...next, principal_id: mine }, proposal.action_id);
  expect(resumed).toMatchObject({ action_id: proposal.action_id, status: 'succeeded' });
  expect(s.sent).toEqual([{ body: 'Friday works.', to: 'alex@example.test' }]);
});
