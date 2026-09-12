import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalizePayload, ID_PREFIXES } from '@melete/contracts';
import { createInternalServer } from '../apps/melete/src/broker/internal-server.ts';
import { pendingRuntimeWait } from '../apps/melete/src/broker/runtime-wait.ts';
import { ConnectorRegistry } from '../apps/melete/src/connectors/registry.ts';
import { loadEnv } from '../apps/melete/src/env.ts';
import { newId } from '../apps/melete/src/ids.ts';
import { bootstrap } from '../apps/melete/src/index.ts';
import { commitExtraction } from '../apps/melete/src/memory/commit.ts';
import type { MemoryScope } from '../apps/melete/src/memory/db.ts';
import { FileRestrictionJournal, restoreMemory } from '../apps/melete/src/memory/restore.ts';
import { buildViews } from '../apps/melete/src/memory/views.ts';
import { claimWork, MEMORY_EXTRACT_QUEUE } from '../apps/melete/src/memory/work.ts';
import { fixtureConnector, initializeDestination, SCOPES } from './destination.ts';
import type { GradeContext, Snapshot } from './grading.ts';
import { ScriptedModel } from './scripted.ts';
import { API_PORT, BROKER_PORT, ContainerRuntime, openStack, PRIVATE } from './stack.ts';
import { MODEL, type State } from './state.ts';
import { meteredTransport } from './transport.ts';
import type { Domain, Scenario } from './types.ts';

const json = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
export async function openLab(
  state: State,
  provider: 'fireworks' | 'scripted',
  apiKey?: string,
  slot = 0,
  sharedStack?: Awaited<ReturnType<typeof openStack>>,
) {
  if (provider === 'fireworks' && !apiKey) throw new Error('Fireworks requires FIREWORKS_API_KEY');
  const base = sharedStack ?? (await openStack());
  const apiPort = API_PORT + slot * 10;
  const brokerPort = BROKER_PORT + slot * 10;
  const stack = { ...base, brokerUrl: `http://${base.gateway}:${brokerPort}` };
  const connectors = new ConnectorRegistry();
  const scripted = new ScriptedModel();
  let core: Awaited<ReturnType<typeof bootstrap>>;
  const runtime = new ContainerRuntime(
    stack,
    async (bundle) => {
      if (!core.handle) throw new Error('Lab database is unavailable');
      const rows = await core.handle
        .sql`SELECT id FROM action WHERE job_id=${bundle.attempt.job_id} AND status='needs_approval' ORDER BY id`;
      return rows.map((row) => String(row.id));
    },
    async (bundle) => (core.handle ? pendingRuntimeWait(core.handle.sql, bundle) : null),
  );
  const env = loadEnv({
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: stack.databaseUrl,
    MELETE_CAPABILITY_KEY: stack.secrets.capability,
    MELETE_APPROVAL_KEY: stack.secrets.approval,
    MELETE_RUNTIME_ADAPTER: 'external',
    MELETE_DEFAULT_PROVIDER: provider,
    MELETE_DEFAULT_MODEL: provider === 'fireworks' ? MODEL : 'scripted',
    MELETE_SPACES_DIR: resolve(PRIVATE, 'spaces'),
    MELETE_ARTIFACTS_DIR: resolve(PRIVATE, 'artifacts'),
    MELETE_WORK_DIR: '/work',
  });
  core = await bootstrap({ env, runtime, workers: false });
  if (!core.handle || !core.runner || !core.jobs || !core.queue)
    throw new Error('Lab requires database-backed services');
  const { handle, runner, jobs, queue } = core;
  // Fixture evidence is seeded deterministically; paid inference belongs to the evaluated turns.
  await core.memory?.stop();
  await queue.boss.offWork(MEMORY_EXTRACT_QUEUE);
  runner.options.scopes = SCOPES;
  const sql = handle.sql;
  await initializeDestination(sql);
  await sql`CREATE TABLE IF NOT EXISTS eval_runtime_event (
    attempt_id text NOT NULL, local_seq integer NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY(attempt_id,local_seq))`;
  await sql`CREATE TABLE IF NOT EXISTS eval_runtime_bundle (attempt_id text PRIMARY KEY, knowledge jsonb NOT NULL)`;
  runtime.observe = async (bundle, event) => {
    await sql`INSERT INTO eval_runtime_bundle(attempt_id,knowledge) VALUES(${bundle.attempt.id},${JSON.stringify(bundle.knowledge)}::jsonb) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO eval_runtime_event(attempt_id,local_seq,payload)
      VALUES(${event.attempt_id},${event.local_seq},${JSON.stringify(event)}::jsonb) ON CONFLICT DO NOTHING`;
  };
  const journal = new FileRestrictionJournal(resolve(PRIVATE, 'spaces/.memory/restrictions.jsonl'));
  try {
    await readFile(journal.path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await journal.initializeNew();
  }
  await restoreMemory(sql, journal);
  let ownerId = '';
  const boundary = createInternalServer({
    sql,
    connectors,
    capabilityKey: stack.secrets.capability,
    approvalKey: stack.secrets.approval,
    boss: queue.boss,
    defaultProvider: provider,
    providers: [
      {
        name: provider,
        baseUrl:
          provider === 'fireworks'
            ? 'https://api.fireworks.ai/inference/v1/'
            : 'https://scripted.evals.invalid/v1/',
        apiKey: apiKey ?? 'eval-scripted-token',
        protocols: ['chat/completions'],
      },
    ],
    gatewayFetch:
      provider === 'fireworks'
        ? meteredTransport(state, 'agent')
        : (request) => scripted.fetch(request),
  });
  await new Promise<void>((done, reject) => {
    boundary.server.once('error', reject);
    boundary.server.listen(brokerPort, stack.gateway, done);
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: apiPort, fetch: core.app.fetch });
  let cookie = '';
  async function api(
    path: string,
    method = 'GET',
    body?: unknown,
    idem?: string,
    spaceId?: string,
  ) {
    const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...(idem ? { 'Idempotency-Key': idem } : {}),
        ...(spaceId ? { 'x-melete-space': spaceId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    const value = (await response.json()) as Record<string, unknown>;
    return { status: response.status, value };
  }
  const credentials = { email: 'eval-owner@example.test', password: stack.secrets.password };
  const setup = await api('/setup', 'POST', credentials);
  const login = setup.status === 409 ? await api('/login', 'POST', credentials) : setup;
  if (login.status !== 200 && login.status !== 201)
    throw new Error(`Lab authentication failed with HTTP ${login.status}`);
  ownerId = String((login.value.owner as { id: string }).id);
  // Reattach only this lab's fixture connections after a resumed process.
  const existing =
    await sql`SELECT id, label FROM connection WHERE provider='test' AND label LIKE 'eval:%'`;
  for (const row of existing)
    connectors.register(
      String(row.id),
      fixtureConnector(sql, String(row.label).slice(5) as Domain),
    );
  await boundary.broker.recoverDispatched();
  await runner.recover();

  async function snapshot(jobId: string): Promise<Snapshot> {
    const [row] = await sql`SELECT state, revision FROM job WHERE id=${jobId}`;
    if (!row) throw new Error('Evaluation job disappeared');
    const actions =
      await sql`SELECT id,kind,effect_class,status,payload_hash,canonical_payload,receipt FROM action WHERE job_id=${jobId} ORDER BY created_at,id`;
    const approvals =
      await sql`SELECT p.id,p.action_id,p.decision,p.payload_hash,p.job_revision FROM approval p JOIN action a ON a.id=p.action_id WHERE a.job_id=${jobId} ORDER BY p.id`;
    const dispatches =
      await sql`SELECT action_id,kind,payload,external_effect FROM eval_dispatch WHERE job_id=${jobId} ORDER BY seq`;
    const deliveries =
      await sql`SELECT action_id,kind,payload_hash,payload,approval,job_revision FROM eval_destination WHERE job_id=${jobId} ORDER BY seq`;
    const receipts =
      await sql`SELECT payload FROM event WHERE job_id=${jobId} AND payload->>'phase'='model_receipt' ORDER BY seq`;
    const reactions =
      await sql`SELECT payload FROM event WHERE job_id=${jobId} AND type='reaction' AND payload->>'by'='assistant' ORDER BY seq`;
    const attempts =
      await sql`SELECT id,epoch,outcome,outcome_detail FROM attempt WHERE job_id=${jobId} ORDER BY epoch`;
    const latest = attempts.at(-1);
    const [delivered] = latest
      ? await sql`SELECT knowledge FROM eval_runtime_bundle WHERE attempt_id=${latest.id}`
      : [];
    let reply = '';
    if (latest) {
      const events =
        await sql`SELECT payload FROM eval_runtime_event WHERE attempt_id=${latest.id} ORDER BY local_seq`;
      for (const entry of events) {
        const event = entry.payload as {
          type: string;
          text?: string;
          outcome?: { summary?: string };
        };
        if (event.type === 'text_delta') reply += event.text ?? '';
        if (event.type === 'attempt_outcome' && event.outcome?.summary)
          reply = event.outcome.summary;
      }
    }
    return json<Snapshot>({
      state: row.state,
      revision: row.revision,
      actions,
      approvals,
      dispatches,
      deliveries,
      model_receipts: receipts.map((entry) => entry.payload),
      reply,
      attempts: attempts.length,
      delivered_memory: delivered?.knowledge ?? [],
      reactions: reactions.map((entry) => entry.payload),
    });
  }
  async function wake(jobId: string, minimumAttempts: number) {
    let current = await snapshot(jobId);
    if (current.attempts >= minimumAttempts && current.state !== 'running') return;
    if (current.state === 'running') {
      // A killed driver can leave a leased attempt. Wait for its real lease, then recover; never reset epochs by hand.
      const [lease] =
        await sql`SELECT lease_expires_at FROM attempt WHERE job_id=${jobId} AND ended_at IS NULL ORDER BY epoch DESC LIMIT 1`;
      if (lease?.lease_expires_at)
        await Bun.sleep(
          Math.max(
            0,
            Math.min(50_000, new Date(lease.lease_expires_at).getTime() - Date.now() + 100),
          ),
        );
      await runner.recover();
      current = await snapshot(jobId);
    }
    const row = await jobs.get(jobId);
    if (!row || !['queued', 'waiting_for_event_or_time'].includes(row.state)) return;
    await runner.handleWake({
      job_id: jobId,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'timer',
    });
  }
  async function seedMemory(spaceId: string, scenario: Scenario, key: string, correct = true) {
    const memory = scenario.memory;
    if (!memory) return undefined;
    const scope: MemoryScope = {
      ownerId,
      spaceId,
      publisher: 'authenticated-owner',
      audience: 'private',
      role: 'owner',
    };
    // The authenticated route provisions only this space and replays its retained
    // restrictions. A whole-database restore here would fence concurrent cells.
    const oldText = `${memory.key}: ${memory.old}`;
    const ingested = await api(
      '/memory/sources',
      'POST',
      {
        stream: 'evals',
        source_identity: key,
        source_version: '1',
        source_type: 'message',
        event_at: '2026-09-01T09:00:00Z',
        author: 'owner',
        text: oldText,
      },
      undefined,
      spaceId,
    );
    if (ingested.status !== 201) throw new Error(`Memory ingest returned HTTP ${ingested.status}`);
    let [claim] =
      await sql`SELECT id,head_revision FROM memory_claims WHERE space_id=${spaceId} AND domain_key=${memory.key}`;
    if (!claim) {
      const batch = await claimWork(sql, scope);
      if (!batch) throw new Error('Memory extraction work was not available');
      const result = await commitExtraction(sql, scope, batch, {
        proposals: [
          {
            op: 'add',
            expected_revision: null,
            domain_key: memory.key,
            key: memory.key,
            content: memory.old,
            kind: 'preference',
            factual_status: 'attributed',
            valid_from: '2026-09-01T09:00:00Z',
            valid_until: null,
            sources: [
              {
                source_id: batch.source.source_id,
                source_version: batch.source.source_version,
                start: 0,
                end: oldText.length,
                quote: oldText,
              },
            ],
          },
        ],
      });
      if (!result.claim_ids.length) throw new Error('Initial evidence did not produce a claim');
      [claim] =
        await sql`SELECT id,head_revision FROM memory_claims WHERE id=${result.claim_ids[0] ?? ''}`;
    }
    if (!claim) throw new Error('Claim missing after extraction');
    if (correct && Number(claim.head_revision) === 1) {
      const correction = await api(
        '/memory/corrections',
        'POST',
        {
          claim_id: claim.id,
          expected_revision: 1,
          text: `Correction: ${memory.corrected}`,
          content: memory.corrected,
          valid_from: '2026-09-02T09:00:00Z',
          valid_until: null,
          idempotency_key: `${key}:correction`,
        },
        undefined,
        spaceId,
      );
      if (correction.status !== 200)
        throw new Error(`Memory correction returned HTTP ${correction.status}`);
    }
    const [head] =
      await sql`SELECT c.head_revision,b.content FROM memory_claims c JOIN memory_revision_content b ON b.claim_id=c.id AND b.revision=c.head_revision WHERE c.id=${claim.id}`;
    await buildViews(sql, scope);
    const cell = state.get(key);
    const emptyId =
      typeof cell.data.empty_space_id === 'string'
        ? cell.data.empty_space_id
        : newId(ID_PREFIXES.space);
    state.update(key, cell.phase, { ...cell.data, empty_space_id: emptyId });
    await sql`INSERT INTO space(id,name,git_path) VALUES(${emptyId},'Empty recall control',${`evals/${emptyId}`}) ON CONFLICT DO NOTHING`;
    const empty = await api(
      '/memory/recall',
      'POST',
      { query: memory.key, max_tokens: 1800 },
      undefined,
      emptyId,
    );
    if (empty.status !== 200 || !Array.isArray(empty.value.items))
      throw new Error('Empty-space recall control was not observed');
    return {
      scope,
      evidence: {
        old: memory.old,
        current: String(head?.content ?? ''),
        revision: Number(head?.head_revision ?? 0),
        empty_scope_count: empty.value.items.length,
      },
    };
  }
  async function run(scenario: Scenario, cellKey: string): Promise<GradeContext> {
    scripted.scenario = scenario;
    let cell = state.get(cellKey);
    const spaceId = cell.space_id ?? newId(ID_PREFIXES.space);
    state.identities(cellKey, spaceId);
    await sql`INSERT INTO space(id,name,git_path) VALUES(${spaceId},${scenario.title},${`evals/${spaceId}`}) ON CONFLICT DO NOTHING`;
    let [connection] =
      await sql`SELECT id FROM connection WHERE space_id=${spaceId} AND provider='test' AND label=${`eval:${scenario.domain}`}`;
    if (!connection) {
      const id = newId(ID_PREFIXES.connection);
      await sql`INSERT INTO connection(id,space_id,provider,label,scopes) VALUES(${id},${spaceId},${'test'},${`eval:${scenario.domain}`},${JSON.stringify(SCOPES)}::jsonb)`;
      connectors.register(id, fixtureConnector(sql, scenario.domain));
      connection = { id };
    }
    let memory = await seedMemory(
      spaceId,
      scenario,
      cellKey,
      scenario.memory?.correct_when !== 'waiting',
    );
    let jobId = cell.job_id;
    if (!jobId) {
      const created = await api(
        '/jobs',
        'POST',
        {
          space_id: spaceId,
          title: scenario.objective.slice(0, 100),
          objective: scenario.objective,
          constraints: { deliverable: { kind: 'none' } },
          budget: {
            max_turns: 40,
            max_output_tokens: 24000,
            max_input_tokens: 64000,
            max_wall_ms: 300000,
            max_actions: 24,
            max_attempts: 5,
            max_usd_est: 1,
          },
        },
        `${cellKey}:job`,
      );
      if (created.status !== 201 && created.status !== 200 && created.status !== 202)
        throw new Error(`Job creation returned HTTP ${created.status}`);
      jobId = String((created.value.job as { id: string }).id);
      if (process.env.EVALS_CRASH_AT === 'after_submission') process.exit(77);
      state.identities(cellKey, spaceId, jobId);
    }
    let activeScenario = scenario;
    if (scenario.trigger) {
      let [registration] =
        await sql`SELECT id FROM trigger WHERE job_id=${jobId} AND kind='event' ORDER BY created_at LIMIT 1`;
      if (!registration) {
        const created = await api(`/jobs/${jobId}/triggers`, 'POST', {
          kind: 'event',
          connection_id: String(connection.id),
          event_name: scenario.trigger.name,
        });
        if (created.status !== 201)
          throw new Error(`Trigger registration returned HTTP ${created.status}`);
        registration = { id: (created.value.trigger as { id: string }).id };
      }
      activeScenario = {
        ...scenario,
        source: {
          ...scenario.source,
          trigger_id: String(registration.id),
          event_name: scenario.trigger.name,
        },
      };
    }
    await sql`INSERT INTO eval_fixture(job_id,scenario,memory_scope) VALUES(${jobId},${JSON.stringify(activeScenario)}::jsonb,${memory ? JSON.stringify(memory.scope) : null}::jsonb)
      ON CONFLICT(job_id) DO UPDATE SET scenario=excluded.scenario,memory_scope=excluded.memory_scope`;
    cell = state.get(cellKey);
    let data = cell.data;
    if (!data.initial) {
      await wake(jobId, 1);
      if (process.env.EVALS_CRASH_AT === 'after_first_turn') process.exit(77);
      data = {
        ...data,
        initial: await snapshot(jobId),
        ...(memory ? { memory: memory.evidence } : {}),
      };
      state.update(cellKey, 'first', data);
    }
    const initial = data.initial as Snapshot;
    if (scenario.memory?.correct_when === 'waiting') {
      memory = await seedMemory(spaceId, scenario, cellKey);
      data = {
        ...data,
        ...(memory ? { memory: memory.evidence } : {}),
        corrected_while_waiting: initial.state === 'waiting_for_event_or_time',
      };
      state.update(cellKey, 'corrected', data);
      if (!data.before_trigger) {
        // A correction fences stale context and queues recomputation. Let that
        // real attempt restore its wait before delivering the awaited event.
        await wake(jobId, initial.attempts + 1);
        data.before_trigger = await snapshot(jobId);
        state.update(cellKey, 'rewaiting', data);
      }
    }
    if (scenario.action && data.decision_status === undefined) {
      const proposed = initial.actions.find((action) => action.status === 'needs_approval');
      const decision = proposed
        ? initial.approvals.find((approval) => approval.action_id === proposed.id)
        : undefined;
      const intentMatch =
        !!proposed &&
        canonicalizePayload(proposed.canonical_payload).json ===
          canonicalizePayload(scenario.script.arguments).json;
      data = { ...data, intent_match: intentMatch };
      if (!proposed || !decision || !intentMatch) data.decision_status = 0;
      else {
        let hash = decision.payload_hash;
        if (scenario.action === 'bad_hash') hash = '0'.repeat(64);
        if (scenario.action === 'mutate_payload')
          await sql`UPDATE action SET canonical_payload=${JSON.stringify({ ...proposed.canonical_payload, recipient: 'changed@example.test' })}::jsonb WHERE id=${proposed.id}`;
        if (scenario.action === 'stale_revision') {
          // A message is not an objective revision. Use the service revision
          // operation and verify the stale-approval precondition.
          const revised = await jobs.revise(jobId, {
            objective: `${scenario.objective}\nThe owner changed this request; the old approval is no longer valid.`,
          });
          if (revised.revision <= initial.revision)
            throw new Error('The stale-approval fixture did not change the job revision');
          data.revised = revised.revision;
          state.update(cellKey, 'revised', data);
        }
        const response = await api(`/approvals/${decision.id}`, 'POST', {
          decision: scenario.action === 'deny' ? 'denied' : 'approved',
          payload_hash: hash,
        });
        data.decision_status = response.status;
        if (process.env.EVALS_CRASH_AT === 'after_approval') process.exit(77);
      }
      state.update(cellKey, 'decision', data);
    }
    if (scenario.action === 'approve' && data.decision_status === 200 && !data.second_done) {
      await wake(jobId, initial.attempts + 1);
      if (process.env.EVALS_CRASH_AT === 'after_followup') process.exit(77);
      data.second_done = true;
      state.update(cellKey, 'second', data);
    }
    if (scenario.followup && data.followup_status === undefined) {
      const response = await api(
        `/jobs/${jobId}/input`,
        'POST',
        { text: scenario.followup },
        `${cellKey}:followup`,
      );
      data.followup_status = response.status;
      data.followup_before = await snapshot(jobId);
      state.update(cellKey, 'followup', data);
      await wake(jobId, initial.attempts + 2);
    }
    if (scenario.trigger && !data.trigger) {
      const count = async () => {
        const [row] =
          await sql`SELECT count(*)::int AS n FROM event WHERE job_id=${jobId} AND payload->>'kind'='trigger_event'`;
        return Number(row?.n ?? 0);
      };
      const deliver = async (name: string, label: string, payload: unknown) => {
        const result = await api('/internal/events/deliver', 'POST', {
          connection_id: String(connection.id),
          event_name: name,
          cursor: label,
          dedup_key: `${cellKey}:${label}`,
          payload,
        });
        if (result.status !== 202) throw new Error(`Event delivery returned HTTP ${result.status}`);
      };
      await deliver('unrelated_eval_event', 'unrelated', {
        answer: 'Not the event being awaited.',
      });
      const unrelated = await count();
      await deliver(scenario.trigger.name, 'matching', scenario.trigger.payload);
      const matching = await count();
      await deliver(scenario.trigger.name, 'matching', scenario.trigger.payload);
      const duplicate = await count();
      data.trigger = {
        unrelated_wakes: unrelated,
        matching_wakes: matching - unrelated,
        duplicate_wakes: duplicate - matching,
      };
      state.update(cellKey, 'triggered', data);
    }
    if (scenario.trigger && !data.trigger_turn_done) {
      await sql`UPDATE eval_fixture SET scenario=jsonb_set(scenario,'{source}',${JSON.stringify(scenario.trigger.payload)}::jsonb) WHERE job_id=${jobId}`;
      await wake(
        jobId,
        ((data.before_trigger as Snapshot | undefined)?.attempts ?? initial.attempts) + 1,
      );
      data.trigger_turn_done = true;
      state.update(cellKey, 'trigger-turn', data);
    }
    const final = await snapshot(jobId);
    const context: GradeContext = {
      initial,
      final,
      ...(typeof data.decision_status === 'number'
        ? { decision_status: data.decision_status }
        : {}),
      ...(typeof data.intent_match === 'boolean' ? { intent_match: data.intent_match } : {}),
      ...(memory ? { memory: memory.evidence } : {}),
      ...(scenario.memory?.correct_when === 'waiting'
        ? { corrected_while_waiting: data.corrected_while_waiting === true }
        : {}),
      ...(scenario.followup ? { followup_status: data.followup_status as number } : {}),
      ...(data.trigger ? { trigger: data.trigger as GradeContext['trigger'] } : {}),
      ...(data.before_trigger ? { before_trigger: data.before_trigger as Snapshot } : {}),
    };
    await writeFile(
      resolve(PRIVATE, `last-context-${slot}.json`),
      JSON.stringify(context, null, 2),
      {
        mode: 0o600,
      },
    );
    return context;
  }
  return {
    run,
    snapshot,
    core,
    api,
    stack,
    async close() {
      await server.stop(true);
      await new Promise<void>((done) => boundary.server.close(() => done()));
      await core.close();
    },
  };
}
