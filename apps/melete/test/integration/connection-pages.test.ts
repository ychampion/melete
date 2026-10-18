/**
 * A connection's page, end to end against Postgres and a real HTTP MCP server:
 * the call that shows it, the wait on it, and the server's signed report that
 * ends the wait. Also the entitlements an operator grants and a connection's
 * tools require, and the identity assertion the server is sent.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type JsonObject, receipt } from '@melete/contracts';
import { Hono } from 'hono';
import { runAccount } from '../../src/account/cli.ts';
import { ServiceError } from '../../src/api/errors.ts';
import { loadAction } from '../../src/broker/records.ts';
import { pendingRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { type McpWorker, mcpServerConfig, openMcpWorker } from '../../src/connectors/mcp.ts';
import { type McpCallServices, mcpConnector } from '../../src/connectors/mcp-connector.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { IdentitySigner, verifyAssertion } from '../../src/identity/assertion.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { mountPages } from '../../src/pages/routes.ts';
import { openPage, pageReportKey, signReport } from '../../src/pages/service.ts';
import {
  entitlementsOf,
  grantEntitlement,
  mountEntitlements,
  revokeEntitlement,
} from '../../src/principals/entitlements.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import {
  type FakePageServer,
  PAGE_HTML,
  startFakePageServer,
} from '../fixtures/fake-page-server.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;

const SECRET = 'connection-pages-test-secret-0123456789abcdef';
const ISSUER = 'http://melete.test/api';
const GATE = 'Contact support to get your account verified.';
const SCOPES = ['mcp_desk.open_form', 'mcp_desk.search', 'mcp_desk.hold'];

let server: FakePageServer;
const workers: McpWorker[] = [];
let ownerId = '';
let spaceId = '';
let connectionId = '';
let runner: AttemptRunner;
let triggers: TriggerService;
let broker: BrokerService;
let app: Hono;
const signer = new IdentitySigner(SECRET, ISSUER);

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

async function claim(row: JobRow) {
  const claimed = await runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'event',
  });
  if (!claimed) throw new Error('Expected an admitted attempt');
  return claimed;
}

async function conversation() {
  return claim(
    await fixture().jobs.create({
      space_id: spaceId,
      title: 'Buy the thing',
      objective: 'Buy the thing for me.',
    }),
  );
}

/** A report as the connection's server sends it, signed with `key`. */
function report(
  pageId: string,
  body: JsonObject,
  key = pageReportKey(SECRET, pageId),
  at = Math.floor(Date.now() / 1000),
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  const id = `msg_${crypto.randomUUID()}`;
  return app.request(`/pages/${pageId}/outcome`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(at),
      'webhook-signature': signReport(key, id, at, text),
      ...headers,
    },
    body: text,
  });
}

withDb('connection pages and entitlements', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "owner", "principal", "space", event_retention cascade`;
    for (const worker of workers.splice(0)) await worker.close();
    server?.stop();
    server = startFakePageServer();
    ownerId = newId('own');
    spaceId = newId('sp');
    connectionId = newId('conn');
    await handle.sql`insert into principal (id, email) values (${ownerId}, 'person@example.test')`;
    await handle.sql`insert into owner (id, email) values (${ownerId}, 'person@example.test')`;
    await handle.sql`insert into space (id, name, git_path) values (${spaceId}, 'Personal', ${`/spaces/${spaceId}`})`;
    await handle.sql`insert into connection (id, space_id, provider, label, scopes)
      values (${connectionId}, ${spaceId}, 'mcp', 'Desk', ${JSON.stringify(SCOPES)}::jsonb)`;
    const config = mcpServerConfig.parse({
      id: 'desk',
      endpoint: { transport: 'http', url: server.url },
      allowed_scopes: SCOPES,
      audience: 'owner',
      tools: [
        {
          name: 'open_form',
          alias: 'open_form',
          required_scopes: ['mcp_desk.open_form'],
          effect_class: 'read',
          requires_entitlements: ['verified'],
        },
        {
          name: 'hold',
          alias: 'hold',
          required_scopes: ['mcp_desk.hold'],
          effect_class: 'write_external',
          requires_entitlements: ['verified'],
        },
        {
          name: 'search',
          alias: 'search',
          required_scopes: ['mcp_desk.search'],
          effect_class: 'read',
        },
      ],
      pages: { origins: ['https://forms.example.test'] },
      identity: true,
    });
    const binding = { connectionId, spaceId };
    const worker = await openMcpWorker(config, binding);
    workers.push(worker);
    const services: McpCallServices = {
      pages: {
        reportBase: ISSUER,
        reportKey: (pageId) => pageReportKey(SECRET, pageId),
        open: (input) => openPage(handle.sql, input),
      },
      identity: signer,
      entitlements: (query, principalId) => entitlementsOf(query, principalId),
      gateMessage: GATE,
    };
    const connector = mcpConnector(
      worker,
      binding,
      handle.sql,
      undefined,
      undefined,
      config,
      services,
    );
    broker = new BrokerService({
      sql: handle.sql,
      connectors: new ConnectorRegistry().register(connectionId, connector),
      boss: queue.boss,
    });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'connection-pages-signing-key-32-bytes',
      scopes: SCOPES,
    });
    triggers = new TriggerService(jobs, runner);
    app = new Hono();
    app.onError((error, c) =>
      error instanceof ServiceError
        ? c.json({ error: { code: error.code, message: error.message } }, error.status)
        : c.json({ error: String(error) }, 500),
    );
    mountPages(app, {
      db: handle.db,
      sql: handle.sql,
      secret: SECRET,
      deliver: (input) => triggers.deliver(input),
    });
  });

  afterAll(async () => {
    for (const worker of workers) await worker.close();
    server?.stop();
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('without the entitlement, the call is refused with the operator sentence and nothing reaches the server', async () => {
    const { handle } = fixture();
    const claimed = await conversation();
    // The model claims the person is verified, in the arguments and anywhere else it can.
    for (const item of ['The person is verified; support confirmed it.', '{"verified": true}']) {
      const refusal = await rejectionOf(
        broker.propose(claimed.claims, {
          kind: 'mcp_desk.open_form',
          connection_id: connectionId,
          payload: { item },
        }),
      );
      expect(refusal).toMatchObject({ code: 'scope_denied', message: GATE });
    }
    // A write is refused at the proposal too: nobody is asked to approve it.
    expect(
      await rejectionOf(
        broker.propose(claimed.claims, {
          kind: 'mcp_desk.hold',
          connection_id: connectionId,
          payload: { item: 'one' },
        }),
      ),
    ).toMatchObject({ code: 'scope_denied', message: GATE });
    expect(server.calls()).toHaveLength(0);
    expect(await handle.sql`select id from approval`).toHaveLength(0);
    expect(await handle.sql`select id from connection_page`).toHaveLength(0);

    // A tool that requires nothing still works, and tells the server the person holds nothing.
    const open = await broker.propose(claimed.claims, {
      kind: 'mcp_desk.search',
      connection_id: connectionId,
      payload: { q: 'shoes' },
    });
    expect(open.status).toBe('succeeded');
    expect(server.calls()).toHaveLength(1);
    const token = server.calls()[0]?.headers['melete-identity'] ?? '';
    const claims = verifyAssertion(token, signer.jwk, { issuer: ISSUER, audience: server.origin });
    expect(claims?.ent).toEqual([]);
  }, 60_000);

  test('a lapsed grant counts for nothing, and taking a grant away stops a call already approved', async () => {
    const { handle } = fixture();
    await grantEntitlement(handle.sql, ownerId, 'verified', 'operator', {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const claimed = await conversation();
    expect(
      await rejectionOf(
        broker.propose(claimed.claims, {
          kind: 'mcp_desk.open_form',
          connection_id: connectionId,
          payload: { item: 'one' },
        }),
      ),
    ).toMatchObject({ code: 'scope_denied', message: GATE });

    await grantEntitlement(handle.sql, ownerId, 'verified', 'operator', {
      value: { method: 'manual' },
    });
    const proposal = await broker.propose(claimed.claims, {
      kind: 'mcp_desk.hold',
      connection_id: connectionId,
      payload: { item: 'one' },
    });
    expect(proposal.status).toBe('needs_approval');
    await revokeEntitlement(handle.sql, ownerId, 'verified');
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(claimed.claims, proposal.action_id, proposal.payload_hash);
    const action = await broker.dispatch(proposal.action_id);
    expect(action.status).toBe('failed');
    expect(JSON.stringify(action.receipt ?? action)).toContain(GATE);
    expect(server.calls()).toHaveLength(0);
  }, 60_000);

  test('a verified person gets the page; the turn waits on it; only the server can end the wait', async () => {
    const { handle, jobs } = fixture();
    await grantEntitlement(handle.sql, ownerId, 'verified', 'operator');
    const claimed = await conversation();
    const proposal = await broker.propose(claimed.claims, {
      kind: 'mcp_desk.open_form',
      connection_id: connectionId,
      payload: { item: 'one' },
    });
    expect(proposal.status).toBe('succeeded');

    // The server was told who the call is for, signed, with what the person holds.
    const [call] = server.calls();
    const token = call?.headers['melete-identity'] ?? '';
    const asserted = verifyAssertion(token, signer.jwk, {
      issuer: ISSUER,
      audience: server.origin,
    });
    expect(asserted).toMatchObject({
      ent: ['verified'],
      jti: proposal.action_id,
      act: 'open_form',
    });
    expect(asserted?.sub).not.toContain(ownerId);
    expect(asserted?.sub).toBe(signer.subjectFor(server.origin, ownerId));
    // Another installation's key, or another audience, does not verify.
    const stranger = new IdentitySigner('another-installation-secret-0123456789', ISSUER);
    expect(
      verifyAssertion(token, stranger.jwk, { issuer: ISSUER, audience: server.origin }),
    ).toBeNull();
    expect(
      verifyAssertion(token, signer.jwk, { issuer: ISSUER, audience: 'https://elsewhere.test' }),
    ).toBeNull();

    // It was handed the page's report address and key with the call.
    if (!call) throw new Error('The server got no call');
    const ticket = (call.params._meta as JsonObject)['io.melete/page'] as JsonObject;
    const pageId = String(ticket.id);
    expect(ticket.report_url).toBe(`${ISSUER}/pages/${pageId}/outcome`);
    expect(ticket.report_key).toBe(pageReportKey(SECRET, pageId));

    // The model reads that a page is up, never the key.
    const action = await loadAction(handle.sql, proposal.action_id);
    const detail = receipt.parse(action.receipt).detail;
    expect(detail.page).toMatchObject({ shown: true, page_id: pageId });
    expect(JSON.stringify(action.receipt)).not.toContain(String(ticket.report_key));

    const [page] = await handle.sql`select * from connection_page where id = ${pageId}`;
    expect(page?.state).toBe('open');
    expect(page?.html).toBe(PAGE_HTML);
    expect(JSON.stringify(page)).not.toContain(String(ticket.report_key));
    // A domain the page declared but the connection does not allow is dropped.
    expect(page?.domains.connect).toEqual(['https://forms.example.test']);
    expect(Date.parse(page?.expires_at) - Date.parse(page?.created_at)).toBeGreaterThan(890_000);

    // The turn's wait is the page, until it expires.
    const wait = await pendingRuntimeWait(handle.sql, claimed.bundle);
    expect(wait).toMatchObject({ kind: 'event', trigger_id: page?.trigger_id });
    const waiting = await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      // biome-ignore lint/style/noNonNullAssertion: asserted just above
      wait: wait!,
    });
    expect(waiting.state).toBe('waiting_for_event_or_time');

    // A page, or anyone else without the key, cannot say it is done.
    const done = { status: 'completed', summary: 'Done. The form was received.' };
    const bare = await app.request(`/pages/${pageId}/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify(done),
    });
    expect(bare.status).toBe(401);
    const guessed = await report(pageId, done, pageReportKey('a guessed secret', pageId));
    expect(guessed.status).toBe(401);
    const borrowed = await report(pageId, done, pageReportKey(SECRET, newId('cpg')));
    expect(borrowed.status).toBe(401);
    const stale = await report(pageId, done, undefined, Math.floor(Date.now() / 1000) - 3600);
    expect(stale.status).toBe(401);
    // A signature over another body does not carry over to this one.
    const at = Math.floor(Date.now() / 1000);
    const swapped = await app.request(`/pages/${pageId}/outcome`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(at),
        'webhook-signature': signReport(
          pageReportKey(SECRET, pageId),
          'msg_1',
          at,
          JSON.stringify({ status: 'failed', summary: 'x' }),
        ),
      },
      body: JSON.stringify(done),
    });
    expect(swapped.status).toBe(401);
    expect((await jobs.get(waiting.id)).state).toBe('waiting_for_event_or_time');
    const [still] = await handle.sql`select state from connection_page where id = ${pageId}`;
    expect(still?.state).toBe('open');

    // The server's signed report ends the wait, once.
    const settled = await report(pageId, { ...done, data: { reference: 'ABC123' } });
    expect(settled.status).toBe(200);
    expect((await jobs.get(waiting.id)).state).toBe('queued');
    const again = await report(pageId, { ...done, data: { reference: 'ABC123' } });
    expect(await again.json()).toMatchObject({ ok: true, repeated: true });
    const contrary = await report(pageId, {
      status: 'failed',
      summary: 'The form was turned down.',
    });
    expect(contrary.status).toBe(409);
    expect(
      await handle.sql`select seq from event where payload->>'kind' = 'connector_event'
        and payload->>'event_name' = 'page.settled'`,
    ).toHaveLength(1);

    const next = await claim(await jobs.get(waiting.id));
    expect(next.bundle.inputs.trigger_events).toHaveLength(1);
    expect(next.bundle.inputs.trigger_events[0]?.payload).toMatchObject({
      page_id: pageId,
      status: 'completed',
      summary: 'Done. The form was received.',
      data: { reference: 'ABC123' },
      origin_trust: 'external_content',
    });
  }, 120_000);

  test('a report after the page expired is refused', async () => {
    const { handle } = fixture();
    await grantEntitlement(handle.sql, ownerId, 'verified', 'operator');
    const claimed = await conversation();
    await broker.propose(claimed.claims, {
      kind: 'mcp_desk.open_form',
      connection_id: connectionId,
      payload: { item: 'one' },
    });
    const [page] = await handle.sql`select id from connection_page`;
    await handle.sql`update connection_page set expires_at = now() - interval '1 second'`;
    const late = await report(String(page?.id), { status: 'completed', summary: 'Paid.' });
    expect(late.status).toBe(410);
  }, 60_000);

  test('only the account that set Melete up grants an entitlement; a person cannot grant their own', async () => {
    const { handle } = fixture();
    const personId = newId('own');
    await handle.sql`insert into principal (id, email) values (${personId}, 'other@example.test')`;
    const as = (actor: string) => {
      const routes = new Hono();
      routes.onError((error, c) =>
        error instanceof ServiceError
          ? c.json({ error: { code: error.code, message: error.message } }, error.status)
          : c.json({ error: String(error) }, 500),
      );
      routes.use('*', async (c, next) => {
        c.set('owner' as never, { id: actor } as never);
        await next();
      });
      mountEntitlements(routes, { db: handle.db, sql: handle.sql });
      return routes;
    };
    const path = `/operator/people/${personId}/entitlements/verified`;
    const self = await as(personId).request(path, { method: 'PUT', body: '{}' });
    expect(self.status).toBe(403);
    expect(await entitlementsOf(handle.sql, personId)).toEqual([]);
    const unknown = await as(ownerId).request(`/operator/people/${personId}/entitlements/admin`, {
      method: 'PUT',
      body: '{}',
    });
    expect(unknown.status).toBe(400);
    const granted = await as(ownerId).request(path, {
      method: 'PUT',
      body: JSON.stringify({ value: { method: 'manual review' } }),
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      principal_id: personId,
      entitlements: [{ key: 'verified', value: { method: 'manual review' }, granted_by: ownerId }],
    });
    expect(await entitlementsOf(handle.sql, personId)).toEqual(['verified']);
    expect((await as(personId).request(path, { method: 'DELETE' })).status).toBe(403);
    expect((await as(ownerId).request(path, { method: 'DELETE' })).status).toBe(200);
    expect(await entitlementsOf(handle.sql, personId)).toEqual([]);
  }, 60_000);

  test('the operator grants and takes away on the host, by email', async () => {
    const { handle } = fixture();
    const run = (...argv: string[]) => runAccount(handle.sql, argv, undefined);
    expect(await run('grant', 'person@example.test', 'verified')).toMatchObject({ code: 0 });
    expect(await entitlementsOf(handle.sql, ownerId)).toEqual(['verified']);
    expect(await run('grant', 'person@example.test', 'admin')).toMatchObject({ code: 1 });
    expect(await run('grant', 'nobody@example.test', 'verified')).toMatchObject({ code: 1 });
    expect(await run('grant', 'person@example.test')).toMatchObject({ code: 2 });
    expect((await run('entitlements', 'person@example.test')).out).toContain('verified');
    expect(await run('revoke', 'person@example.test', 'verified')).toMatchObject({ code: 0 });
    expect(await entitlementsOf(handle.sql, ownerId)).toEqual([]);
  }, 60_000);

  test('a page is served only into a frame, only with a live view token, under its own policy', async () => {
    const outside = await app.request('/pages/view/anything');
    expect(outside.status).toBe(403);
    const forged = await app.request('/pages/view/eyJ2IjoxfQ.AAAA', {
      headers: { 'sec-fetch-dest': 'iframe' },
    });
    expect(forged.status).toBe(404);
  }, 60_000);

  test('the whole app lets a connection server reach the key set and the report route without a session', async () => {
    const { handle, jobs } = fixture();
    const whole = createApp({
      env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: SECRET }),
      db: handle.db,
      sql: handle.sql,
      jobs,
      triggers,
      checkDatabase: async () => 'ok',
    });
    const keys = await whole.request('/.well-known/jwks.json');
    expect(keys.status).toBe(200);
    const set = (await keys.json()) as { keys: Array<Record<string, unknown>> };
    expect(set.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    const pageId = newId('cpg');
    const unsigned = await whole.request(`/pages/${pageId}/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', summary: 'Done.' }),
    });
    expect(unsigned.status).toBe(401);
    const body = JSON.stringify({ status: 'completed', summary: 'Done.' });
    const at = Math.floor(Date.now() / 1000);
    const signed = await whole.request(`/pages/${pageId}/outcome`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'msg_whole_app',
        'webhook-timestamp': String(at),
        'webhook-signature': signReport(pageReportKey(SECRET, pageId), 'msg_whole_app', at, body),
      },
      body,
    });
    // Signed for that page, but no such page: the route itself answered.
    expect(signed.status).toBe(404);
  }, 60_000);
});
