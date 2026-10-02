/**
 * Publishing apps end to end against a real database: the publish asks with
 * what the person needs to decide, nothing exists before the approval, a file
 * changed after it is a new version that asks again, a rollback moves the
 * pointer at once, and the Apps routes list, show, re-grant and delete.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Action, JsonObject } from '@melete/contracts';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { mountApps } from '../../src/apps/routes.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createAppsConnector } from '../../src/connectors/apps.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

const SCOPES = ['apps.publish', 'apps.rollback'];

async function person(email: string): Promise<string> {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const id = recordId('own');
  await fixture.sql`insert into principal (id, email) values (${id}, ${email})`;
  return id;
}

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const tag = recordId('x').slice(2).toLowerCase();
  const alice = await person(`alice-${tag}@example.test`);
  const bo = await person(`bo-${tag}@example.test`);
  const cy = await person(`cy-${tag}@example.test`);
  const seed = await seedJob(sql, { scopes: SCOPES, provider: 'apps' });
  await sql`update job set principal_id = ${alice} where id = ${seed.claims.job_id}`;
  // Alice's own space, as a personal space is.
  await sql`update space set owner_principal_id = ${alice} where id = ${seed.claims.space_id}`;
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-apps-'));
  const workRoot = path.join(roots, 'work');
  const blobs = new LocalBlobStore(path.join(roots, 'blobs'));
  const connector = createAppsConnector({ sql, workRoot, blobs });
  const registry = new ConnectorRegistry().register(seed.connectionId, connector);
  const broker = new BrokerService({ sql, connectors: registry });
  const write = (name: string, content: string | Uint8Array) =>
    Bun.write(path.join(workRoot, seed.claims.job_id, 'app', name), content);
  // The Apps routes as a signed-in person reaches them.
  const api = (as: string) => {
    const app = new Hono();
    // As the service answers a refusal.
    app.onError((error, c) =>
      error instanceof ServiceError
        ? c.json({ error: { code: error.code, message: error.message } }, error.status)
        : c.json({ error: { code: 'internal_error', message: error.message } }, 500),
    );
    app.use('*', async (c, next) => {
      c.set('owner' as never, { id: as } as never);
      await next();
    });
    mountApps(app, { sql });
    return (route: string, init?: { method?: string; body?: unknown }) =>
      app.request(route, {
        method: init?.method ?? 'GET',
        ...(init?.body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
          : {}),
      });
  };
  const propose = (kind: string, payload: JsonObject, client_ref?: string) =>
    broker.propose(seed.claims, {
      kind,
      connection_id: seed.connectionId,
      payload,
      ...(client_ref ? { client_ref } : {}),
    });
  const approveAndRun = async (proposal: { action_id: string; payload_hash: string }) => {
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
    return broker.dispatch(proposal.action_id);
  };
  const appRows = () => sql`select id, current_version_id, grant_generation from app
    where space_id = ${seed.claims.space_id}`;
  const storedBlobs = async () => {
    const keys: string[] = [];
    for await (const head of blobs.list()) keys.push(head.key);
    return keys;
  };
  /** Whether the connector says this action took effect, as reconciliation asks. */
  const verify = async (actionId: string) => {
    const [row] = await sql`select * from action where id = ${actionId}`;
    const action = {
      id: row?.id,
      job_id: row?.job_id,
      connection_id: row?.connection_id,
      kind: row?.kind,
      idempotency_key: row?.idempotency_key,
      canonical_payload: row?.canonical_payload,
    } as unknown as Action;
    return connector.verify(action, {
      job_id: seed.claims.job_id,
      space_id: seed.claims.space_id,
      idempotency_key: action.id,
      constraints: {} as never,
    });
  };
  return {
    ...seed,
    broker,
    verify,
    sql,
    alice,
    bo,
    cy,
    tag,
    write,
    api,
    propose,
    approveAndRun,
    appRows,
    storedBlobs,
    blobs,
  };
}

const deals = '[{"name":"Acme","value":1200}]';

databaseTest(
  'publishing asks with the file count, viewers and data bindings, and nothing is visible before approval',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', '<!doctype html><title>Deals</title>');
    await ctx.write('app.js', 'console.log("deals")');
    await ctx.write('../data/deals.json', deals);
    const proposal = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Deals',
      data: { deals: { artifact: 'data/deals.json' } },
      audience: { kind: 'people', emails: [`bo-${ctx.tag}@example.test`] },
    });
    expect(proposal.status).toBe('needs_approval');
    expect(proposal.canonical_payload).toMatchObject({
      name: 'Deals',
      create: true,
      file_count: 2,
      total_bytes: 55,
      audience: { kind: 'people', emails: [`bo-${ctx.tag}@example.test`], principal_ids: [ctx.bo] },
      data: {
        deals: { kind: 'artifact', path: 'data/deals.json', source_job_id: ctx.claims.job_id },
      },
      data_shown: ['deals: data/deals.json from this conversation, newest version each time'],
    });

    // Asked, not done: no app, no stored file, nothing on anyone's Apps screen.
    expect(await ctx.appRows()).toHaveLength(0);
    expect(await ctx.storedBlobs()).toEqual([]);
    expect(await (await ctx.api(ctx.alice)('/apps')).json()).toEqual({ apps: [] });

    const dispatched = await ctx.approveAndRun(proposal);
    expect(dispatched.status).toBe('succeeded');
    const [row] = await ctx.appRows();
    expect(dispatched.receipt?.detail).toMatchObject({
      app_id: row?.id,
      version_id: row?.current_version_id,
      created: true,
      files: 2,
      link: `#/apps/${row?.id}`,
    });
    expect((await ctx.storedBlobs()).length).toBe(2);
    const refs = await ctx.sql`select owner_kind, owner_id, space_id from blob_ref
      where owner_id = ${row?.current_version_id}`;
    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.space_id === ctx.claims.space_id)).toBe(true);

    // Other tests share this database, and an app shared with everyone is everyone's.
    const listed = async (who: string) =>
      (
        (await (await ctx.api(who)('/apps')).json()) as { apps: { id: string; role: string }[] }
      ).apps.filter((app) => app.id === row?.id);
    expect((await listed(ctx.alice)).map((app) => app.role)).toEqual(['manage']);
    expect((await listed(ctx.bo)).map((app) => app.role)).toEqual(['view']);
    expect(await listed(ctx.cy)).toEqual([]);
    expect((await ctx.api(ctx.cy)(`/apps/${row?.id}`)).status).toBe(404);
  },
  SLOW,
);

databaseTest(
  'a changed file after approval is a new version that asks',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'approved bytes');
    const proposal = await ctx.propose('apps.publish', { dir: 'app', name: 'Board' });
    await ctx.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await ctx.broker.admit(ctx.claims, proposal.action_id, proposal.payload_hash);
    await ctx.write('index.html', 'bytes nobody approved');
    expect((await ctx.broker.dispatch(proposal.action_id)).status).toBe('failed');
    expect(await ctx.appRows()).toHaveLength(0);
    expect(await ctx.storedBlobs()).toEqual([]);

    // Changed between the approval and its admission, it is refused there.
    await ctx.write('index.html', 'approved again');
    const early = await ctx.propose('apps.publish', { dir: 'app', name: 'Board' });
    await ctx.broker.decide(early.action_id, {
      decision: 'approved',
      payload_hash: early.payload_hash,
    });
    await ctx.write('index.html', 'changed before admission');
    // The folder is read at dispatch, outside the admission's transaction.
    await ctx.broker.admit(ctx.claims, early.action_id, early.payload_hash);
    expect((await ctx.broker.dispatch(early.action_id)).status).toBe('failed');
    expect(await ctx.appRows()).toHaveLength(0);

    const fresh = await ctx.propose('apps.publish', { dir: 'app', name: 'Board' });
    expect(fresh.status).toBe('needs_approval');
    expect(fresh.payload_hash).not.toBe(proposal.payload_hash);
    expect((await ctx.approveAndRun(fresh)).status).toBe('succeeded');

    // A new version of the app asks again, too, and keeps its viewers as they are.
    const [app] = await ctx.appRows();
    await ctx.write('index.html', 'second version');
    const next = await ctx.propose('apps.publish', { dir: 'app', name: 'Board', app_id: app?.id });
    expect(next.status).toBe('needs_approval');
    expect(next.canonical_payload).toMatchObject({
      create: false,
      current_name: 'Board',
      audience: { kind: 'unchanged', now: 'only you' },
    });
  },
  SLOW,
);

databaseTest(
  'rolling back serves the earlier version at once',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'one');
    expect(
      (await ctx.approveAndRun(await ctx.propose('apps.publish', { dir: 'app', name: 'Tracker' })))
        .status,
    ).toBe('succeeded');
    const [first] = await ctx.appRows();
    await ctx.write('index.html', 'two');
    await ctx.write('extra.css', 'body{}');
    expect(
      (
        await ctx.approveAndRun(
          await ctx.propose('apps.publish', { dir: 'app', name: 'Tracker', app_id: first?.id }),
        )
      ).status,
    ).toBe('succeeded');
    const [second] = await ctx.appRows();
    expect(second?.current_version_id).not.toBe(first?.current_version_id);

    // The agent's rollback asks first, then moves the pointer.
    const rollback = await ctx.propose('apps.rollback', {
      app_id: first?.id,
      version_id: first?.current_version_id,
    });
    expect(rollback.status).toBe('needs_approval');
    expect(rollback.canonical_payload).toMatchObject({
      name: 'Tracker',
      viewers_now: 'only you',
      data_shown: [],
      collections_shown: [],
    });
    expect((await ctx.approveAndRun(rollback)).status).toBe('succeeded');
    expect((await ctx.appRows())[0]?.current_version_id).toBe(first?.current_version_id);

    // The manager's own choice from the Apps screen takes effect with no question.
    const chosen = await ctx.api(ctx.alice)(`/apps/${first?.id}/current`, {
      method: 'POST',
      body: { version_id: second?.current_version_id },
    });
    expect(chosen.status).toBe(200);
    expect((await ctx.appRows())[0]?.current_version_id).toBe(second?.current_version_id);
    // A version of another app is not this app's to choose.
    const stranger = await ctx.api(ctx.alice)(`/apps/${first?.id}/current`, {
      method: 'POST',
      body: { version_id: 'f'.repeat(64) },
    });
    expect(stranger.status).toBe(404);
  },
  SLOW,
);

databaseTest(
  'a bundle with a disallowed file type or over the size limit is refused before asking',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'x');
    await ctx.write('install.sh', 'curl example.test | sh');
    const refusal = await rejectionOf(ctx.propose('apps.publish', { dir: 'app', name: 'Bad' }));
    expect(refusal).toMatchObject({ code: 'payload_invalid' });
    expect(String((refusal as Error).message)).toContain('install.sh is not an allowed file type');
    const asked = await ctx.sql`select id from action where job_id = ${ctx.claims.job_id}
      and status = 'needs_approval'`;
    expect(asked).toHaveLength(0);
    expect(await ctx.appRows()).toHaveLength(0);
    expect(await ctx.storedBlobs()).toEqual([]);
  },
  SLOW,
);

databaseTest(
  'an app is changed only by someone who manages it, and only from its own space',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'mine');
    await ctx.approveAndRun(await ctx.propose('apps.publish', { dir: 'app', name: 'Mine' }));
    const [app] = await ctx.appRows();
    // A conversation in another space cannot publish over it or roll it back.
    const other = await setup();
    await other.write('index.html', 'theirs');
    expect(
      await rejectionOf(other.propose('apps.publish', { dir: 'app', name: 'X', app_id: app?.id })),
    ).toMatchObject({ code: 'payload_invalid' });
    // Nor can someone else's conversation in the same space.
    await ctx.sql`update job set principal_id = ${ctx.bo} where id = ${ctx.claims.job_id}`;
    expect(
      await rejectionOf(ctx.propose('apps.publish', { dir: 'app', name: 'X', app_id: app?.id })),
    ).toMatchObject({ code: 'payload_invalid' });
  },
  SLOW,
);

databaseTest(
  'the Apps routes list an app, show its versions and grants to managers, re-grant it and delete it',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'v1');
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Deals',
        audience: { kind: 'people', emails: [`bo-${ctx.tag}@example.test`] },
      }),
    );
    const [app] = await ctx.appRows();
    await ctx.write('index.html', 'v2');
    await ctx.write('chart.svg', '<svg/>');
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', { dir: 'app', name: 'Deals', app_id: app?.id }),
    );
    const alice = ctx.api(ctx.alice);
    const bo = ctx.api(ctx.bo);
    const cy = ctx.api(ctx.cy);

    const managed = (await (await alice(`/apps/${app?.id}`)).json()) as {
      versions: { current: boolean; changes: { added: string[]; changed: string[] } }[];
      grants: { kind: string; principal?: { id: string } }[];
      files: { path: string }[];
    };
    expect(managed.files.map((file) => file.path)).toEqual(['chart.svg', 'index.html']);
    expect(managed.versions.map((version) => version.current)).toEqual([true, false]);
    expect(managed.versions[0]?.changes).toMatchObject({
      added: ['chart.svg'],
      changed: ['index.html'],
    });
    expect(managed.grants.map((grant) => grant.principal?.id)).toEqual([ctx.bo]);
    // A viewer sees the app, not its history or its list of people.
    const viewed = (await (await bo(`/apps/${app?.id}`)).json()) as {
      versions: unknown;
      grants: unknown;
    };
    expect(viewed).toMatchObject({ versions: null, grants: null });
    expect(
      (await bo(`/apps/${app?.id}/grants`, { method: 'PUT', body: { grants: [] } })).status,
    ).toBe(403);
    expect((await bo(`/apps/${app?.id}`, { method: 'DELETE' })).status).toBe(403);

    // Replacing the list moves the generation; Bo loses the app, Cy gains it.
    const before = Number((await ctx.appRows())[0]?.grant_generation);
    const regranted = await alice(`/apps/${app?.id}/grants`, {
      method: 'PUT',
      body: { grants: [{ kind: 'principal', email: `cy-${ctx.tag}@example.test` }] },
    });
    expect(regranted.status).toBe(200);
    expect(Number((await ctx.appRows())[0]?.grant_generation)).toBe(before + 1);
    expect((await bo(`/apps/${app?.id}`)).status).toBe(404);
    expect((await cy(`/apps/${app?.id}`)).status).toBe(200);
    // The same list again changes nothing, so open views are not ended for nothing.
    await alice(`/apps/${app?.id}/grants`, {
      method: 'PUT',
      body: { grants: [{ kind: 'principal', email: `cy-${ctx.tag}@example.test` }] },
    });
    expect(Number((await ctx.appRows())[0]?.grant_generation)).toBe(before + 1);
    expect(
      (
        await alice(`/apps/${app?.id}/grants`, {
          method: 'PUT',
          body: { grants: [{ kind: 'principal', email: 'nobody@example.test' }] },
        })
      ).status,
    ).toBe(400);

    const deleted = await alice(`/apps/${app?.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await ctx.appRows()).toHaveLength(0);
    expect(
      await ctx.sql`select 1 from blob_ref where owner_kind = 'app_version'
        and space_id = ${ctx.claims.space_id}`,
    ).toHaveLength(0);
    expect((await alice(`/apps/${app?.id}`)).status).toBe(404);
  },
  SLOW,
);

databaseTest(
  'proposing the same new app again is the same request, before and after it is approved',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'one app');
    const first = await ctx.propose('apps.publish', { dir: 'app', name: 'Deals' });
    const again = await ctx.propose('apps.publish', { dir: 'app', name: 'Deals' });
    expect(again.action_id).toBe(first.action_id);
    expect(again.payload_hash).toBe(first.payload_hash);
    expect(first.canonical_payload).not.toHaveProperty('app_id');

    // A later turn naming the request by its reference finds the approved one and runs it.
    const asked = await ctx.propose('apps.publish', { dir: 'app', name: 'Ledger' }, 'ledger-1');
    await ctx.broker.decide(asked.action_id, {
      decision: 'approved',
      payload_hash: asked.payload_hash,
    });
    const retried = await ctx.propose('apps.publish', { dir: 'app', name: 'Ledger' }, 'ledger-1');
    expect(retried.action_id).toBe(asked.action_id);
    if (retried.status === 'approved')
      await ctx.broker.admit(ctx.claims, asked.action_id, asked.payload_hash);
    const done = await ctx.broker.dispatch(asked.action_id);
    expect(done.status).toBe('succeeded');
    const apps = await ctx.appRows();
    expect(apps).toHaveLength(1);
    expect(done.receipt?.detail).toMatchObject({ app_id: apps[0]?.id });
    // The same action names the same app when it is checked again.
    expect((await ctx.verify(asked.action_id)).decision).toBe('succeeded');
  },
  SLOW,
);

databaseTest(
  'a new version is asked for by the name the app has now, and a rename only as shown',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'payroll');
    await ctx.approveAndRun(await ctx.propose('apps.publish', { dir: 'app', name: 'Payroll' }));
    const [app] = await ctx.appRows();
    await ctx.write('index.html', 'something else');
    const renaming = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Deals',
      app_id: app?.id,
    });
    expect(renaming.canonical_payload).toMatchObject({
      current_name: 'Payroll',
      name: 'Deals',
      create: false,
    });
    // Renamed by its manager after the question was asked: the answer is about another name.
    await ctx.broker.decide(renaming.action_id, {
      decision: 'approved',
      payload_hash: renaming.payload_hash,
    });
    await ctx.sql`update app set name = 'Payroll 2026' where id = ${app?.id}`;
    expect(
      await rejectionOf(ctx.broker.admit(ctx.claims, renaming.action_id, renaming.payload_hash)),
    ).toMatchObject({ code: 'payload_invalid' });
    await ctx.sql`update app set name = 'Payroll' where id = ${app?.id}`;
    // Asked again (a refused request stays refused), the rename is on the card and goes ahead.
    const shown = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Deals',
      description: 'Open deals',
      app_id: app?.id,
    });
    expect((await ctx.approveAndRun(shown)).status).toBe('succeeded');
    const [renamed] = await ctx.sql`select name from app where id = ${app?.id}`;
    expect(renamed?.name).toBe('Deals');
  },
  SLOW,
);

databaseTest(
  "a rollback is asked for with the earlier version's data and today's viewers",
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'v1');
    await ctx.write('../data/salaries.json', '[]');
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Pay',
        data: { salaries: { artifact: 'data/salaries.json' } },
      }),
    );
    const [first] = await ctx.appRows();
    await ctx.write('index.html', 'v2');
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Pay',
        app_id: first?.id,
        audience: { kind: 'everyone' },
      }),
    );
    const back = await ctx.propose('apps.rollback', {
      app_id: first?.id,
      version_id: first?.current_version_id,
    });
    expect(back.canonical_payload).toMatchObject({
      viewers_now: 'everyone with an account here',
      data_shown: ['salaries: data/salaries.json from this conversation, newest version each time'],
    });
  },
  SLOW,
);

databaseTest(
  'a publish that sets who may open the app keeps the managers its publisher chose',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'v1');
    await ctx.approveAndRun(await ctx.propose('apps.publish', { dir: 'app', name: 'Team' }));
    const [app] = await ctx.appRows();
    await ctx.api(ctx.alice)(`/apps/${app?.id}/grants`, {
      method: 'PUT',
      body: {
        grants: [{ kind: 'principal', email: `bo-${ctx.tag}@example.test`, role: 'manage' }],
      },
    });
    await ctx.write('index.html', 'v2');
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Team',
        app_id: app?.id,
        audience: {
          kind: 'people',
          emails: [`bo-${ctx.tag}@example.test`, `cy-${ctx.tag}@example.test`],
        },
      }),
    );
    // Other tests share this database, and an app shared with everyone is everyone's.
    const roles = async (who: string) =>
      (
        (await (await ctx.api(who)('/apps')).json()) as { apps: { id: string; role: string }[] }
      ).apps
        .filter((row) => row.id === app?.id)
        .map((row) => row.role);
    expect(await roles(ctx.bo)).toEqual(['manage']);
    expect(await roles(ctx.cy)).toEqual(['view']);
    await ctx.approveAndRun(
      await ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Team',
        app_id: app?.id,
        audience: { kind: 'only_me' },
      }),
    );
    expect(await roles(ctx.bo)).toEqual(['manage']);
    expect(await roles(ctx.cy)).toEqual([]);
  },
  SLOW,
);

databaseTest(
  'a check of a publish that never ran does not take it for done when the same bundle is current',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'same');
    const ran = await ctx.propose('apps.publish', { dir: 'app', name: 'Board' });
    await ctx.approveAndRun(ran);
    const [app] = await ctx.appRows();
    const never = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Board',
      app_id: app?.id,
      audience: { kind: 'people', emails: [`bo-${ctx.tag}@example.test`] },
    });
    expect((await ctx.verify(never.action_id)).decision).toBe('undecided');
    expect((await ctx.verify(ran.action_id)).decision).toBe('succeeded');
  },
  SLOW,
);

databaseTest(
  "a binding names a workspace file in one of the publisher's own conversations",
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'x');
    for (const artifact of ['../../secret.json', '/etc/passwd', 'C:\\x.json'])
      expect(
        await rejectionOf(
          ctx.propose('apps.publish', { dir: 'app', name: 'X', data: { d: { artifact } } }),
        ),
      ).toMatchObject({ code: 'payload_invalid' });
    // Bo's conversation in the same space is Bo's, not Alice's to show.
    const theirs = recordId('job');
    await ctx.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget,
        constraints, principal_id)
      select ${theirs}, space_id, 'Bo', 'Bo', 'running', 1, budget, constraints, ${ctx.bo}
      from job where id = ${ctx.claims.job_id}`;
    expect(
      await rejectionOf(
        ctx.propose('apps.publish', {
          dir: 'app',
          name: 'X',
          data: { d: { artifact: 'data/d.json', source: theirs } },
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
  },
  SLOW,
);

databaseTest(
  "the publisher manages an app while they belong to its space, and the space's owner always does",
  async () => {
    const ctx = await setup();
    // A shared space: Cy owns it, Alice is a member who publishes.
    await ctx.sql`update space set kind = 'shared', owner_principal_id = ${ctx.cy}
      where id = ${ctx.claims.space_id}`;
    await ctx.sql`insert into space_membership (principal_id, space_id, role)
      values (${ctx.alice}, ${ctx.claims.space_id}, 'member'), (${ctx.cy}, ${ctx.claims.space_id}, 'owner')`;
    // In a shared space a conversation's capability names its person.
    ctx.claims.principal_id = ctx.alice;
    ctx.claims.membership_generation = 0;
    await ctx.sql`update attempt set principal_id = ${ctx.alice}, membership_generation = 0
      where job_id = ${ctx.claims.job_id}`;
    await ctx.write('index.html', 'shared');
    expect(
      (await ctx.approveAndRun(await ctx.propose('apps.publish', { dir: 'app', name: 'Shared' })))
        .status,
    ).toBe('succeeded');
    const [app] = await ctx.appRows();
    expect((await ctx.api(ctx.alice)(`/apps/${app?.id}`)).status).toBe(200);
    expect((await ctx.api(ctx.cy)(`/apps/${app?.id}`)).status).toBe(200);
    // Alice leaves the space: the app is no longer hers to change.
    await ctx.sql`update space_membership set revoked_at = now()
      where principal_id = ${ctx.alice} and space_id = ${ctx.claims.space_id}`;
    expect((await ctx.api(ctx.alice)(`/apps/${app?.id}`)).status).toBe(404);
    expect(
      (
        await ctx.api(ctx.alice)(`/apps/${app?.id}/grants`, {
          method: 'PUT',
          body: { grants: [{ kind: 'installation' }] },
        })
      ).status,
    ).toBe(404);
    expect((await ctx.api(ctx.cy)(`/apps/${app?.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await ctx.appRows()).toHaveLength(0);
  },
  SLOW,
);
