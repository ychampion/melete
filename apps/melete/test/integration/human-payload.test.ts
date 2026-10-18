import { afterAll, describe, expect, test } from 'bun:test';
import { type ConnectorManifest, canonicalizePayload } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const manifest: ConnectorManifest = {
  name: 'texts',
  provider: 'test',
  version: '0.1.0',
  description: 'An outgoing-message fixture',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'sms.send',
      description: 'Send a text',
      input_schema: { type: 'object' },
      effect_class: 'write_external',
      required_scopes: ['sms.send'],
      requires_approval: true,
      verify: false,
    },
  ],
};

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const seed = await seedJob(fixture.sql, { scopes: ['sms.send'] });
  const connector: Connector = {
    manifest,
    async execute() {
      throw new Error('nothing is sent in these tests');
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  const broker = new BrokerService({
    sql: fixture.sql,
    connectors: { get: (id: string) => (id === seed.connectionId ? connector : undefined) },
  });
  const said = (text: string) => fixture.sql`insert into event (job_id, type, payload, dedup_key)
    values (${seed.claims.job_id}, 'notice', ${JSON.stringify({ kind: 'user_message', text })}::jsonb,
      ${`said:${recordId('evt')}`})`;
  const propose = (body: string, verbatim = false) =>
    broker.propose(
      seed.claims,
      { kind: 'sms.send', connection_id: seed.connectionId, payload: { to: '+15550100', body } },
      false,
      verbatim,
    );
  /** The proposal's stored text, and whether its hash and approval bind exactly that text. */
  const stored = async (proposal: Awaited<ReturnType<typeof propose>>) => {
    const [action] =
      await fixture.sql`select canonical_payload, payload_hash from action where id = ${proposal.action_id}`;
    const [approval] =
      await fixture.sql`select payload_hash from approval where action_id = ${proposal.action_id}`;
    const payload = action?.canonical_payload as { body: string };
    expect(action?.payload_hash).toBe(canonicalizePayload(payload).hash);
    expect(approval?.payload_hash).toBe(action?.payload_hash);
    expect(proposal.payload_hash).toBe(action?.payload_hash);
    return payload.body;
  };
  return { ...seed, broker, said, propose, stored, sql: fixture.sql };
}

describe("a message's words", () => {
  databaseTest(
    'the model wrote lose their dashes, and the approval binds the final text',
    async () => {
      const s = await setup();
      const proposal = await s.propose('Running late — ten minutes.');
      expect(await s.stored(proposal)).toBe('Running late, ten minutes.');
    },
  );

  databaseTest('the person typed are sent as they typed them', async () => {
    const s = await setup();
    await s.said('Text Sam exactly this: Running late — ten minutes, sorry!');
    const proposal = await s.propose('Running late — ten minutes, sorry!');
    expect(await s.stored(proposal)).toBe('Running late — ten minutes, sorry!');
  });

  databaseTest("keep the person's own line and pass the model's lines around it", async () => {
    const s = await setup();
    await s.said('Tell her: the keys are under the mat — the blue one.');
    const proposal = await s.propose(
      'Hi Ana — a note from Sam:\nThe keys are under the mat — the blue one.',
    );
    expect(await s.stored(proposal)).toBe(
      'Hi Ana, a note from Sam:\nThe keys are under the mat — the blue one.',
    );
  });

  databaseTest('in an owner command go as the person or their assistant wrote them', async () => {
    const s = await setup();
    await s.sql`update job set experience_command_key = ${`send:${recordId('req')}`}
      where id = ${s.claims.job_id}`;
    const proposal = await s.propose('Running late — ten minutes.');
    expect(await s.stored(proposal)).toBe('Running late — ten minutes.');
  });

  databaseTest('in a follow-up of an approved message go word for word', async () => {
    const s = await setup();
    const proposal = await s.propose('Following up on my message below.\n\nLate — sorry.', true);
    expect(await s.stored(proposal)).toBe('Following up on my message below.\n\nLate — sorry.');
  });
});
