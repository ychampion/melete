/**
 * Public web reads end to end against a real database: a conversation reads a
 * public page through the broker, the space's setting and a private space or
 * agent turn that off, other work keeps to the sites it was given, writes are
 * refused, and the receipt keeps the address without its secrets.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { agentResponse, type CapabilityClaims, type JsonObject } from '@melete/contracts';
import { BrokerFault } from '../../src/broker/errors.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import {
  createWebConnector,
  databasePublicReads,
  PUBLIC_READS_OFF,
  type ResolvedAddress,
  type WebTransport,
} from '../../src/connectors/web.ts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { defaultBudget, rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const SLOW = 30_000;
const database = () => {
  if (!handle) throw new Error('Postgres unavailable');
  return handle.sql;
};

const PUBLIC: ResolvedAddress = { address: '93.184.215.14', family: 4 };
const requests: string[] = [];
const transport: WebTransport = async (url) => {
  requests.push(url.href);
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<html><head><title>Example Domain</title><script>SCRIPT_SECRET</script></head><body><p>Readable words.</p></body></html>',
  };
};

/** Spaces and agents the privacy settings mark private, as the privacy router would answer. */
const privateSpaces = new Set<string>();
const privateAgents = new Set<string>();
let privacyAnswers = true;

const spaceId = newId('sp');
const ownerId = newId('own');
const webConnection = recordId('conn');
const token = randomBytes(32).toString('base64url');
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;

async function request(path: string, method = 'GET', body?: unknown) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const broker = handle
  ? new BrokerService({
      sql: handle.sql,
      connectors: new ConnectorRegistry().register(
        webConnection,
        createWebConnector({
          resolve: async () => [PUBLIC],
          transport,
          publicReads: databasePublicReads({
            sql: handle.sql,
            connectionId: webConnection,
            privateContext: async ({ spaceId: space, agentId }) => {
              if (!privacyAnswers) throw new Error('privacy settings unreadable');
              return privateSpaces.has(space) || (agentId !== null && privateAgents.has(agentId));
            },
          }),
        }),
      ),
    })
  : null;

if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'web-reads@example.test' });
  await handle.sql`insert into principal (id, email, password_hash)
    select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await handle.sql`insert into connection (id, space_id, provider, label, scopes, configuration)
    values (${webConnection}, ${spaceId}, 'web', 'Web', '["web.fetch"]'::jsonb,
      '{"builtin":"web"}'::jsonb)`;
}

/** An agent made the way a person makes one; every conversation has one. */
async function makeAgent(): Promise<string> {
  const made = await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent);
  expect(made.status).toBe(200);
  return agentResponse.parse(await made.json()).agent.id;
}
let defaultAgent: string | undefined;

/** A running job of `kind` with an open attempt, and the claims its runtime holds. */
async function running(
  kind: 'chat' | 'routine' | 'responsibility',
  options: { agentId?: string; allowedDomains?: string[] } = {},
): Promise<CapabilityClaims> {
  if (!handle) throw new Error('Postgres unavailable');
  const jobId = recordId('job');
  const attemptId = recordId('att');
  if (kind === 'chat' && !options.agentId && !defaultAgent) defaultAgent = await makeAgent();
  const agentId = options.agentId ?? (kind === 'chat' ? (defaultAgent ?? null) : null);
  await handle.sql`insert into job (id, space_id, principal_id, title, objective, kind, agent_id,
      state, lease_epoch, budget, constraints)
    values (${jobId}, ${spaceId}, ${ownerId}, 'Look something up', 'Read a page', ${kind},
      ${agentId}, 'running', 1, ${JSON.stringify(defaultBudget)}::jsonb,
      ${JSON.stringify({ public_compartment: false, allowed_domains: options.allowedDomains ?? [] })}::jsonb)`;
  await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
  return {
    job_id: jobId,
    attempt_id: attemptId,
    space_id: spaceId,
    principal_id: ownerId,
    membership_generation: 0,
    epoch: 1,
    revision: 0,
    scopes: ['web.fetch'],
    budget: {
      max_actions: defaultBudget.max_actions,
      max_output_tokens: defaultBudget.max_output_tokens,
      max_usd_est: defaultBudget.max_usd_est,
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** Propose a read and see it through to where it rests. */
async function fetchAs(claims: CapabilityClaims, payload: JsonObject) {
  if (!broker || !handle) throw new Error('Postgres unavailable');
  const proposal = await broker.propose(claims, {
    kind: 'web.fetch',
    connection_id: webConnection,
    payload,
  });
  if (proposal.status === 'admitted') await broker.dispatch(proposal.action_id);
  const [row] = await handle.sql`select status, receipt, canonical_payload
    from action where id = ${proposal.action_id}`;
  return row as { status: string; receipt: { detail: Record<string, unknown> } | null };
}

async function refusedAs(claims: CapabilityClaims, payload: JsonObject) {
  const error = await rejectionOf(fetchAs(claims, payload));
  expect(error).toBeInstanceOf(BrokerFault);
  return error as BrokerFault;
}

withDb('public web reads', () => {
  afterAll(async () => {
    await handle?.close();
  }, 30_000);

  test(
    'a conversation reads a public page, and the receipt keeps the address without secrets',
    async () => {
      const claims = await running('chat');
      const before = requests.length;
      const row = await fetchAs(claims, {
        url: 'https://example.com/?q=news&api_key=live-key-123&token=abc',
      });
      expect(row.status).toBe('succeeded');
      expect(requests.slice(before)).toEqual([
        'https://example.com/?q=news&api_key=live-key-123&token=abc',
      ]);
      const detail = row.receipt?.detail ?? {};
      expect(detail).toMatchObject({
        url: 'https://example.com/?q=news&api_key=%5Bredacted%5D&token=%5Bredacted%5D',
        title: 'Example Domain',
        body: 'Readable words.',
        status: 200,
      });
      expect(JSON.stringify(row.receipt)).not.toContain('live-key-123');
      expect(JSON.stringify(row.receipt)).not.toContain('SCRIPT_SECRET');
    },
    SLOW,
  );

  test(
    'writing methods and private addresses are refused before anything is recorded',
    async () => {
      const claims = await running('chat');
      const before = requests.length;
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const refused = await refusedAs(claims, { url: 'https://example.com/login', method });
        expect(['payload_invalid', 'schema_invalid']).toContain(refused.code);
      }
      for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:3100/',
        'http://[::ffff:10.0.0.1]/',
        'http://2130706433/',
        'file:///etc/passwd',
      ]) {
        const refused = await refusedAs(claims, { url });
        expect(refused.code).toBe('scope_denied');
      }
      expect(requests.length).toBe(before);
      const [{ count }] = (await database()`select count(*)::int as count from action
        where job_id = ${claims.job_id}`) as unknown as [{ count: number }];
      expect(count).toBe(0);
    },
    SLOW,
  );

  test(
    'other work reads only the sites it was given',
    async () => {
      for (const kind of ['routine', 'responsibility'] as const) {
        const refused = await refusedAs(await running(kind), { url: 'https://example.com/' });
        expect(refused.message).toContain('Only conversations');
      }
      const listed = await running('routine', { allowedDomains: ['example.com'] });
      expect((await fetchAs(listed, { url: 'https://example.com/' })).status).toBe('succeeded');
    },
    SLOW,
  );

  test(
    'Settings turns web reads off and on for the space, and a turned-off space reads nothing',
    async () => {
      const shown = await request('/web/settings');
      expect(shown.status).toBe(200);
      expect(await shown.json()).toEqual({ enabled: true, available: true });

      const off = await request('/web/settings', 'PUT', { enabled: false });
      expect(await off.json()).toEqual({ enabled: false, available: true });
      const [row] = (await database()`select configuration from connection
        where id = ${webConnection}`) as unknown as [{ configuration: Record<string, unknown> }];
      expect(row.configuration).toEqual({ builtin: 'web', public_reads: false });
      const refused = await refusedAs(await running('chat'), { url: 'https://example.com/' });
      expect(refused.message).toBe(PUBLIC_READS_OFF);
      // A site the job was explicitly given is still read.
      const listed = await running('chat', { allowedDomains: ['example.com'] });
      expect((await fetchAs(listed, { url: 'https://example.com/' })).status).toBe('succeeded');

      // Dispatch asks the database again, so a change after admission applies
      // to the next request and to every redirect: nothing is remembered.
      const raced = await running('chat');
      const policy = databasePublicReads({ sql: database(), connectionId: webConnection });
      const scope = { jobId: raced.job_id, spaceId };
      expect(await policy(undefined, scope)).toBe(PUBLIC_READS_OFF);
      await request('/web/settings', 'PUT', { enabled: true });
      expect(await policy(undefined, scope)).toBeNull();
      await request('/web/settings', 'PUT', { enabled: false });
      expect(await policy(undefined, scope)).toBe(PUBLIC_READS_OFF);

      const on = await request('/web/settings', 'PUT', { enabled: true });
      expect(await on.json()).toEqual({ enabled: true, available: true });
      expect((await fetchAs(await running('chat'), { url: 'https://example.com/' })).status).toBe(
        'succeeded',
      );
      const invalid = await request('/web/settings', 'PUT', { enabled: 'yes' });
      expect(invalid.status).toBe(400);
    },
    SLOW,
  );

  test(
    'a private space or a private agent stays offline, and an unreadable privacy check fails closed',
    async () => {
      privateSpaces.add(spaceId);
      try {
        const refused = await refusedAs(await running('chat'), { url: 'https://example.com/' });
        expect(refused.message).toContain('private');
      } finally {
        privateSpaces.delete(spaceId);
      }

      const persona = { id: await makeAgent() };
      privateAgents.add(persona.id);
      try {
        const refused = await refusedAs(await running('chat', { agentId: persona.id }), {
          url: 'https://example.com/',
        });
        expect(refused.message).toContain('private');
        // Another agent in the same space still reads.
        expect((await fetchAs(await running('chat'), { url: 'https://example.com/' })).status).toBe(
          'succeeded',
        );
      } finally {
        privateAgents.delete(persona.id);
      }

      privacyAnswers = false;
      try {
        const refused = await refusedAs(await running('chat'), { url: 'https://example.com/' });
        expect(refused.message).toContain('private');
      } finally {
        privacyAnswers = true;
      }
    },
    SLOW,
  );
});
