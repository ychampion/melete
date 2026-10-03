/**
 * Connections that add tracked items to the ledger, end to end: an MCP server
 * installed over HTTP with a declared ledger feed, read through its own
 * connector, written into the owner's ledger, served by the company map,
 * Waiting on and the item route, and acted on through the connection's own
 * declared tool. The server is a local fixture standing in for a self-hosted
 * project tracker.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  companyMap,
  connectionResponse,
  ledgerItem as ledgerItemContract,
  ledgerSyncResult,
  waitingOn,
} from '@melete/contracts';
import { LedgerFeedPoller } from '../../src/companies/feeds.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import type { TriggerService } from '../../src/jobs/triggers.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '71'.repeat(32);
const password = 'a-long-enough-password';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const closers: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  for (const close of closers) await close();
  await registry.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

const NOTE = 'Thanks for the call today. We will send the signed contract back by Friday. Ana';
const PROMISE = 'We will send the signed contract back by Friday.';
const ASK = 'Could you send over the revised estimate by Thursday?';
const THREAD = `Hi, following up on the fit-out. ${ASK} Thanks, Ana`;
const at = (text: string, quote: string) => ({
  quote,
  start: text.indexOf(quote),
  end: text.indexOf(quote) + quote.length,
});

/** What the fixture tracker's feed answers; a test changes it between reads. */
let feed: Record<string, unknown> = {};
const calls: Array<{ name: string; arguments: unknown }> = [];

const baseFeed = () => ({
  sources: [
    { ref: 'note-1', title: 'Call notes', from: 'Ana', text: NOTE },
    { ref: 'thread-2', title: 'Fit-out', from: 'ana@harbour.example', text: THREAD },
  ],
  items: [
    {
      ref: 'deal-4',
      kind: 'commitment',
      direction: 'owed_to_you',
      summary: 'Signed contract back from Harbour',
      counterparty: { name: 'Harbour Studio', domain: 'harbour.example' },
      parties: [{ name: 'Ana', role: 'client' }],
      state: 'waiting on them',
      next_step: 'Nudge Ana on Monday',
      due_at: '2026-10-03T00:00:00.000Z',
      due_date_only: true,
      evidence: [{ source: 'note-1', ...at(NOTE, PROMISE) }],
      actions: [
        { id: 'nudge', label: 'Nudge them', tool: 'post_note', input: { deal: 'deal-4' } },
        { id: 'wipe', label: 'Tidy up', tool: 'delete_all', input: {} },
      ],
    },
    {
      ref: 'deal-5',
      kind: 'commitment',
      direction: 'you_owe',
      summary: 'Revised estimate to Harbour',
      counterparty: { name: 'Harbour Studio', domain: 'harbour.example' },
      state: 'open',
      due_at: '2026-10-02T00:00:00.000Z',
      due_date_only: true,
      evidence: [{ source: 'thread-2', ...at(THREAD, ASK) }],
    },
    {
      ref: 'deal-6',
      kind: 'matter',
      direction: 'info',
      summary: 'A figure nobody wrote',
      counterparty: { name: 'Harbour Studio', domain: 'harbour.example' },
      state: 'open',
      evidence: [{ source: 'thread-2', quote: 'We owe you £9,000.', start: 0, end: 18 }],
    },
  ],
});

function trackerServer() {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (message.method === 'initialize')
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
      else if (message.method === 'tools/list')
        result = {
          tools: ['open_items', 'post_note', 'delete_all'].map((name) => ({
            name,
            description: `Tracker ${name}`,
            inputSchema: { type: 'object' },
          })),
        };
      else if (message.method === 'tools/call') {
        calls.push({ name: message.params?.name ?? '', arguments: message.params?.arguments });
        result = {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: message.params?.name === 'open_items' ? feed : { ok: true },
        };
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    },
  });
  closers.push(() => server.stop(true));
  return server;
}

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql: fixture.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      insecureLocalFixtures: true,
    }),
  );
  const jobs = new JobService(fixture.db, queue.boss);
  const app = createApp({
    env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: MASTER_KEY }),
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs,
    checkDatabase: async () => 'ok',
  });
  const as = (cookie: string, method = 'GET', body?: unknown): RequestInit => ({
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookieOf = (response: Response) => {
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session='));
    if (!cookie) throw new Error(`no session (${response.status})`);
    return cookie;
  };
  const owner = cookieOf(
    await app.request('/setup', as('', 'POST', { email: 'owner@example.test', password })),
  );
  expect(
    (await app.request('/principals', as(owner, 'POST', { email: 'other@example.test', password })))
      .status,
  ).toBe(201);
  const other = cookieOf(
    await app.request('/login', as('', 'POST', { email: 'other@example.test', password })),
  );
  const spaces = async (cookie: string) =>
    (
      (await (await app.request('/spaces', as(cookie))).json()) as {
        spaces: { id: string; kind: string }[];
      }
    ).spaces;
  const ownerSpace = (await spaces(owner)).find((space) => space.kind === 'personal')?.id ?? '';
  const otherSpace = (await spaces(other)).find((space) => space.kind === 'personal')?.id ?? '';
  return { app, as, owner, other, ownerSpace, otherSpace, jobs, sql: fixture.sql, db: fixture.db };
}

const h = fixture ? await harness() : null;
const withDb = h ? describe : describe.skip;

const install = async (cookie: string, url: string, id: string, ledger?: unknown) => {
  if (!h) throw new Error('Postgres unavailable');
  const scopes = ['open_items', 'post_note', 'delete_all'].map((tool) => `mcp_${id}.${tool}`);
  const response = await h.app.request(
    '/connections',
    h.as(cookie, 'POST', {
      provider: 'mcp',
      label: 'Project tracker',
      mcp: {
        id,
        url,
        allowed_scopes: scopes,
        audience: 'owner',
        tools: [
          {
            name: 'open_items',
            alias: 'open_items',
            required_scopes: [scopes[0]],
            effect_class: 'read',
          },
          {
            name: 'post_note',
            alias: 'post_note',
            required_scopes: [scopes[1]],
            effect_class: 'write_reversible',
          },
          { name: 'delete_all', alias: 'delete_all', required_scopes: [scopes[2]] },
        ],
        ...(ledger === undefined ? {} : { ledger }),
      },
    }),
  );
  expect(response.status).toBe(201);
  return connectionResponse.parse(await response.json()).connection.id;
};

let tracker = '';
let undeclared = '';
let owed = '';
let owing = '';

withDb('connections that add tracked items to the ledger', () => {
  test('a declared feed is read, and only what holds is written to the owner’s ledger', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const server = trackerServer();
    feed = baseFeed();
    tracker = await install(h.owner, `${server.url}mcp`, 'tracker', {
      feed: 'open_items',
      actions: ['post_note'],
    });
    const synced = await h.app.request(
      `/connections/${tracker}/ledger/sync`,
      h.as(h.owner, 'POST'),
    );
    expect(synced.status).toBe(200);
    const result = ledgerSyncResult.parse(await synced.json());
    expect(result).toMatchObject({ items_seen: 3, items_written: 2 });
    expect(result.dropped).toEqual({ evidence_failed: 1, action_undeclared: 1 });

    const map = companyMap.parse(
      await (await h.app.request(`/spaces/${h.ownerSpace}/companies`, h.as(h.owner))).json(),
    );
    const published = map.items.filter((item) => item.source?.connection_id === tracker);
    expect(published.map((item) => item.summary).sort()).toEqual([
      'Revised estimate to Harbour',
      'Signed contract back from Harbour',
    ]);
    const contract = published.find((item) => item.source?.ref === 'deal-4');
    owed = contract?.id ?? '';
    owing = published.find((item) => item.source?.ref === 'deal-5')?.id ?? '';
    expect(contract?.source).toMatchObject({
      label: 'Project tracker',
      state: 'waiting on them',
      next_step: 'Nudge Ana on Monday',
      parties: [{ name: 'Ana', role: 'client' }],
    });
    expect(contract?.source?.actions.map((action) => action.tool)).toEqual(['post_note']);
    expect(map.companies.find((entry) => entry.id === contract?.company_id)?.domain).toBe(
      'harbour.example',
    );
  });

  test('a published item opens back to the exact sentence in its source', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const detail = (await (await h.app.request(`/ledger/${owed}`, h.as(h.owner))).json()) as {
      item: unknown;
      message: { text: string } | null;
    };
    const item = ledgerItemContract.parse(detail.item);
    const [evidence] = item.evidence;
    expect(detail.message?.text).toBe(NOTE);
    expect(detail.message?.text.slice(evidence?.start, evidence?.end)).toBe(PROMISE);
  });

  test('Waiting on lists what is owed to the person; what they owe stays off it', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const view = waitingOn.parse(await (await h.app.request('/waiting-on', h.as(h.owner))).json());
    expect(view.owed.map((entry) => entry.id)).toContain(owed);
    expect(view.owed.map((entry) => entry.id)).not.toContain(owing);
    expect(view.owed.find((entry) => entry.id === owed)?.who).toBe('Harbour Studio');
  });

  test('reading the same feed again writes nothing; a closed item is settled', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const again = ledgerSyncResult.parse(
      await (
        await h.app.request(`/connections/${tracker}/ledger/sync`, h.as(h.owner, 'POST'))
      ).json(),
    );
    expect(again.items_written).toBe(0);
    const next = baseFeed();
    next.items = next.items.map((item) =>
      item.ref === 'deal-5' ? { ...item, closed: true } : item,
    );
    feed = next;
    const closed = ledgerSyncResult.parse(
      await (
        await h.app.request(`/connections/${tracker}/ledger/sync`, h.as(h.owner, 'POST'))
      ).json(),
    );
    expect(closed.items_written).toBe(1);
    const item = ledgerItemContract.parse(
      ((await (await h.app.request(`/ledger/${owing}`, h.as(h.owner))).json()) as { item: unknown })
        .item,
    );
    expect(item.status).toBe('settled');
    feed = baseFeed();
  });

  test('another account reads none of it, and cannot read the feed', async () => {
    if (!h) throw new Error('Postgres unavailable');
    expect((await h.app.request(`/ledger/${owed}`, h.as(h.other))).status).toBe(404);
    expect((await h.app.request(`/ledger/${owed}/handle`, h.as(h.other, 'POST'))).status).toBe(404);
    // The answer every route under another account's connection gives.
    expect(
      (await h.app.request(`/connections/${tracker}/ledger/sync`, h.as(h.other, 'POST'))).status,
    ).toBe(403);
    const theirs = companyMap.parse(
      await (await h.app.request(`/spaces/${h.otherSpace}/companies`, h.as(h.other))).json(),
    );
    expect(theirs.items).toEqual([]);
  });

  test('a server whose installation declares no feed adds nothing, whatever it returns', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const server = trackerServer();
    undeclared = await install(h.owner, `${server.url}mcp`, 'plain');
    expect(
      (await h.app.request(`/connections/${undeclared}/ledger/sync`, h.as(h.owner, 'POST'))).status,
    ).toBe(404);
    const [row] =
      await h.sql`select count(*)::int as n from ledger_item where connection_id = ${undeclared}`;
    expect(row?.n).toBe(0);
  });

  test('an action runs as a job that calls the connection’s declared tool, and only that one', async () => {
    if (!h) throw new Error('Postgres unavailable');
    expect(
      (await h.app.request(`/ledger/${owed}/handle`, h.as(h.owner, 'POST', { action: 'wipe' })))
        .status,
    ).toBe(400);
    const started = await h.app.request(
      `/ledger/${owed}/handle`,
      h.as(h.owner, 'POST', { action: 'nudge' }),
    );
    expect(started.status).toBe(201);
    const { job_id: jobId } = (await started.json()) as { job_id: string };
    const [job] = await h.sql`select objective from job where id = ${jobId}`;
    expect(String(job?.objective)).toContain('Call the tool mcp_tracker.post_note once');
    expect(String(job?.objective)).toContain('{"deal":"deal-4"}');
    expect(String(job?.objective)).not.toContain('delete_all');
    const again = await h.app.request(`/ledger/${owed}/handle`, h.as(h.owner, 'POST'));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { job_id: string }).job_id).toBe(jobId);
    // An item that offers no step has nothing to start.
    const none = await h.app.request(`/ledger/${owing}/handle`, h.as(h.owner, 'POST'));
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('no_action');
  });

  test('the service reads every declared feed on its own schedule', async () => {
    if (!h || !queue) throw new Error('Postgres unavailable');
    const before = calls.filter((call) => call.name === 'open_items').length;
    const poller = new LedgerFeedPoller({
      db: h.db,
      sql: h.sql,
      registry,
      triggers: { jobs: h.jobs } as unknown as TriggerService,
    });
    expect(await poller.runOnce()).toBe(0);
    expect(calls.filter((call) => call.name === 'open_items').length).toBe(before + 1);
  });

  test('revoking the connection withholds its items from every read', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const current = connectionResponse.parse(
      await (await h.app.request(`/connections/${tracker}`, h.as(h.owner))).json(),
    ).connection;
    const revoked = await h.app.request(
      `/connections/${tracker}/lifecycle`,
      h.as(h.owner, 'POST', { kind: 'revoke', expected_generation: current.generation }),
    );
    expect(revoked.status).toBe(200);
    const map = companyMap.parse(
      await (await h.app.request(`/spaces/${h.ownerSpace}/companies`, h.as(h.owner))).json(),
    );
    expect(map.items.filter((item) => item.source)).toEqual([]);
    expect((await h.app.request(`/ledger/${owed}`, h.as(h.owner))).status).toBe(404);
    const view = waitingOn.parse(await (await h.app.request('/waiting-on', h.as(h.owner))).json());
    expect(view.owed.map((entry) => entry.id)).not.toContain(owed);
    expect(
      (await h.app.request(`/connections/${tracker}/ledger/sync`, h.as(h.owner, 'POST'))).status,
    ).toBe(409);
  });
});
