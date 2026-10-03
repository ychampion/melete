/**
 * Publishing an app goes ahead on its own when nothing about it is risky, and
 * asks with the reason when something is. "Risky" is: new people could open
 * it, its code opens direct connections (WebRTC), or it shows its viewers
 * data they do not see now. The person can switch the rule off in their
 * approval settings, and then every publish asks again. The rule is for
 * Melete's own Apps connection only.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ConnectorManifest,
  DEFAULT_APPROVAL_SETTINGS,
  type JsonObject,
} from '@melete/contracts';
import { saveApprovalSettings } from '../../src/broker/auto-review.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createAppsConnector } from '../../src/connectors/apps.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { recordFile } from '../helpers/artifacts.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

const SCOPES = ['apps.publish', 'apps.rollback'];
const WEBRTC = 'Its code can open direct connections to other servers (WebRTC).';

async function person(email: string): Promise<string> {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const id = recordId('own');
  await fixture.sql`insert into principal (id, email) values (${id}, ${email})`;
  return id;
}

/** Another connection whose tool happens to share the name, as any server could name one. */
const lookalike: ConnectorManifest = {
  name: 'Lookalike',
  provider: 'mcp',
  version: '0.1.0',
  description: 'A server with a tool named like Melete’s own',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'apps.publish',
      description: 'Publishes somewhere else',
      input_schema: { type: 'object' },
      effect_class: 'write_external',
      required_scopes: ['apps.publish'],
      requires_approval: true,
      verify: false,
    },
  ],
};

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const tag = recordId('x').slice(2).toLowerCase();
  const alice = await person(`alice-${tag}@example.test`);
  const bo = await person(`bo-${tag}@example.test`);
  const cy = await person(`cy-${tag}@example.test`);
  const seed = await seedJob(sql, { scopes: SCOPES, provider: 'apps' });
  await sql`update job set principal_id = ${alice} where id = ${seed.claims.job_id}`;
  await sql`update space set owner_principal_id = ${alice} where id = ${seed.claims.space_id}`;
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-auto-'));
  const workRoot = path.join(roots, 'work');
  const blobs = new LocalBlobStore(path.join(roots, 'blobs'));
  const otherId = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes)
    values (${otherId}, ${seed.claims.space_id}, 'mcp', 'Lookalike', ${JSON.stringify(SCOPES)}::jsonb)`;
  const other: Connector = {
    manifest: lookalike,
    async prepare(payload) {
      return payload;
    },
    async execute(action) {
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: 'elsewhere',
          detail: {},
          received_at: new Date().toISOString(),
          late: false,
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
  const registry = new ConnectorRegistry()
    .register(seed.connectionId, createAppsConnector({ sql, workRoot, blobs }))
    .register(otherId, other);
  // As the service runs it (broker/start.ts): auto-review on with no reviewer
  // configured, and origins answered by memory, which knows nothing of a path
  // the agent chose.
  const broker = new BrokerService({
    sql,
    connectors: registry,
    autoReview: { reviewer: null },
    resolveTrust: createMemoryTrustResolver(),
  });
  const write = (name: string, content: string) =>
    Bun.write(path.join(workRoot, seed.claims.job_id, 'app', name), content);
  const record = (relative: string, content: string) =>
    recordFile(sql, {
      workRoot,
      spaceId: seed.claims.space_id,
      jobId: seed.claims.job_id,
      path: relative,
      content,
    });
  const propose = (kind: string, payload: JsonObject, connectionId = seed.connectionId) =>
    broker.propose(seed.claims, { kind, connection_id: connectionId, payload });
  const approveAndRun = async (proposal: { action_id: string; payload_hash: string }) => {
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
    return broker.dispatch(proposal.action_id);
  };
  const review = async (actionId: string) =>
    (
      await sql`select tier, action_class, decided_by, outcome, reason from action_review
        where action_id = ${actionId}`
    )[0];
  const approvals = async (actionId: string) =>
    (await sql`select id from approval where action_id = ${actionId}`).length;
  const app = async () =>
    (
      await sql`select id, current_version_id from app where space_id = ${seed.claims.space_id}
        order by created_at limit 1`
    )[0] as { id: string; current_version_id: string };
  const settings = (classes: Partial<typeof DEFAULT_APPROVAL_SETTINGS.classes>, mode?: 'ask') =>
    saveApprovalSettings(sql, seed.claims.space_id, {
      mode: mode ?? 'auto_review',
      classes: { ...DEFAULT_APPROVAL_SETTINGS.classes, ...classes },
    });
  return {
    ...seed,
    sql,
    alice,
    bo,
    cy,
    tag,
    otherId,
    write,
    record,
    propose,
    approveAndRun,
    review,
    approvals,
    app,
    settings,
  };
}

databaseTest(
  'a new app, a new version for the same viewers, and a rollback go ahead with a receipt and no question',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', '<!doctype html><title>Board</title>');
    // Data in an app only its publisher can open is already theirs to see.
    await ctx.record('data/deals.json', '[1]');
    const first = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Board',
      data: { deals: { artifact: 'data/deals.json' } },
    });
    expect(first.status).toBe('succeeded');
    const [stored] = await ctx.sql`select receipt from action where id = ${first.action_id}`;
    expect(stored?.receipt?.detail).toMatchObject({ created: true, files: 1 });
    expect(first.canonical_payload).toMatchObject({ audience: { kind: 'only_me' }, risks: [] });
    expect(await ctx.approvals(first.action_id)).toBe(0);
    expect(await ctx.review(first.action_id)).toMatchObject({
      tier: 'apps',
      action_class: 'apps',
      decided_by: 'policy',
      outcome: 'approved',
    });
    const v1 = await ctx.app();

    // Shared with Bo from the Apps screen; the next version keeps its viewers.
    await ctx.sql`insert into app_grant (id, app_id, grantee_kind, grantee_id, role)
      values (${recordId('apg')}, ${v1.id}, 'principal', ${ctx.bo}, 'view')`;
    await ctx.write('index.html', '<!doctype html><title>Board 2</title>');
    const second = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Board',
      app_id: v1.id,
      data: { deals: { artifact: 'data/deals.json' } },
    });
    expect(second.status).toBe('succeeded');
    expect(second.canonical_payload).toMatchObject({
      audience: { kind: 'unchanged', now: `you and bo-${ctx.tag}@example.test` },
      risks: [],
    });
    // Naming the people who can already open it reaches nobody new either.
    await ctx.write('index.html', '<!doctype html><title>Board 3</title>');
    const named = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Board',
      app_id: v1.id,
      data: { deals: { artifact: 'data/deals.json' } },
      audience: { kind: 'people', emails: [`bo-${ctx.tag}@example.test`] },
    });
    expect(named.status).toBe('succeeded');

    const back = await ctx.propose('apps.rollback', {
      app_id: v1.id,
      version_id: v1.current_version_id,
    });
    expect(back.status).toBe('succeeded');
    expect(back.canonical_payload).toMatchObject({ risks: [] });
    expect((await ctx.app()).current_version_id).toBe(v1.current_version_id);
    expect(await ctx.review(back.action_id)).toMatchObject({ tier: 'apps', outcome: 'approved' });
  },
  SLOW,
);

databaseTest(
  'a publish that lets new people open the app asks, and says who',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'hello');
    const bo = `bo-${ctx.tag}@example.test`;
    const cy = `cy-${ctx.tag}@example.test`;
    const shared = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Team',
      audience: { kind: 'people', emails: [bo] },
    });
    expect(shared.status).toBe('needs_approval');
    expect(shared.canonical_payload.risks).toEqual([`New people could open it: ${bo}.`]);
    expect(await ctx.app()).toBeUndefined();
    expect((await ctx.approveAndRun(shared)).status).toBe('succeeded');
    const { id } = await ctx.app();

    // Adding Cy names only Cy; Bo can open it already.
    await ctx.write('index.html', 'hello again');
    const more = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Team',
      app_id: id,
      audience: { kind: 'people', emails: [bo, cy] },
    });
    expect(more.status).toBe('needs_approval');
    expect(more.canonical_payload.risks).toEqual([`New people could open it: ${cy}.`]);

    const everyone = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Team',
      app_id: id,
      audience: { kind: 'everyone' },
    });
    expect(everyone.status).toBe('needs_approval');
    expect(everyone.canonical_payload.risks).toEqual([
      'Everyone with an account here could open it.',
    ]);
  },
  SLOW,
);

databaseTest(
  'code that uses WebRTC asks, for a new version and for a rollback to it',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', '<script src="call.js"></script>');
    await ctx.write('call.js', 'new RTCPeerConnection()');
    const call = await ctx.propose('apps.publish', { dir: 'app', name: 'Call' });
    expect(call.status).toBe('needs_approval');
    expect(call.canonical_payload).toMatchObject({
      opens_connections: ['call.js'],
      risks: [WEBRTC],
    });
    expect((await ctx.approveAndRun(call)).status).toBe('succeeded');
    const withCall = await ctx.app();

    // A version without it goes ahead; going back to the one with it asks.
    await ctx.write('call.js', 'console.log("no call")');
    const plain = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Call',
      app_id: withCall.id,
    });
    expect(plain.status).toBe('succeeded');
    const back = await ctx.propose('apps.rollback', {
      app_id: withCall.id,
      version_id: withCall.current_version_id,
    });
    expect(back.status).toBe('needs_approval');
    expect(back.canonical_payload.risks).toEqual([WEBRTC]);
  },
  SLOW,
);

databaseTest(
  'new data for viewers asks; data under update review does not',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'board');
    await ctx.record('data/deals.json', '[1]');
    await ctx.record('data/notes.json', '[2]');
    const bo = `bo-${ctx.tag}@example.test`;
    const first = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Shared',
      audience: { kind: 'people', emails: [bo] },
    });
    expect((await ctx.approveAndRun(first)).status).toBe('succeeded');
    const { id } = await ctx.app();

    const more = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Shared',
      app_id: id,
      data: { deals: { artifact: 'data/deals.json' } },
    });
    expect(more.status).toBe('needs_approval');
    expect(more.canonical_payload.risks).toEqual([
      'It would show its viewers data they do not see now: deals (data/deals.json).',
    ]);

    // Collecting responses from viewers who could not send any before asks too.
    const collecting = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Shared',
      app_id: id,
      collections: { feedback: {} },
    });
    expect(collecting.status).toBe('needs_approval');
    expect(collecting.canonical_payload.risks).toEqual([
      'It would collect responses from its viewers it does not collect now: feedback.',
    ]);

    // Each version waits for the publisher's review, so nothing new reaches viewers unseen.
    const reviewed = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Shared',
      app_id: id,
      data: { notes: { artifact: 'data/notes.json', review: true } },
    });
    expect(reviewed.status).toBe('succeeded');
  },
  SLOW,
);

databaseTest(
  'with publishing switched off in approval settings, or asking for everything, every publish asks',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'quiet');
    await ctx.settings({ apps: false });
    const off = await ctx.propose('apps.publish', { dir: 'app', name: 'Quiet' });
    expect(off.status).toBe('needs_approval');
    expect(off.canonical_payload.risks).toEqual([]);
    expect(await ctx.review(off.action_id)).toBeUndefined();

    await ctx.settings({ apps: true }, 'ask');
    await ctx.write('index.html', 'quiet 2');
    expect((await ctx.propose('apps.publish', { dir: 'app', name: 'Quiet' })).status).toBe(
      'needs_approval',
    );

    await ctx.settings({ apps: true });
    await ctx.write('index.html', 'quiet 3');
    expect((await ctx.propose('apps.publish', { dir: 'app', name: 'Quiet' })).status).toBe(
      'succeeded',
    );
  },
  SLOW,
);

databaseTest(
  'a publish that gains a risk after it was decided is refused at admission',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'team');
    const bo = `bo-${ctx.tag}@example.test`;
    const first = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Team',
      audience: { kind: 'people', emails: [bo] },
    });
    expect((await ctx.approveAndRun(first)).status).toBe('succeeded');
    const { id } = await ctx.app();

    // Decided while Bo could open it; Bo is removed before it runs.
    await ctx.settings({ apps: false });
    await ctx.write('index.html', 'team 2');
    const next = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Team',
      app_id: id,
      audience: { kind: 'people', emails: [bo] },
    });
    expect(next.canonical_payload.risks).toEqual([]);
    await ctx.sql`update app_grant set revoked_at = now() where app_id = ${id}
      and grantee_id = ${ctx.bo}`;
    const refusal = await rejectionOf(ctx.approveAndRun(next));
    expect(String((refusal as Error).message)).toContain(`New people could open it: ${bo}.`);
  },
  SLOW,
);

databaseTest(
  'a tool with the same name on any other connection still asks',
  async () => {
    const ctx = await setup();
    const elsewhere = await ctx.propose('apps.publish', { risks: [] }, ctx.otherId);
    expect(elsewhere.status).toBe('needs_approval');
  },
  SLOW,
);

databaseTest(
  'a data path only the Apps connection proved is left out of origin checking; any other still asks',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'mine');
    await ctx.record('data/deals.json', '[1]');
    const data = { deals: { artifact: 'data/deals.json' } };
    const proved = await ctx.propose('apps.publish', { dir: 'app', name: 'Mine', data });
    expect(proved.status).toBe('succeeded');
    expect(proved.origin_warnings).toEqual([]);

    // The same path on a connection that proved nothing is a value nobody vouched for.
    const unproved = await ctx.propose(
      'apps.publish',
      { data: { deals: { path: 'data/deals.json' } }, risks: [] },
      ctx.otherId,
    );
    expect(unproved.status).toBe('needs_approval');
    expect(unproved.origin_warnings.map((warning) => warning.field)).toEqual(['data.deals.path']);

    // A path the Apps connection cannot prove is refused before anyone is asked.
    const unknown = await rejectionOf(
      ctx.propose('apps.publish', {
        dir: 'app',
        name: 'Mine',
        data: { notes: { artifact: 'data/notes.json' } },
      }),
    );
    expect(String((unknown as Error).message)).toContain('has not saved as a checked file');
  },
  SLOW,
);

databaseTest(
  'a data file that is no longer a recorded file of the publisher is refused at admission',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'board');
    await ctx.record('data/deals.json', '[1]');
    await ctx.settings({ apps: false });
    const asked = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Board',
      data: { deals: { artifact: 'data/deals.json' } },
    });
    expect(asked.status).toBe('needs_approval');
    // Its record is gone before it runs, so the path is no longer one the connector can vouch for.
    await ctx.sql`delete from artifact where job_id = ${ctx.claims.job_id}`;
    const refusal = await rejectionOf(ctx.approveAndRun(asked));
    expect(String((refusal as Error).message)).toContain('has not saved as a checked file');
    expect(await ctx.app()).toBeUndefined();
  },
  SLOW,
);

databaseTest(
  'collecting responses in an app only its publisher can open goes ahead',
  async () => {
    const ctx = await setup();
    await ctx.write('index.html', 'form');
    const own = await ctx.propose('apps.publish', {
      dir: 'app',
      name: 'Form',
      collections: { feedback: {} },
    });
    expect(own.status).toBe('succeeded');
    expect(own.canonical_payload.risks).toEqual([]);
  },
  SLOW,
);
