/**
 * A shared space has one owner and some members. Each member's own work in it
 * reads only what the space shares with its members, acts through no
 * connection the owner installed for themselves, and every answer to a
 * permission names the person who gave it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type CapabilityClaims,
  canonicalizePayload,
  type DispatchResult,
} from '@melete/contracts';
import { createBrokerApp, SERVICE_DECISION } from '../../src/broker/http.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { readCandidates } from '../../src/companies/replies.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { startDeploymentMemory } from '../../src/memory/bootstrap.ts';
import { listClaims } from '../../src/memory/claims.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { recall } from '../../src/memory/recall.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { buildViews } from '../../src/memory/views.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-shared-scope-'));
const memory =
  handle && queue
    ? await startDeploymentMemory({
        privacyOrigin: async () => null,
        sql: handle.sql,
        boss: queue.boss,
        restrictionsDir: directory,
        workers: false,
      })
    : null;
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
// The production setting: an attempt follows the live grants of the
// connections it may use, so a connection installed later is offered at once.
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'shared-space-scope-signing-key-32-bytes',
      liveConnectionScopes: true,
    })
  : null;
const broker = handle ? new BrokerService({ sql: handle.sql, connectors: registry }) : null;
const app =
  handle && memory && jobs
    ? createApp({
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: directory }),
        db: handle.db,
        sql: handle.sql,
        jobs,
        registry,
        memory: memory.routes,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !queue || !app || !memory || !jobs || !runner || !broker)
    throw new Error('Postgres unavailable');
  return { ...handle, boss: queue.boss, app, memory, jobs, runner, broker };
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function fixtureCalendar(): Connector {
  return {
    manifest: calendarManifest,
    async execute(action: Action): Promise<DispatchResult> {
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail: { uid: action.id, etag: '"one"' },
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
}

type World = {
  ownerId: string;
  ownerCookie: string;
  memberId: string;
  memberCookie: string;
  sharedId: string;
  memberSpaceId: string;
};
let world: World;

/** A job of `principalId` in `spaceId`, claimed by the runner as production claims it. */
async function claimedJob(
  principalId: string,
  spaceId: string,
  title: string,
  allowedDomains: string[] = [],
) {
  const { jobs, runner } = database();
  const row = await principalContext.run(principalId, () =>
    jobs.create({
      space_id: spaceId,
      title,
      objective: title,
      constraints: { allowed_domains: allowedDomains },
    }),
  );
  expect(row.principalId).toBe(principalId);
  const claimed = await runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  });
  if (!claimed) throw new Error('Attempt was not claimed');
  return { jobId: row.id, claims: claimed.claims };
}
async function installCalendar(spaceId: string, label: string) {
  const { sql } = database();
  const id = recordId('conn');
  const scopes = calendarManifest.tools.map((tool) => tool.name);
  await sql`insert into connection (id, space_id, provider, label, scopes)
    values (${id}, ${spaceId}, ${calendarManifest.provider}, ${label}, ${JSON.stringify(scopes)}::jsonb)`;
  registry.register(id, fixtureCalendar());
  return id;
}
/** A mailbox the space's owner connected; nothing reads it here but the reply poller's query. */
async function installMailbox(spaceId: string, label: string) {
  const id = recordId('conn');
  await database().sql`insert into connection (id, space_id, provider, label)
    values (${id}, ${spaceId}, 'imap', ${label})`;
  return id;
}
const calendarTools = async (claims: CapabilityClaims) =>
  (await database().broker.discovery.available(claims))
    .map((tool) => tool.name)
    .filter((name) => name.includes('calendar'));
const event = (claims: CapabilityClaims, connectionId: string, summary: string) =>
  database().broker.propose(claims, {
    connection_id: connectionId,
    kind: 'calendar.create',
    payload: { summary, start: '2026-10-13T18:00:00Z', end: '2026-10-13T19:00:00Z' },
  });

withDb('a member of a shared space', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await memory?.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  test('setup makes an owner, a member and a shared space they both belong to', async () => {
    const { app, sql } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const ownerCookie = sessionCookie(setup);
    const ownerId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const provisioned = await send(ownerCookie, '/principals', 'POST', {
      email: 'member@example.test',
      password,
    });
    expect(provisioned.status).toBe(201);
    const memberId = ((await provisioned.json()) as { principal: { id: string } }).principal.id;
    const memberCookie = sessionCookie(
      await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'member@example.test', password }),
      }),
    );
    const shared = await send(ownerCookie, '/spaces/shared', 'POST', { name: 'Household' });
    expect(shared.status).toBe(201);
    const sharedId = ((await shared.json()) as { space: { id: string } }).space.id;
    const granted = await send(ownerCookie, `/spaces/${sharedId}/memberships`, 'POST', {
      principal_id: memberId,
    });
    expect(granted.status).toBe(201);
    const [personal] = await sql`select id from space
      where kind = 'personal' and owner_principal_id = ${memberId}`;
    if (!personal) throw new Error('The member has no personal space');
    world = {
      ownerId,
      ownerCookie,
      memberId,
      memberCookie,
      sharedId,
      memberSpaceId: String(personal.id),
    };
  }, 60_000);

  test("under deployment memory a member's job recalls no claim private to the owner", async () => {
    const { app, sql, boss, memory } = database();
    const headers = { cookie: world.ownerCookie, 'x-melete-space': world.sharedId };
    expect((await app.request('/memory/claims', { headers })).status).toBe(200);
    const ownerScope = await memory.routes.resolveScope?.(
      new Request('http://localhost/memory/claims', { headers }),
    );
    if (!ownerScope) throw new Error('The owner has no memory in the shared space');
    expect(ownerScope).toMatchObject({ role: 'owner', audience: 'private' });
    const source = await ingest(sql, ownerScope, {
      stream: 'shared-scope-contact',
      source_identity: 'clinic',
      source_version: '1',
      source_type: 'observation',
      event_at: '2026-10-01T00:00:00Z',
      text: JSON.stringify({ kind: 'contact', slug: 'clinic', email: 'clinic@example.test' }),
    });
    const [work] =
      await sql`select id from memory_work where source_id = ${source.source.source_id}`;
    await runExtractionWork({ sql, boss, journal: memory.routes.journal }, String(work?.id));
    // One fact the owner shares with the space, beside the private one.
    const sharedScope = { ...ownerScope, audience: 'space' as const };
    const sharedSource = await ingest(sql, sharedScope, {
      stream: 'shared-scope-contact',
      source_identity: 'pharmacy',
      source_version: '1',
      source_type: 'observation',
      event_at: '2026-10-01T00:00:00Z',
      text: JSON.stringify({ kind: 'contact', slug: 'pharmacy', email: 'pharmacy@example.test' }),
    });
    const [sharedWork] =
      await sql`select id from memory_work where source_id = ${sharedSource.source.source_id}`;
    await runExtractionWork({ sql, boss, journal: memory.routes.journal }, String(sharedWork?.id));
    await buildViews(sql, ownerScope);
    const claims = (await listClaims(sql, ownerScope)).claims;
    const clinic = claims.find((claim) => claim.current.content === 'clinic@example.test');
    expect(clinic?.audience ?? 'private').toBe('private');

    const ownersJob = await claimedJob(world.ownerId, world.sharedId, 'Owner errand');
    const membersJob = await claimedJob(world.memberId, world.sharedId, 'Member errand');
    const ownerReads = await memory.scopeForJob(ownersJob.jobId);
    expect(ownerReads).toMatchObject({ role: 'owner', audience: 'private' });
    expect(
      (await recall(sql, ownerReads, { query: 'clinic' })).items.map((item) => item.content),
    ).toEqual(['clinic@example.test']);
    const memberReads = await memory.scopeForJob(membersJob.jobId);
    expect(JSON.stringify(await recall(sql, memberReads, { query: 'clinic' }))).not.toContain(
      'clinic@example.test',
    );
    // What the space shares, the member's job does recall.
    expect(
      (await recall(sql, memberReads, { query: 'pharmacy' })).items.map((item) => item.content),
    ).toEqual(['pharmacy@example.test']);
    // The member reads as a member: what the space shares, fenced by their membership.
    expect(memberReads).toMatchObject({
      role: 'reader',
      audience: 'space',
      principalId: world.memberId,
    });
  }, 60_000);

  test("a member reading the shared space's memory sees no claim private to the owner", async () => {
    const { app } = database();
    const read = (cookie: string) =>
      app.request('/memory/claims', {
        headers: { cookie, 'x-melete-space': world.sharedId },
      });
    const owners = await read(world.ownerCookie);
    expect(owners.status).toBe(200);
    expect(await owners.text()).toContain('clinic@example.test');
    const members = await read(world.memberCookie);
    const membersText = await members.text();
    expect(membersText).not.toContain('clinic@example.test');
    expect([members.status, membersText]).toEqual([200, expect.stringContaining('"claims"')]);
  }, 60_000);

  test("a member's own job in a shared space is offered no connection the owner installed", async () => {
    const calendar = await installCalendar(world.sharedId, 'Owner calendar');
    const owners = await claimedJob(world.ownerId, world.sharedId, 'Owner plans');
    const members = await claimedJob(world.memberId, world.sharedId, 'Member plans');
    // The owner keeps the use of what they installed.
    expect(await calendarTools(owners.claims)).not.toEqual([]);
    expect((await event(owners.claims, calendar, 'Owner dinner')).requires_approval).toBe(true);
    // The member's job neither holds the scopes, nor is offered the tools, nor may act.
    expect(members.claims.scopes.filter((scope) => scope.startsWith('calendar'))).toEqual([]);
    expect(await calendarTools(members.claims)).toEqual([]);
    expect(await rejectionOf(event(members.claims, calendar, 'Member dinner'))).toMatchObject({
      code: 'scope_denied',
    });
    // Even a token that names the scopes outright is refused the owner's connection.
    const named = {
      ...members.claims,
      scopes: [...members.claims.scopes, ...calendarManifest.tools.map((tool) => tool.name)],
    };
    expect(await calendarTools(named)).toEqual([]);
    expect(await rejectionOf(event(named, calendar, 'Member lunch'))).toMatchObject({
      code: 'scope_denied',
    });
  }, 60_000);

  test('an approved effect is not sent through a connection that no longer serves its job', async () => {
    const { sql, broker } = database();
    const calendar = await installCalendar(world.sharedId, 'Owner second calendar');
    const owners = await claimedJob(world.ownerId, world.sharedId, 'Owner later plans');
    const asked = await event(owners.claims, calendar, 'Owner later dinner');
    await broker.decide(asked.action_id, {
      decision: 'approved',
      payload_hash: asked.payload_hash,
    });
    await broker.admit(owners.claims, asked.action_id, asked.payload_hash);
    // Before it is sent, the connection is given to the room instead.
    await sql`update connection set shared_use = 'room' where id = ${calendar}`;
    const outcome = await broker.dispatch(asked.action_id).catch((error: unknown) => error);
    expect(outcome).not.toMatchObject({ status: 'succeeded' });
    const [sent] = await sql`select status from action where id = ${asked.action_id}`;
    expect(sent?.status).not.toBe('succeeded');
  }, 60_000);

  test("a member's job cannot watch a connection the owner installed, and a trigger made before hears nothing from it", async () => {
    const { sql, jobs, runner } = database();
    const triggers = new TriggerService(jobs, runner);
    const mailbox = await installMailbox(world.sharedId, 'Owner mailbox');
    const spec = {
      kind: 'event' as const,
      connection_id: mailbox,
      event_name: 'mail.new',
      poll_seconds: 300,
    };
    const owners = await claimedJob(world.ownerId, world.sharedId, 'Owner chase', ['acme.test']);
    const members = await claimedJob(world.memberId, world.sharedId, 'Member chase', ['acme.test']);
    expect(await rejectionOf(triggers.create(members.jobId, spec))).toMatchObject({
      code: 'unknown_connection',
    });
    const ownTrigger = await triggers.create(owners.jobId, spec);
    // A trigger the member's job already held before the rule.
    const earlier = recordId('trg');
    await sql`insert into trigger (id, job_id, kind, spec, cursor)
      values (${earlier}, ${members.jobId}, 'event', ${JSON.stringify(spec)}::jsonb, '0')`;
    // Both have written to the company, so both would have the mailbox read for replies.
    for (const sender of [owners, members]) {
      const id = recordId('act');
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, resolved_at)
        values (${id}, ${sender.jobId}, ${sender.claims.attempt_id}, ${mailbox}, 'test.send',
          'write_external', '{}'::jsonb, ${canonicalizePayload({}).hash}, ${id}, 'succeeded', now())`;
    }
    const polled = (await readCandidates(sql)).map((candidate) => candidate.jobId);
    expect(polled).toContain(owners.jobId);
    expect(polled).not.toContain(members.jobId);

    for (const [waiting, triggerId] of [
      [owners, ownTrigger.id],
      [members, earlier],
    ] as const)
      await runner.commitOutcome(waiting.claims, {
        kind: 'waiting_for_event_or_time',
        wait: { kind: 'event', trigger_id: triggerId, deadline_at: null },
      });
    await triggers.deliver({
      connection_id: mailbox,
      event_name: 'mail.new',
      cursor: 'mailbox-1',
      dedup_key: 'mailbox-1',
      payload: { from: 'cfo@acme.test', subject: 'Owner private: settlement offer' },
    });
    const heard = async (jobId: string) =>
      JSON.stringify(await sql`select payload from event where job_id = ${jobId}`);
    expect(await heard(owners.jobId)).toContain('settlement offer');
    expect(await heard(members.jobId)).not.toContain('settlement offer');
    const [still] = await sql`select state from job where id = ${members.jobId}`;
    expect(still?.state).toBe('waiting_for_event_or_time');
  }, 60_000);

  test("a member's own personal space keeps every connection they installed", async () => {
    const calendar = await installCalendar(world.memberSpaceId, 'Member calendar');
    const own = await claimedJob(world.memberId, world.memberSpaceId, 'Member own plans');
    expect(await calendarTools(own.claims)).not.toEqual([]);
    expect((await event(own.claims, calendar, 'Member own dinner')).requires_approval).toBe(true);
  }, 60_000);

  test('an approval records the person who decided it', async () => {
    const { sql, broker } = database();
    const calendar = (
      await sql`select id from connection where space_id = ${world.memberSpaceId}
        and provider = ${calendarManifest.provider} limit 1`
    )[0]?.id as string;
    const own = await claimedJob(world.memberId, world.memberSpaceId, 'Member decides');
    const asked = await event(own.claims, calendar, 'Member decides dinner');
    const effects = new ExperienceEffects(sql, broker, registry);
    const permissions = new ExperiencePermissions(sql, broker, effects);
    await principalContext.run(world.memberId, async () => {
      const card = await permissions.card(world.memberSpaceId, asked.approval_id ?? '');
      await permissions.decide(world.memberSpaceId, card.id, {
        option: 'allow_once',
        version: card.version,
      });
    });
    const [decided] = await sql`select decision, decided_by from approval
      where id = ${asked.approval_id}`;
    expect(decided).toEqual({ decision: 'approved', decided_by: world.memberId });

    // A decision made with the operator's approval key names no person.
    const approvalKey = 'shared-space-scope-approval-key-32-bytes';
    const service = createBrokerApp({
      broker,
      capabilityKey: 'shared-space-scope-signing-key-32-bytes',
      approvalKey,
    });
    const deny = (actionId: string, payloadHash: string) =>
      service.request(`/actions/${actionId}/deny`, {
        method: 'POST',
        headers: { authorization: `Bearer ${approvalKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload_hash: payloadHash }),
      });
    const denied = await event(own.claims, calendar, 'Member decides lunch');
    expect((await deny(denied.action_id, denied.payload_hash)).status).toBe(200);
    const [refused] = await sql`select decision, decided_by from approval
      where id = ${denied.approval_id}`;
    expect(refused).toEqual({ decision: 'denied', decided_by: SERVICE_DECISION });
    // Pressing Deny again agrees with it.
    const again = await deny(denied.action_id, denied.payload_hash);
    expect([again.status, await again.json()]).toEqual([
      200,
      expect.objectContaining({ decision: 'denied' }),
    ]);
  }, 60_000);
});
