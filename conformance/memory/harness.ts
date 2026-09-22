/**
 * Runs one scenario file against the real memory service.
 *
 * Nothing here is a mock of memory. Evidence goes through `ingest`, extraction
 * goes through `runExtractionWork` with a scripted gateway over real HTTP,
 * corrections go through `correctClaim`, removals go through `forgetMemory` and
 * the retained restriction journal, and every question is answered out of a real
 * `recall`. The only substitutions are the model behind the extractor and the
 * model answering the question, both scripted and both deterministic.
 *
 * The second arm withholds recall: the same scenario runs with an injected
 * recall that reports `complete` with zero items. A scenario marked
 * `memory_required` that still passes on that arm is not testing memory, and the
 * runner fails the suite rather than reporting a green row nobody earned.
 */
import { CONTEXT_LIMITS, type RecallResult } from '@melete/contracts';
import { newId } from '../../apps/melete/src/ids.ts';
import { captureChat } from '../../apps/melete/src/memory/capture.ts';
import { claimHistory, correctClaim } from '../../apps/melete/src/memory/claims.ts';
import { commitExtraction } from '../../apps/melete/src/memory/commit.ts';
import { listQuestions } from '../../apps/melete/src/memory/contradictions.ts';
import { MemoryError, type MemoryScope } from '../../apps/melete/src/memory/db.ts';
import { ingest } from '../../apps/melete/src/memory/evidence.ts';
import {
  cleanupMemory,
  forgetMemory,
  revokeMemorySource,
} from '../../apps/melete/src/memory/forget.ts';
import { recall } from '../../apps/melete/src/memory/recall.ts';
import { restoreMemory } from '../../apps/melete/src/memory/restore.ts';
import {
  type MemoryServiceOptions,
  runExtractionWork,
} from '../../apps/melete/src/memory/service.ts';
import { runViewWork } from '../../apps/melete/src/memory/views.ts';
import { claimWork } from '../../apps/melete/src/memory/work.ts';
import { tripProposal } from '../../apps/melete/test/integration/fake-provider.ts';
import { killAt } from '../../apps/melete/test/integration/fault-fixtures.ts';
import {
  createJournal,
  snapshotMemory,
} from '../../apps/melete/test/integration/lifecycle-fixtures.ts';
import {
  createScope,
  createTestDatabase,
  type TestDatabase,
} from '../../apps/melete/test/integration/postgres.ts';
import {
  type AskRequest,
  type DeliveredItem,
  type ScriptedProvider,
  startScriptedProvider,
} from './provider.ts';
import type { AskStep, Scenario, ScriptedClaim, Step } from './schema.ts';

/**
 * What a check measures, for the evaluation's counts: a value memory should
 * hold, a value an attempt should be handed, text a removal should have erased,
 * or memory that should have stayed out of a recall.
 */
export type CheckKind = 'stored' | 'recalled' | 'erased' | 'irrelevant' | 'told';
export type Check = { name: string; ok: boolean; detail: string; kind?: CheckKind };
export type ScenarioMetrics = {
  obsolete_fact_used: number;
  unsupported_claim: number;
  needless_question: number;
  correction_to_serving_ms: number[];
  recall_ms: number[];
};
export type ScenarioRun = {
  id: string;
  family: Scenario['family'];
  title: string;
  memory_required: boolean;
  arm: 'memory' | 'withheld';
  outcome: 'passed' | 'failed' | 'todo';
  checks: Check[];
  failures: string[];
  metrics: ScenarioMetrics;
  duration_ms: number;
};

const ANSWER_ABSENT = '(no answer)';
const emptyRecall = (): RecallResult => ({
  status: 'complete',
  snapshot: null,
  index_generation: null,
  items: [],
  disputed_keys: [],
  coverage: {
    indexed_revision: 0,
    authoritative_revision: 0,
    supplemented: 0,
    truncated: false,
    reason: 'ready',
  },
  recipe: 'recall-withheld',
  token_budget: { limit: 2000, used: 0, counter: 'utf8-bytes-upper-bound-v1' },
});

const percentile = (values: readonly number[], fraction: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
};
export const p50 = (values: readonly number[]) => percentile(values, 0.5);
export const p95 = (values: readonly number[]) => percentile(values, 0.95);

type SpaceState = {
  scope: MemoryScope;
  /** The claim each registry key currently occupies, by key. */
  claims: Map<string, string>;
  lastWorkId: string | null;
  lastIngest: Record<string, unknown> | null;
};
type SourceRecord = { source_id: string; source_version: string; text: string; space: string };

export type Harness = Awaited<ReturnType<typeof openHarness>>;

export async function openHarness(options: { databasePort?: number; providerPort?: number } = {}) {
  const db = await createTestDatabase(process.env.DATABASE_URL, {
    port: options.databasePort ?? 3126,
  });
  if (!db) return null;
  const provider = await startScriptedProvider(options.providerPort ?? 3124);
  return {
    db,
    provider,
    run: (scenario: Scenario, arm: 'memory' | 'withheld') =>
      runScenario(db, provider, scenario, arm),
    async close() {
      provider.close();
      await db.close();
    },
  };
}

async function runScenario(
  db: TestDatabase,
  provider: ScriptedProvider,
  scenario: Scenario,
  arm: 'memory' | 'withheld',
): Promise<ScenarioRun> {
  const started = performance.now();
  const checks: Check[] = [];
  const metrics: ScenarioMetrics = {
    obsolete_fact_used: 0,
    unsupported_claim: 0,
    needless_question: 0,
    correction_to_serving_ms: [],
    recall_ms: [],
  };
  const base = {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    memory_required: scenario.memory_required,
    arm,
  };
  if (scenario.status === 'todo')
    return {
      ...base,
      outcome: 'todo',
      checks: [],
      failures: [],
      metrics,
      duration_ms: 0,
    };
  const sql = db.sql;
  const journal = await createJournal();
  const spaces = new Map<string, SpaceState>();
  for (const name of ['main', 'other'])
    spaces.set(name, {
      scope: await createScope(db),
      claims: new Map(),
      lastWorkId: null,
      lastIngest: null,
    });
  const service: MemoryServiceOptions = {
    sql,
    boss: db.boss,
    journal: journal.journal,
    gateway: provider.gateway,
  };
  const sources = new Map<string, SourceRecord>();
  const conversations = new Map<string, string>();
  const snapshots = new Map<string, () => Promise<void>>();
  const check = (name: string, ok: boolean, detail = '', kind?: CheckKind) =>
    checks.push({ name, ok, detail, ...(kind ? { kind } : {}) });
  const state = (name: string): SpaceState => {
    const found = spaces.get(name);
    if (!found) throw new Error(`unknown space ${name}`);
    return found;
  };

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${index + 1}. ${step.step}`;
      await runStep(step, label);
    }
  } catch (error) {
    check('scenario ran to the end', false, error instanceof Error ? error.message : String(error));
  } finally {
    await journal.close();
  }
  const failures = checks
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.name}: ${entry.detail}`);
  return {
    ...base,
    outcome: failures.length ? 'failed' : 'passed',
    checks,
    failures,
    metrics,
    duration_ms: Math.round(performance.now() - started),
  };

  // ------------------------------------------------------------------------

  async function headRevision(scope: MemoryScope, claimId: string): Promise<number | null> {
    const [row] =
      await sql`select head_revision from memory_claims where id = ${claimId} and space_id = ${scope.spaceId}`;
    return (row?.head_revision as number | undefined) ?? null;
  }

  async function activeRevisions(claimId: string) {
    return sql`select revision from memory_revisions where claim_id = ${claimId} and status in ('active','disputed')`;
  }

  /** What the derived worker does, for one space, so the cost stays per scenario. */
  async function derive(space: SpaceState) {
    await cleanupMemory(sql, space.scope.spaceId);
    const [row] =
      await sql`select restore_ready, revoked from memory_spaces where space_id = ${space.scope.spaceId}`;
    if (!row?.restore_ready || row.revoked) return;
    await runViewWork(sql, { ...space.scope, publisher: 'view-builder' });
  }

  async function rejectionCount(scope: MemoryScope): Promise<number> {
    const [row] =
      await sql`select count(*)::int as total from memory_rejections where space_id = ${scope.spaceId}`;
    return (row?.total as number | undefined) ?? 0;
  }

  async function recallOnce(
    scope: MemoryScope,
    request: { query: string; mode?: 'current' | 'historical'; at?: string },
    attempt = false,
  ): Promise<RecallResult> {
    if (arm === 'withheld') return emptyRecall();
    const at = performance.now();
    // An attempt's recall is what buildBundle asks for: the profile, and the
    // knowledge budget the bundle carries.
    const result = attempt
      ? await recall(
          sql,
          scope,
          { ...request, max_tokens: CONTEXT_LIMITS.knowledge_tokens },
          { includeProfile: true },
        )
      : await recall(sql, scope, request);
    metrics.recall_ms.push(performance.now() - at);
    return result;
  }

  /** Ingest one piece of evidence, then let the real extraction worker run over it. */
  async function evidenceStep(
    label: string,
    space: SpaceState,
    name: string,
    input: {
      stream: string;
      source_type: string;
      author: 'owner' | 'external';
      event_at: string;
      time_zone: string;
      text: string;
    },
    claims: readonly ScriptedClaim[],
  ) {
    const payload = {
      stream: input.stream,
      source_identity: name,
      source_version: '1',
      source_type: input.source_type,
      author: input.author,
      event_at: input.event_at,
      time_zone: input.time_zone,
      text: input.text,
    };
    const before = {
      rejections: await rejectionCount(space.scope),
      heads: new Map<string, number | null>(),
    };
    for (const claim of claims) before.heads.set(claim.key, await headFor(space, claim.key));
    const accepted = await ingest(sql, space.scope, payload);
    space.lastIngest = payload;
    sources.set(name, {
      source_id: accepted.source.source_id,
      source_version: accepted.source.source_version,
      text: input.text,
      space: space.scope.spaceId,
    });
    if (claims.length) {
      provider.script(
        accepted.source.source_id,
        claims.map((claim) => {
          const cited =
            claim.cite === 'previous_source' ? previousSource(name, space.scope.spaceId) : null;
          return {
            key: claim.key,
            content: claim.content,
            kind: claim.kind,
            factual_status: claim.factual_status,
            quote: claim.quote,
            valid_from: claim.valid_from ?? input.event_at,
            valid_until: claim.valid_until,
            update: claim.update,
            cite: cited
              ? {
                  source_id: cited.source_id,
                  source_version: cited.source_version,
                  text: cited.text,
                  offset: 0,
                }
              : null,
          };
        }),
      );
    }
    const [work] =
      await sql`select id from memory_work where source_id = ${accepted.source.source_id} and status = 'pending' order by created_at limit 1`;
    if (work) {
      space.lastWorkId = work.id as string;
      await runExtractionWork(service, work.id as string);
    }
    await derive(space);
    for (const claim of claims) {
      const claimId = await claimFor(space, claim.key);
      if (claim.expect_rejected) {
        const [row] = space.lastWorkId
          ? await sql`select status, error_code from memory_work where id = ${space.lastWorkId}`
          : [];
        const recorded =
          (await rejectionCount(space.scope)) > before.rejections || row?.status === 'rejected';
        check(
          `${label} the proposal is refused with a reason`,
          recorded,
          'nothing durable recorded the refusal',
        );
        const after = await headFor(space, claim.key);
        const prior = before.heads.get(claim.key) ?? null;
        check(
          `${label} ${claim.key} is unchanged`,
          after === prior,
          `head went from ${prior} to ${after}`,
        );
        continue;
      }
      check(`${label} ${claim.key} has a claim`, claimId !== null, 'extraction produced no claim');
    }
  }

  /** The head revision a key currently holds, or null when nothing holds it. */
  async function headFor(space: SpaceState, key: string): Promise<number | null> {
    const [row] =
      await sql`select head_revision from memory_claims where space_id = ${space.scope.spaceId} and (key = ${key} or domain_key = ${key}) and not hidden limit 1`;
    return (row?.head_revision as number | undefined) ?? null;
  }

  /** The message before this one in the same space: the convenient nearby one. */
  function previousSource(current: string, spaceId: string): SourceRecord | null {
    let previous: SourceRecord | null = null;
    for (const [name, record] of sources) {
      if (name === current) break;
      if (record.space === spaceId) previous = record;
    }
    return previous;
  }

  /** The claim currently occupying a registry key, or an unkeyed domain, in one space. */
  async function claimFor(space: SpaceState, key: string): Promise<string | null> {
    const [row] =
      await sql`select id from memory_claims where space_id = ${space.scope.spaceId} and (key = ${key} or domain_key = ${key}) and not hidden limit 1`;
    const id = (row?.id as string | undefined) ?? null;
    if (id) space.claims.set(key, id);
    return id;
  }

  async function runStep(step: Step, label: string) {
    switch (step.step) {
      case 'say': {
        const space = state(step.space);
        await evidenceStep(
          label,
          space,
          step.name,
          {
            stream: 'chat',
            source_type: 'message',
            author: 'owner',
            event_at: step.event_time,
            time_zone: step.time_zone ?? scenario.time_zone,
            text: step.text,
          },
          [...(step.claim ? [step.claim] : []), ...(step.claims ?? [])],
        );
        return;
      }
      case 'import': {
        const space = state(step.space);
        await evidenceStep(
          label,
          space,
          step.name,
          {
            stream: step.source_type === 'document' ? 'web' : 'email',
            source_type: step.source_type,
            author: step.author,
            event_at: step.event_time,
            time_zone: step.time_zone ?? scenario.time_zone,
            text: step.text,
          },
          [...(step.claim ? [step.claim] : []), ...(step.claims ?? [])],
        );
        return;
      }
      case 'observe': {
        const space = state(step.space);
        await evidenceStep(
          label,
          space,
          step.name,
          {
            stream: 'connector',
            source_type: 'observation',
            author: 'owner',
            event_at: step.event_time,
            time_zone: step.time_zone ?? scenario.time_zone,
            text: JSON.stringify(step.observation),
          },
          [],
        );
        for (const key of step.expect_keys) {
          const id = await claimFor(space, key);
          check(`${label} Tier 0 produced ${key}`, id !== null, 'no checked fact was created');
        }
        return;
      }
      case 'correct': {
        const space = state(step.space);
        const claimId = await claimFor(space, step.key);
        if (!claimId) {
          check(`${label} ${step.key} exists to correct`, false, 'no claim holds that key');
          return;
        }
        const expected = await headRevision(space.scope, claimId);
        const at = performance.now();
        await correctClaim(sql, space.scope, {
          claim_id: claimId,
          expected_revision: expected ?? 1,
          text: step.text,
          content: step.content,
          valid_from: step.valid_from,
          valid_until: step.valid_until,
          idempotency_key: `${scenario.id}-${step.name}`,
        });
        await derive(space);
        if (arm === 'memory') {
          const query = step.key.replace(/[.]/g, ' ');
          const deadline = Date.now() + 5000;
          let served = false;
          while (!served && Date.now() < deadline) {
            const result = await recall(sql, space.scope, { query });
            served = result.items.some(
              (item) => item.claim_id === claimId && item.content === step.content,
            );
            if (!served) await Bun.sleep(10);
          }
          metrics.correction_to_serving_ms.push(Math.round(performance.now() - at));
          check(`${label} the correction is being served`, served, 'recall never served it');
        }
        return;
      }
      case 'forget': {
        const space = state(step.space);
        const claimId = step.key ? await claimFor(space, step.key) : null;
        if (step.key && !claimId) {
          check(`${label} ${step.key} exists to forget`, false, 'no claim holds that key');
          return;
        }
        await forgetMemory(
          sql,
          space.scope,
          step.all ? { all: true } : { claim_id: claimId },
          journal.journal,
        );
        await derive(space);
        return;
      }
      case 'revoke': {
        const space = state(step.space);
        const record = sources.get(step.source);
        if (!record) {
          check(`${label} ${step.source} was imported`, false, 'no such source');
          return;
        }
        await revokeMemorySource(sql, space.scope, record.source_id, journal.journal);
        await derive(space);
        return;
      }
      case 'snapshot': {
        snapshots.set(step.name, await snapshotMemory(db));
        return;
      }
      case 'restore_from': {
        const restore = snapshots.get(step.snapshot);
        if (!restore) {
          check(`${label} snapshot ${step.snapshot} exists`, false, 'no such snapshot');
          return;
        }
        await restore();
        const gated = await recall(sql, state('main').scope, { query: 'anything' });
        check(
          `${label} memory is gated until the journal replays`,
          gated.coverage.reason === 'restore_pending',
          `coverage was ${gated.coverage.reason}`,
        );
        await restoreMemory(sql, journal.journal);
        await derive(state('main'));
        await derive(state('other'));
        return;
      }
      case 'kill_at': {
        const space = state(step.space);
        await killAt(db, space.scope, step.phase);
        const [faulted] =
          await sql`select id from memory_sources where space_id = ${space.scope.spaceId} and stream = 'faults' and source_identity = ${step.phase}`;
        check(
          `${label} the killed process left its evidence behind`,
          Boolean(faulted),
          'the input did not survive the kill',
        );
        if (!faulted || !step.resume) return;
        await sql`update memory_work set lease_until = clock_timestamp() - interval '1 second' where source_id = ${faulted.id}`;
        const [work] =
          await sql`select id, status from memory_work where source_id = ${faulted.id} limit 1`;
        if (work && work.status !== 'done') {
          const batch = await claimWork(sql, space.scope, { workId: work.id as string });
          if (!batch) {
            check(`${label} the interrupted work can be resumed`, false, 'work was not claimable');
            return;
          }
          const result = await commitExtraction(sql, space.scope, batch, {
            proposals: [tripProposal(batch)],
          });
          check(
            `${label} the resumed attempt commits once`,
            result.status === 'committed',
            `commit was ${result.status}`,
          );
        }
        await derive(space);
        const heads =
          await sql`select c.id from memory_claims c where c.space_id = ${space.scope.spaceId} and c.domain_key = 'trip.month' and not c.hidden`;
        check(
          `${label} the interrupted work left exactly one head`,
          heads.length === 1,
          `${heads.length} heads`,
        );
        return;
      }
      case 'ask':
        await askStep(step, label);
        return;
      case 'chat': {
        const space = state(step.space);
        const key = `${step.space}:${step.conversation}`;
        let jobId = conversations.get(key);
        if (!jobId) {
          jobId = newId('job');
          await sql`insert into job (id, space_id, title, objective, kind, state, revision, lease_epoch)
            values (${jobId}, ${space.scope.spaceId}, 'New chat', 'New chat', 'chat', 'completed', 1, 1)`;
          conversations.set(key, jobId);
        }
        const [event] = await sql`insert into event (job_id, type, payload, dedup_key)
          values (${jobId}, 'notice', ${JSON.stringify({ kind: 'user_message', text: step.text })}::text::jsonb,
            ${`${scenario.id}:${label}:${jobId}`}) returning seq`;
        const owner = { ...space.scope, principalId: space.scope.ownerId };
        await captureChat({
          sql,
          journal: journal.journal,
          scopeForJob: async (id) => {
            const [job] = await sql`select space_id from job where id = ${id}`;
            if (job?.space_id !== owner.spaceId) throw new MemoryError('scope_denied');
            return owner;
          },
        });
        const [captured] =
          await sql`select source_id from memory_capture where event_seq = ${event?.seq}`;
        const claims = [...(step.claim ? [step.claim] : []), ...(step.claims ?? [])];
        if (captured?.source_id && claims.length)
          provider.script(
            captured.source_id as string,
            claims.map((claim) => ({
              key: claim.key,
              content: claim.content,
              kind: claim.kind,
              factual_status: claim.factual_status,
              quote: claim.quote,
              valid_from: claim.valid_from,
              valid_until: claim.valid_until,
              update: claim.update,
              cite: null,
            })),
          );
        const work = captured?.source_id
          ? await sql`select id from memory_work where source_id = ${captured.source_id} and status = 'pending'`
          : [];
        for (const row of work) {
          space.lastWorkId = row.id as string;
          await runExtractionWork(service, row.id as string);
        }
        await derive(space);
        for (const claim of claims)
          if (!claim.expect_rejected)
            check(
              `${label} ${claim.key} has a claim`,
              (await claimFor(space, claim.key)) !== null,
              'nothing was kept from the message',
            );
        return;
      }
      case 'expect_told': {
        const space = state(step.space);
        const jobId = conversations.get(`${step.space}:${step.conversation}`);
        const rows = jobId
          ? await sql`select payload->'call'->>'title' as title from event where job_id = ${jobId}
              and type = 'notice' and payload->>'kind' = 'tool_trace' order by seq`
          : [];
        const titles = rows.map((row) => row.title as string);
        check(
          `${label} the conversation shows ${JSON.stringify(step.titles)}`,
          JSON.stringify(titles) === JSON.stringify(step.titles),
          `shows ${JSON.stringify(titles)} in ${space.scope.spaceId}`,
          'told',
        );
        return;
      }
      case 'expect_stored': {
        const space = state(step.space);
        const claimId = await claimFor(space, step.key);
        const [head] = claimId
          ? await sql`select b.content from memory_claims c join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
              join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
              where c.id = ${claimId} and r.status in ('active','disputed')`
          : [];
        const value = (head?.content as string | undefined) ?? null;
        if (step.absent)
          check(`${label} ${step.key} holds nothing`, value === null, `holds ${value}`, 'stored');
        else
          check(
            `${label} ${step.key} holds ${step.content}`,
            value !== null && value === (step.content ?? value),
            `holds ${value ?? 'nothing'}`,
            'stored',
          );
        return;
      }
      case 'expect_erased': {
        const space = state(step.space);
        await derive(space);
        const pattern = `%${step.text}%`;
        const spaceId = space.scope.spaceId;
        const [found] = await sql`select
          (select count(*)::int from memory_source_content b join memory_sources s on s.id = b.source_id
            where s.space_id = ${spaceId} and b.content like ${pattern}) as sources,
          (select count(*)::int from memory_revision_content b join memory_claims c on c.id = b.claim_id
            where c.space_id = ${spaceId} and b.content like ${pattern}) as revisions,
          (select count(*)::int from memory_index_entries
            where space_id = ${spaceId} and tokens @@ plainto_tsquery('simple', ${step.text})) as index,
          (select count(*)::int from memory_repair_briefs
            where space_id = ${spaceId} and (old_value like ${pattern} or new_value like ${pattern})) as briefs,
          (select count(*)::int from memory_questions
            where space_id = ${spaceId} and question like ${pattern}) as memory_questions,
          (select count(*)::int from question
            where space_id = ${spaceId} and text like ${pattern}) as questions,
          (select count(*)::int from memory_proposals
            where space_id = ${spaceId} and payload::text like ${pattern}) as proposals`;
        const left = Object.entries(found ?? {}).filter(([, count]) => Number(count) > 0);
        check(
          `${label} "${step.text}" is erased`,
          left.length === 0,
          `still in ${left.map(([table, count]) => `${table} (${count})`).join(', ')}`,
          'erased',
        );
        return;
      }
      case 'expect_question': {
        const space = state(step.space);
        const queued = await sql.begin((tx) => listQuestions(tx, space.scope));
        check(
          `${label} ${step.count} owner question(s) queued`,
          queued.length === step.count,
          `${queued.length} queued: ${queued.map((q) => q.question).join(' | ')}`,
        );
        return;
      }
      case 'expect_no_effect_duplicate': {
        const space = state(step.space);
        if (space.lastIngest) {
          const replayed = await ingest(sql, space.scope, space.lastIngest);
          check(
            `${label} the same input is a duplicate, not a second effect`,
            replayed.duplicate,
            'the replay was accepted as new evidence',
          );
        }
        if (space.lastWorkId) await runExtractionWork(service, space.lastWorkId);
        await derive(space);
        if (!step.key) return;
        const claimId = await claimFor(space, step.key);
        if (!claimId) {
          check(`${label} ${step.key} exists`, false, 'no claim holds that key');
          return;
        }
        const active = await activeRevisions(claimId);
        check(`${label} ${step.key} has one active head`, active.length === 1, `${active.length}`);
        const head = await headRevision(space.scope, claimId);
        check(
          `${label} ${step.key} did not gain a revision`,
          (head ?? 0) <= step.max_revisions,
          `head revision ${head}`,
        );
        if (step.max_sources !== undefined) {
          const support =
            await sql`select count(distinct source_id)::int as total from memory_references where claim_id = ${claimId} and revision = ${head}`;
          const total = (support[0]?.total as number | undefined) ?? 0;
          check(
            `${label} ${step.key} support did not inflate`,
            total <= step.max_sources,
            `${total} sources`,
          );
        }
        return;
      }
    }
  }

  async function askStep(step: AskStep, label: string) {
    const space = state(step.space);
    const result = await recallOnce(
      space.scope,
      {
        query: step.query,
        mode: step.mode,
        ...(step.at ? { at: step.at } : {}),
      },
      step.attempt,
    );
    const items: DeliveredItem[] = result.items.map((item) => ({
      handle: item.handle,
      // An unkeyed claim is known by its domain, which is what a reader sees.
      key: item.key ?? item.domain_key,
      content: item.content,
      origin_trust: item.origin_trust,
      disputed: item.disputed,
      status: item.status,
      valid_from: item.valid_from,
      valid_until: item.valid_until,
      superseded_at: item.superseded_at,
    }));
    const request: AskRequest = {
      question: step.query,
      key: step.key,
      mode: step.mode,
      items,
    };
    const reply = await provider.ask(request);
    const handles = new Set(items.map((item) => item.handle));
    const delivered = new Set(
      items.map((item) => item.key).filter((key): key is string => key !== null),
    );
    if (reply.answer !== null && (!reply.uses.length || reply.uses.some((h) => !handles.has(h))))
      metrics.unsupported_claim++;
    if (reply.question !== null && step.expect.kind === 'answer') metrics.needless_question++;
    // An obsolete fact is a value memory has already moved on from: it matches a
    // revision that was superseded, and it is not what the head or the owner's
    // latest correction says. Serving a corrected-away value counts even when
    // the service has wrongly made it the head again, which is the shape the
    // deliberate "late import wins" break takes.
    if (step.mode === 'current' && reply.answer !== null) {
      const claimId = space.claims.get(step.key) ?? (await claimFor(space, step.key));
      if (claimId) {
        const history = await claimHistory(sql, space.scope, claimId);
        const head = history.revisions.find((revision) =>
          ['active', 'disputed'].includes(revision.status),
        );
        const corrected = [...history.revisions].reverse().find((revision) => revision.protected);
        const superseded = history.revisions
          .filter((revision) => !['active', 'disputed'].includes(revision.status))
          .map((revision) => revision.content);
        const stale = superseded.includes(reply.answer);
        const contradicts =
          (head !== undefined && reply.answer !== head.content) ||
          (corrected !== undefined && reply.answer !== corrected.content);
        if (stale && contradicts) metrics.obsolete_fact_used++;
      }
    }
    const answer = reply.answer ?? ANSWER_ABSENT;
    switch (step.expect.kind) {
      case 'answer': {
        const expected = step.expect;
        check(
          `${label} answers ${expected.content}`,
          answer === expected.content,
          `answered ${answer}`,
          'recalled',
        );
        check(
          `${label} the answer names the handle it used`,
          reply.uses.length > 0 && reply.uses.every((handle) => handles.has(handle)),
          `uses ${JSON.stringify(reply.uses)}`,
        );
        if (expected.origin_trust) {
          const item = items.find((entry) => entry.key === step.key);
          check(
            `${label} the answer keeps its origin ${expected.origin_trust}`,
            item?.origin_trust === expected.origin_trust,
            `origin ${item?.origin_trust ?? 'none'}`,
          );
        }
        for (const key of expected.also_delivered)
          check(`${label} ${key} was delivered too`, delivered.has(key), 'not in the recall');
        for (const key of expected.not_delivered)
          check(
            `${label} ${key} stayed out of the recall`,
            !delivered.has(key),
            'irrelevant memory was delivered',
            'irrelevant',
          );
        if (expected.dated) {
          const item = items.find((entry) => entry.key === step.key);
          check(
            `${label} the old plan carries its date`,
            Boolean(item?.valid_from && (item.valid_until || item.superseded_at)),
            'the item had no validity window or supersession date',
          );
        }
        return;
      }
      case 'disputed': {
        const item = items.find((entry) => entry.key === step.key);
        check(
          `${label} ${step.key} is flagged disputed`,
          result.disputed_keys.includes(step.key) && item?.disputed === true,
          `disputed keys ${JSON.stringify(result.disputed_keys)}`,
        );
        if (step.expect.content)
          check(
            `${label} serves ${step.expect.content} while disputed`,
            answer === step.expect.content,
            `answered ${answer}`,
          );
        return;
      }
      case 'unavailable':
        check(
          `${label} recall reports unavailable`,
          result.status === 'unavailable',
          `status ${result.status}`,
        );
        return;
      case 'absent':
        check(
          `${label} ${step.key} is absent`,
          !delivered.has(step.key) && reply.answer === null,
          `answered ${answer}`,
          'recalled',
        );
        return;
    }
  }
}
