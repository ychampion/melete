/**
 * What an assistant's grant cannot do once its footing is gone, and what it
 * cannot get past: every tool after the member leaves, a code or a removed
 * space, simultaneous sends against the waiting limit, names on the consent
 * page, and a saved detail replacing one the person stated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordId } from '../../src/broker/records.ts';
import type { BrokerService } from '../../src/broker/service.ts';
import type { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { mcpServerAddresses, OAuthError, OAuthStore } from '../../src/mcp-server/oauth.ts';
import { TOOL_CALLS_PER_MINUTE } from '../../src/mcp-server/routes.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-mcp-grant-'));
const PUBLIC = 'https://melete.example';
const addresses = mcpServerAddresses(PUBLIC);
if (!addresses) throw new Error('Expected addresses');
const app =
  handle && jobs
    ? createApp({
        db: handle.db,
        sql: handle.sql,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root, MELETE_PUBLIC_URL: PUBLIC }),
        jobs,
        memory: { sql: handle.sql, journal: { read: async () => [], append: async () => {} } },
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const REDIRECT = 'http://127.0.0.1:40111/callback';

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
const sql = () => required(handle).sql;
const store = () => new OAuthStore(sql(), required(addresses));
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OAuthError) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal');
}

let cookie = '';
let ownerId = '';
let personalId = '';
async function signedIn() {
  if (cookie) return;
  const setup = await required(app).request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'grant@example.test', password: 'a-long-enough-password' }),
  });
  expect(setup.status).toBe(201);
  cookie =
    setup.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session=')) ?? '';
  ownerId = ((await setup.json()) as { owner: { id: string } }).owner.id;
  const spaces = (await (
    await required(app).request('/spaces', { headers: { Cookie: cookie } })
  ).json()) as { spaces: Array<{ id: string; kind: string }> };
  personalId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
}
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function connect(grant: {
  principalId: string;
  spaceId: string;
  membershipGeneration: number;
}) {
  const client = await store().register({ client_name: 'Probe', redirect_uris: [REDIRECT] });
  const { verifier, challenge } = pkce();
  const code = await store().issueCode({
    clientId: client.client_id,
    ...grant,
    resource: required(addresses).resource,
    scope: 'melete',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await store().exchangeCode({
    code,
    clientId: client.client_id,
    redirectUri: REDIRECT,
    verifier,
  });
  return { clientId: client.client_id, ...pair };
}
const rpc = (token: string, body: unknown) =>
  required(app).request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const toolCall = (token: string, name: string, args: Record<string, unknown>) =>
  rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

async function member(email: string, spaceName: string) {
  await signedIn();
  const created = await required(app).request(
    '/principals',
    json({ email, password: 'member-password-long' }),
  );
  expect(created.status).toBe(201);
  const memberId = ((await created.json()) as { principal: { id: string } }).principal.id;
  const shared = await required(app).request('/spaces/shared', json({ name: spaceName }));
  expect(shared.status).toBe(201);
  const sharedId = ((await shared.json()) as { space: { id: string } }).space.id;
  expect(
    (
      await required(app).request(
        `/spaces/${sharedId}/memberships`,
        json({ principal_id: memberId }),
      )
    ).status,
  ).toBe(201);
  const generation = async () =>
    Number(
      (
        await sql()`select generation from space_membership
          where space_id = ${sharedId} and principal_id = ${memberId}`
      )[0]?.generation,
    );
  return { memberId, sharedId, generation };
}

withDb('a grant ends with the footing it was given on', () => {
  test('after the member leaves, every tool answers 401 and nothing is recorded', async () => {
    const { memberId, sharedId, generation } = await member('m1@example.test', 'Flat A');
    const pair = await connect({
      principalId: memberId,
      spaceId: sharedId,
      membershipGeneration: await generation(),
    });
    expect((await toolCall(pair.access_token, 'waiting_on', {})).status).toBe(200);
    const revoked = await required(app).request(
      `/spaces/${sharedId}/memberships/${memberId}`,
      json(undefined, 'DELETE'),
    );
    expect(revoked.status).toBe(200);
    for (const [name, args] of [
      ['safe_send', { to: 'x@example.test', subject: 's', body: 'b' }],
      ['remember', { topic: 'a', name: 'b', value: 'c' }],
      ['recall', { query: 'a' }],
      ['handle', { item_id: 'item_x' }],
      ['status', { job_id: 'job_x' }],
      ['waiting_on', {}],
    ] as const) {
      const response = await toolCall(pair.access_token, name, args as Record<string, unknown>);
      expect(`${name}:${response.status}`).toBe(`${name}:401`);
    }
    expect(
      await sql()`select id from job where space_id = ${sharedId} and principal_id = ${memberId}`,
    ).toHaveLength(0);
  });

  test('a code issued before revocation cannot be exchanged after it', async () => {
    const { memberId, sharedId, generation } = await member('m2@example.test', 'Flat B');
    const client = await store().register({ client_name: 'Probe', redirect_uris: [REDIRECT] });
    const { verifier, challenge } = pkce();
    const code = await store().issueCode({
      clientId: client.client_id,
      principalId: memberId,
      spaceId: sharedId,
      membershipGeneration: await generation(),
      resource: required(addresses).resource,
      scope: 'melete',
      redirectUri: REDIRECT,
      codeChallenge: challenge,
    });
    await required(app).request(
      `/spaces/${sharedId}/memberships/${memberId}`,
      json(undefined, 'DELETE'),
    );
    expect(
      await refusal(
        store().exchangeCode({ code, clientId: client.client_id, redirectUri: REDIRECT, verifier }),
      ),
    ).toBe('invalid_grant');
  });

  test('a space under removal ends the grant at once, before the sessions phase', async () => {
    const { memberId, sharedId, generation } = await member('m3@example.test', 'Flat C');
    const pair = await connect({
      principalId: memberId,
      spaceId: sharedId,
      membershipGeneration: await generation(),
    });
    expect((await toolCall(pair.access_token, 'waiting_on', {})).status).toBe(200);
    await sql()`update space set removed_at = now() where id = ${sharedId}`;
    expect((await toolCall(pair.access_token, 'waiting_on', {})).status).toBe(401);
    const [row] = await sql()`select revoked_at from mcp_token
      where client_id = ${pair.clientId} and kind = 'refresh'`;
    expect(row?.revoked_at).not.toBeNull();
    await sql()`update space set removed_at = null where id = ${sharedId}`;
    expect((await toolCall(pair.access_token, 'waiting_on', {})).status).toBe(401);
  });

  test('a personal-space grant for another person is refused, not answered', async () => {
    const { memberId } = await member('m4@example.test', 'Flat D');
    // A grant naming someone else's personal space (never issued by consent,
    // but the check must not depend on that).
    const pair = await connect({
      principalId: memberId,
      spaceId: personalId,
      membershipGeneration: 0,
    });
    expect((await toolCall(pair.access_token, 'waiting_on', {})).status).toBe(401);
  });

  test('the tool-call limit does not block a refresh, and a refresh does not reset it', async () => {
    await signedIn();
    const pair = await connect({
      principalId: ownerId,
      spaceId: personalId,
      membershipGeneration: 0,
    });
    for (let index = 0; index < TOOL_CALLS_PER_MINUTE; index++)
      await toolCall(pair.access_token, 'status', { job_id: '..' });
    expect((await toolCall(pair.access_token, 'status', { job_id: '..' })).status).toBe(429);
    const refreshed = await required(app).request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: pair.clientId,
        refresh_token: pair.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect((await toolCall(next.access_token, 'status', { job_id: '..' })).status).toBe(429);
  });
});

withDb('the waiting limit holds for simultaneous sends', () => {
  const setupEffects = async (delayMs: number) => {
    await signedIn();
    const connectionId = recordId('conn');
    await sql()`insert into connection (id, space_id, provider, label, scopes)
      values (${connectionId}, ${personalId}, 'email', 'Mail', ${JSON.stringify(['email.send'])}::jsonb)`;
    const registry = {
      get: () => ({ manifest: { tools: [{ name: 'email.send', required_scopes: [] }] } }),
    } as unknown as ConnectorRegistry;
    // A broker that takes a moment to propose, as the real one does (trust
    // resolution, policy, approvals), and then leaves the action waiting.
    const broker = {
      propose: async (
        claims: { job_id: string; attempt_id: string },
        request: { connection_id: string; payload: unknown },
      ) => {
        await Bun.sleep(delayMs);
        const id = recordId('act');
        await sql()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, status, idempotency_key)
          values (${id}, ${claims.job_id}, ${claims.attempt_id}, ${request.connection_id}, 'email.send',
          'write_external', ${JSON.stringify(request.payload)}::jsonb,
          ${createHash('sha256').update(id).digest('hex')}, 'needs_approval', ${id})`;
        return { action_id: id };
      },
    } as unknown as BrokerService;
    return { effects: new ExperienceEffects(sql(), broker, registry), connectionId };
  };
  const waiting = async () =>
    Number(
      (
        await sql()`select count(*)::int as n from job j join action a on a.job_id = j.id
          where j.principal_id = ${ownerId} and starts_with(j.experience_command_key, 'mcp:send:')
          and a.status in ('proposed', 'needs_approval')`
      )[0]?.n,
    );

  test('ten simultaneous safe_sends leave at most five waiting', async () => {
    const { effects, connectionId } = await setupEffects(150);
    await sql()`update action set status = 'denied_test' where job_id in
      (select id from job where principal_id = ${ownerId})`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        effects.proposeSend({
          spaceId: personalId,
          principalId: ownerId,
          membershipGeneration: 0,
          connectionId,
          payload: { to: ['a@example.test'], subject: `Note ${index}`, body: `Body ${index}` },
          assistant: 'Probe',
          assistantClientId: 'mcpc_race',
        }),
      ),
    );
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await waiting()).toBeLessThanOrEqual(5);
  });
});

withDb('names on the consent page', () => {
  test('a shared space name cannot inject markup into the consent page', async () => {
    await signedIn();
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const shared = await required(app).request('/spaces/shared', json({ name: evil }));
    expect(shared.status).toBe(201);
    const sharedId = ((await shared.json()) as { space: { id: string } }).space.id;
    const [membership] = await sql()`select generation from space_membership
      where space_id = ${sharedId} and principal_id = ${ownerId}`;
    await sql()`update session set space_id = ${sharedId},
      membership_generation = ${membership ? Number(membership.generation) : null}
      where coalesce(principal_id, owner_id) = ${ownerId}`;
    const client = await store().register({
      client_name: '<script>x</script>',
      redirect_uris: [REDIRECT],
    });
    const { challenge } = pkce();
    const html = await (
      await required(app).request(
        `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })}`,
        { headers: { Cookie: cookie } },
      )
    ).text();
    expect(html).toContain('in the shared space <strong>&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x');
    await sql()`update session set space_id = ${personalId}, membership_generation = null
      where coalesce(principal_id, owner_id) = ${ownerId}`;
  });
});

withDb("a saved detail does not borrow the person's word", () => {
  test("an assistant's new value for a key the person answered is inferred", async () => {
    await signedIn();
    await provisionMemorySpace(sql(), ownerId, personalId);
    await sql()`update memory_spaces set restore_ready = true where space_id = ${personalId}`;
    const stated = await required(app).request(
      '/memory/items',
      json({ key: 'pref.contacts.landlord', value: 'real@landlord.example' }),
    );
    expect([200, 201]).toContain(stated.status);
    const pair = await connect({
      principalId: ownerId,
      spaceId: personalId,
      membershipGeneration: 0,
    });
    const planted = await toolCall(pair.access_token, 'remember', {
      topic: 'contacts',
      name: 'landlord',
      value: 'attacker@evil.example',
    });
    expect(planted.status).toBe(200);
    const [head] = await sql()`select r.origin_trust from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      where c.space_id = ${personalId} and c.key = 'pref.contacts.landlord'`;
    expect(head).toMatchObject({ origin_trust: 'inferred' });
    // Saying the same value the person said, from the assistant, does not raise it either.
    await toolCall(pair.access_token, 'remember', {
      topic: 'contacts',
      name: 'landlord',
      value: 'real@landlord.example',
    });
    const [again] = await sql()`select r.origin_trust from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      where c.space_id = ${personalId} and c.key = 'pref.contacts.landlord'`;
    expect(again?.origin_trust).toBe('inferred');
    const recalled = (await (
      await toolCall(pair.access_token, 'recall', { query: 'landlord' })
    ).json()) as { result: { structuredContent?: { matches: Array<{ source: string }> } } };
    expect(recalled.result.structuredContent?.matches?.[0]?.source).toBe('inferred');
  });
});
