import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityClaims, KnowledgeFrontmatter } from '@melete/contracts';
import { serializeRecord } from '@melete/knowledge';
import { eq } from 'drizzle-orm';
import { PostgresGatewayBudget } from '../../src/broker/gateway-budget.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { openDatabase } from '../../src/db/client.ts';
import { attempt, event, type job, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { EventStream } from '../../src/events/stream.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { requireCurrentAttempt } from '../../src/jobs/fence.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { DEFAULT_BUDGET, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { memoryScopeForSpace } from '../../src/memory/broker-trust.ts';
import { lockSpace, type MemoryScope } from '../../src/memory/db.ts';
import { resolveTrustIn } from '../../src/memory/trust.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const key = 'principal-capability-test-key-at-least-32-bytes';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key }) : null;
const stream = handle ? new EventStream(handle, { keepaliveMs: 25, pollIntervalMs: 25 }) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-w14-principals-'));
const withDb = jobs ? describe : describe.skip;
async function refusal(operation: Promise<unknown>) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  return caught as { code: string };
}
const cookie = (response: Response) => {
  const result = response.headers.get('set-cookie')?.split(';')[0];
  if (!result) throw new Error(`Expected a login cookie (${response.status})`);
  return result;
};
const request = (token: string, body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { Cookie: token, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

withDb('principal and shared-space authority', () => {
  afterAll(async () => {
    await stream?.close();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  test('additive migration preserves the setup guard, login and an issued personal-space capability', async () => {
    if (!handle || !queue) throw new Error('Postgres unavailable');
    const name = `melete_w14_upgrade_${randomBytes(8).toString('hex')}`;
    await handle.sql`create database ${handle.sql(name)}`;
    const url = new URL(handle.url);
    url.pathname = `/${name}`;
    const upgrade = openDatabase(url.toString(), 2);
    try {
      const migrations = new URL('../../drizzle/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0015')
        .sort())
        await upgrade.sql.unsafe(await readFile(new URL(file, migrations), 'utf8'));
      const ownerId = newId('own');
      const spaceId = newId('sp');
      const jobId = newId('job');
      const attemptId = newId('att');
      const passwordHash = await Bun.password.hash('upgrade-password', { algorithm: 'argon2id' });
      const token = randomBytes(32).toString('base64url');
      await upgrade.sql`insert into owner (id, email, password_hash) values (${ownerId}, 'legacy@example.test', ${passwordHash})`;
      await upgrade.sql`insert into space (id, name, git_path) values (${spaceId}, 'Personal', ${join(root, spaceId)})`;
      await upgrade.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget) values (${jobId}, ${spaceId}, 'Legacy job', 'Finish legacy work', 'running', 1, ${JSON.stringify(DEFAULT_BUDGET)}::jsonb)`;
      await upgrade.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, lease_expires_at) values (${attemptId}, ${jobId}, 1, 'legacy', 'stub', 'script', now() + interval '1 minute')`;
      await upgrade.sql`insert into session (token_hash, owner_id, expires_at) values (${createHash('sha256').update(token).digest('hex')}, ${ownerId}, now() + interval '1 minute')`;
      await upgrade.sql.unsafe(
        await readFile(new URL('0015_petite_demogoblin.sql', migrations), 'utf8'),
      );
      const api = createApp({
        env: loadEnv({ NODE_ENV: 'test' }),
        db: upgrade.db,
        checkDatabase: async () => 'ok',
      });
      expect(
        (await api.request('/me', { headers: { Cookie: `melete_session=${token}` } })).status,
      ).toBe(200);
      expect(
        (
          await api.request(
            '/login',
            request('', { email: 'legacy@example.test', password: 'upgrade-password' }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await api.request(
            '/setup',
            request('', { email: 'second@example.test', password: 'upgrade-password' }),
          )
        ).status,
      ).toBe(409);
      const legacy: CapabilityClaims = {
        job_id: jobId,
        attempt_id: attemptId,
        space_id: spaceId,
        epoch: 1,
        revision: 0,
        scopes: [],
        budget: { max_actions: 10, max_output_tokens: 8000, max_usd_est: 1 },
        exp: Math.floor(Date.now() / 1000) + 60,
      };
      expect(
        await new BrokerService({ sql: upgrade.sql, connectors: new Map() }).catalog(legacy),
      ).toEqual([]);
      const legacyJobs = new JobService(upgrade.db, queue.boss);
      expect(
        (await legacyJobs.transaction((tx) => requireCurrentAttempt(tx, legacy))).job.principalId,
      ).toBe(ownerId);
      const [identity] = await upgrade.sql`select count(*)::int as count from principal`;
      expect(identity?.count).toBe(1);
    } finally {
      await upgrade.close();
      await handle.sql`drop database ${handle.sql(name)} with (force)`;
    }
  }, 15_000);

  test('member bundles select at most three shared skills; revocation fences work, replay, knowledge and old capabilities', async () => {
    if (!handle || !jobs || !runner || !stream) throw new Error('Postgres unavailable');
    const api = createApp({
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      db: handle.db,
      jobs,
      events: stream,
      checkDatabase: async () => 'ok',
    });
    const setup = await api.request(
      '/setup',
      request('', { email: 'owner@example.test', password: 'test-password' }),
    );
    expect(setup.status).toBe(201);
    const ownerCookie = cookie(setup);
    const ownerId = ((await setup.json()) as { owner: { id: string } }).owner.id;
    const created = await api.request(
      '/principals',
      request(ownerCookie, { email: 'member@example.test', password: 'member-password' }),
    );
    expect(created.status).toBe(201);
    const memberId = ((await created.json()) as { principal: { id: string } }).principal.id;
    const memberCookie = cookie(
      await api.request(
        '/login',
        request('', { email: 'member@example.test', password: 'member-password' }),
      ),
    );
    const spacesFor = async (token: string) =>
      (
        (await (await api.request('/spaces', { headers: { Cookie: token } })).json()) as {
          spaces: Array<{ id: string }>;
        }
      ).spaces.map((row) => row.id);
    const ownerPersonal = (await spacesFor(ownerCookie))[0];
    const memberPersonal = (await spacesFor(memberCookie))[0];
    if (!ownerPersonal || !memberPersonal) throw new Error('Expected two personal spaces');
    expect(ownerPersonal).not.toBe(memberPersonal);
    expect(await spacesFor(memberCookie)).not.toContain(ownerPersonal);
    expect(
      (
        await api.request(
          '/principals',
          request(memberCookie, { email: 'third@example.test', password: 'third-password' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request(
          '/setup',
          request('', { email: 'third@example.test', password: 'third-password' }),
        )
      ).status,
    ).toBe(409);
    const sharedResponse = await api.request(
      '/spaces/shared',
      request(ownerCookie, { name: 'Shared procedures' }),
    );
    expect(sharedResponse.status).toBe(201);
    const sharedId = ((await sharedResponse.json()) as { space: { id: string } }).space.id;
    expect(await spacesFor(memberCookie)).not.toContain(sharedId);
    expect(
      (
        await api.request(
          `/spaces/${sharedId}/memberships`,
          request(ownerCookie, { principal_id: memberId }),
        )
      ).status,
    ).toBe(201);
    expect(await spacesFor(memberCookie)).toContain(sharedId);
    const sharedRoot = join(root, sharedId);
    await mkdir(join(sharedRoot, 'skills'), { recursive: true });
    await mkdir(join(sharedRoot, 'knowledge'), { recursive: true });
    const putSkill = async (name: string, audience: string, body: string) =>
      writeFile(
        join(sharedRoot, 'skills', `${name}.md`),
        `---\nname: ${name}\ndescription: Shared practice\ntriggers: ["orbit-check"]\naudience: ${audience}\nmax_tokens: 400\n---\n${body}\n`,
      );
    for (const name of ['orbit-a', 'orbit-b', 'orbit-c', 'orbit-d'])
      await putSkill(name, `space:${sharedId}`, 'Use the shared checklist.');
    await putSkill('owner-secret', 'private', 'OWNER_PRIVATE_SKILL');
    await putSkill('wrong-space', `space:${ownerPersonal}`, 'WRONG_SPACE_SKILL');
    const record = (audience: KnowledgeFrontmatter['audience'], body: string) => {
      const id = newId('k');
      const frontmatter: KnowledgeFrontmatter = {
        id,
        title: 'Orbit checklist',
        space: sharedId,
        audience,
        type: 'procedure',
        status: 'active',
        confidence: 'high',
        asserted_by: 'user',
        source: { kind: 'statement', ref: 'owner-publication', quote: '', sha256: null },
        observed_at: '2026-09-12',
        valid_from: '2026-09-12',
        valid_until: null,
        supersedes: [],
        superseded_by: null,
        created: '2026-09-12',
        updated: '2026-09-12',
        tags: [],
        links: [],
        schema_version: 1,
      };
      return { id, text: serializeRecord(frontmatter, body) };
    };
    const sharedKnowledge = record('space', 'SHARED_KNOWLEDGE');
    const privateKnowledge = record('private', 'OWNER_PRIVATE_KNOWLEDGE');
    await writeFile(join(sharedRoot, 'knowledge', 'shared.md'), sharedKnowledge.text);
    await writeFile(join(sharedRoot, 'knowledge', 'private.md'), privateKnowledge.text);
    const admissionIds = new Map<string, string>();
    const createJob = async (token: string, spaceId: string, title: string) => {
      const response = await api.request(
        '/jobs',
        request(token, { space_id: spaceId, title, objective: 'orbit-check' }),
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        job: { id: string };
        receipt: { submission_id: string };
      };
      admissionIds.set(payload.job.id, payload.receipt.submission_id);
      return jobs.get(payload.job.id);
    };
    const privateJob = await createJob(ownerCookie, ownerPersonal, 'OWNER_PRIVATE_OBJECTIVE');
    const privateSharedJob = await createJob(ownerCookie, sharedId, 'OWNER_SHARED_PRIVATE');
    const active = await createJob(memberCookie, sharedId, 'Shared job');
    const queued = await createJob(memberCookie, sharedId, 'Queued shared job');
    const personal = await createJob(memberCookie, memberPersonal, 'Member personal job');
    const claim = async (row: typeof job.$inferSelect) => {
      const result = await runner.claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      if (!result) throw new Error('Expected an admitted attempt');
      return result;
    };
    const claimed = await claim(active);
    expect(claimed.claims.principal_id).toBe(memberId);
    expect(claimed.bundle.skills.map((skill) => skill.name)).toEqual([
      'orbit-a',
      'orbit-b',
      'orbit-c',
    ]);
    expect(JSON.stringify(claimed.bundle)).toContain('SHARED_KNOWLEDGE');
    expect(JSON.stringify(claimed.bundle)).not.toContain('OWNER_PRIVATE');
    expect(JSON.stringify(claimed.bundle)).not.toContain('WRONG_SPACE');
    const skillsResponse = await api.request('/skills', {
      headers: { Cookie: memberCookie, 'x-melete-space': sharedId },
    });
    expect(skillsResponse.status).toBe(200);
    expect(await skillsResponse.text()).not.toContain('owner-secret');
    expect(
      (
        await api.request(`/knowledge/${privateKnowledge.id}`, {
          headers: { Cookie: memberCookie, 'x-melete-space': sharedId },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request('/skills', {
          headers: { Cookie: memberCookie, 'x-melete-space': ownerPersonal },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api.request(`/jobs/${privateJob.id}`, { headers: { Cookie: memberCookie } })).status,
    ).toBe(403);
    expect(
      (await api.request(`/jobs/${privateSharedJob.id}`, { headers: { Cookie: memberCookie } }))
        .status,
    ).toBe(403);
    expect(
      await (await api.request('/snapshot', { headers: { Cookie: memberCookie } })).text(),
    ).not.toContain(privateSharedJob.id);
    expect(
      await (await api.request('/jobs', { headers: { Cookie: memberCookie } })).text(),
    ).not.toContain('OWNER_PRIVATE_OBJECTIVE');
    expect(
      await (await api.request('/snapshot', { headers: { Cookie: memberCookie } })).text(),
    ).not.toContain(privateJob.id);
    expect(
      await (await api.request('/snapshot', { headers: { Cookie: ownerCookie } })).text(),
    ).not.toContain(personal.id);
    const privateAdmission = admissionIds.get(privateSharedJob.id);
    if (!privateAdmission) throw new Error('Expected the private job admission receipt');
    expect(
      (await api.request(`/submissions/${privateAdmission}`, { headers: { Cookie: memberCookie } }))
        .status,
    ).toBe(403);
    // A restore retaining only the event marker must not expose another principal's digest.
    await handle.sql`delete from submission where submission_id = ${privateAdmission}`;
    await handle.sql`delete from acceptance_journal where submission_id = ${privateAdmission}`;
    expect((await new SubmissionService(jobs).get(privateAdmission)).state).toBe(
      'unknown_durability',
    );
    expect(
      (await api.request(`/submissions/${privateAdmission}`, { headers: { Cookie: memberCookie } }))
        .status,
    ).toBe(403);
    expect(
      (await api.request(`/submissions/${privateAdmission}`, { headers: { Cookie: ownerCookie } }))
        .status,
    ).toBe(200);
    const broker = new BrokerService({ sql: handle.sql, connectors: new Map() });
    expect(await broker.catalog(claimed.claims)).toEqual([]);
    const {
      principal_id: ignored,
      membership_generation: ignoredGeneration,
      ...legacyClaims
    } = claimed.claims;
    void ignored;
    void ignoredGeneration;
    expect((await refusal(broker.catalog(legacyClaims as CapabilityClaims))).code).toBe(
      'scope_denied',
    );
    expect((await refusal(broker.catalog({ ...claimed.claims, principal_id: ownerId }))).code).toBe(
      'scope_denied',
    );
    const gateway = new PostgresGatewayBudget({ sql: handle.sql, capabilityKey: key });
    const gatewayIdentity = await gateway.authenticate(claimed.bundle.attempt.token);
    // A member cannot spend an owner's private source handle as trusted evidence.
    await handle.sql`insert into memory_spaces (space_id, owner_id, restore_ready) values (${sharedId}, ${ownerId}, true)`;
    const sourceId = `src_${newId('k').slice(2)}`;
    await handle.sql`insert into memory_sources (id, space_id, owner_id, publisher, stream, source_identity, source_version, stream_sequence, source_type, event_at, audience, eligibility_generation, content_length, origin_trust)
      values (${sourceId}, ${sharedId}, ${ownerId}, 'fixture', 'private', 'private-source', '1', 1, 'manual_note', now(), 'private', 1, 24, 'owner')`;
    await handle.sql`insert into memory_source_content (source_id, content) values (${sourceId}, 'private-recipient@example.test')`;
    const memberScope = await handle.sql.begin((tx) => memoryScopeForSpace(tx, sharedId, memberId));
    expect(memberScope?.role).toBe('reader');
    if (!memberScope) throw new Error('Expected member scope');
    const privateTrust = await handle.sql.begin((tx) =>
      resolveTrustIn(tx, memberScope, {
        payload: { to: 'private-recipient@example.test' },
        handles: [`${sourceId}@1`],
      }),
    );
    expect(privateTrust.fields).toEqual([]);
    const ownerScope = await handle.sql.begin((tx) => memoryScopeForSpace(tx, sharedId, ownerId));
    if (!ownerScope) throw new Error('Expected owner scope');
    const ownerTrust = await handle.sql.begin((tx) =>
      resolveTrustIn(tx, ownerScope, {
        payload: { to: 'private-recipient@example.test' },
        handles: [`${sourceId}@1`],
      }),
    );
    expect(ownerTrust.fields).toHaveLength(1);
    await handle.sql`insert into memory_contexts (id, space_id, job_id, attempt_id, job_revision, policy_generation, data_revision, access_generation, audience, purpose, items, recipe, token_budget, recall_status)
      values ('shared-delivery', ${sharedId}, ${active.id}, ${claimed.claims.attempt_id}, 0, 1, 0, 1, '["space"]', 'responsibility', '[{"excerpt":"SHARED_KNOWLEDGE"}]', 'fixture', '{}', 'complete')`;
    const abort = new AbortController();
    const replay = await stream.response({
      after: 0,
      jobId: active.id,
      principalId: memberId,
      resync: true,
      signal: abort.signal,
    });
    const reader = replay.body?.getReader();
    if (!reader) throw new Error('Expected replay stream');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(active.id);
    const revoked = await api.request(
      `/spaces/${sharedId}/memberships/${memberId}`,
      request(ownerCookie, undefined, 'DELETE'),
    );
    expect(revoked.status).toBe(200);
    expect(
      ((await revoked.json()) as { membership: { generation: number } }).membership.generation,
    ).toBe(1);
    expect((await jobs.get(active.id)).state).toBe('cancelled');
    expect((await jobs.get(queued.id)).state).toBe('cancelled');
    expect(
      await runner.claim({
        job_id: queued.id,
        expected_epoch: queued.leaseEpoch,
        expected_version: queued.stateVersion,
        reason: 'created',
      }),
    ).toBeNull();
    const [execution] = await handle.db
      .select()
      .from(attempt)
      .where(eq(attempt.id, claimed.claims.attempt_id));
    expect(execution?.outcome).toBe('fenced');
    expect(
      await handle.db.select().from(event).where(eq(event.type, 'context_invalidated')),
    ).not.toHaveLength(0);
    expect((await refusal(broker.catalog(claimed.claims))).code).toBe('stale_epoch');
    expect(
      (
        await refusal(
          gateway.reserve({
            principal: gatewayIdentity,
            requestId: 'revoked',
            provider: 'stub',
            model: 'script',
            estimatedTokens: 10,
            maxOutputTokens: 5,
          }),
        )
      ).code,
    ).toBe('stale_epoch');
    expect(
      (await api.request(`/jobs/${active.id}`, { headers: { Cookie: memberCookie } })).status,
    ).toBe(403);
    expect(
      (await api.request(`/jobs/${active.id}/events`, { headers: { Cookie: memberCookie } }))
        .status,
    ).toBe(403);
    expect(
      (
        await api.request(
          '/jobs',
          request(memberCookie, {
            space_id: sharedId,
            title: 'Refused reuse',
            objective: 'orbit-check',
          }),
        )
      ).status,
    ).toBe(403);
    expect(await spacesFor(memberCookie)).not.toContain(sharedId);
    expect(
      (await refusal(handle.sql.begin((tx) => lockSpace(tx, memberScope as MemoryScope, false))))
        .code,
    ).toBe('scope_denied');
    const [memoryFence] =
      await handle.sql`select access_generation from memory_spaces where space_id = ${sharedId}`;
    expect(memoryFence?.access_generation).toBe(2);
    const [delivered] =
      await handle.sql`select items, invalidated_at from memory_contexts where id = 'shared-delivery'`;
    expect(delivered?.items).toEqual([]);
    expect(delivered?.invalidated_at).not.toBeNull();
    expect(
      await (await api.request('/snapshot', { headers: { Cookie: memberCookie } })).text(),
    ).not.toContain(active.id);
    expect(
      (
        await refusal(
          jobs.transaction((tx) =>
            buildBundle(
              tx,
              active,
              { id: newId('att'), epoch: 2, revision: 0, token: 'refused' },
              claimed.bundle.model,
              0,
            ),
          ),
        )
      ).code,
    ).toBe('scope_denied');
    const fresh = await claim(personal);
    expect(fresh.bundle.skills).not.toContainEqual(expect.objectContaining({ space_id: sharedId }));
    expect(JSON.stringify(fresh.bundle)).not.toContain('SHARED_KNOWLEDGE');
    expect(JSON.stringify(fresh.bundle)).not.toContain('OWNER_PRIVATE');
    abort.abort();
    await reader.cancel();
    expect(
      (
        await api.request(
          `/spaces/${sharedId}/memberships`,
          request(ownerCookie, { principal_id: memberId }),
        )
      ).status,
    ).toBe(201);
    expect((await refusal(broker.catalog(claimed.claims))).code).toBe('stale_epoch');
    const regranted = await claim(await createJob(memberCookie, sharedId, 'Regranted work'));
    expect(regranted.claims.membership_generation).toBe(2);
    expect(regranted.bundle.skills).toHaveLength(3);
    const [parent] = await handle.db.select().from(space).where(eq(space.id, sharedId));
    expect(parent?.policyGeneration).toBe(1);
  }, 30_000);
});
