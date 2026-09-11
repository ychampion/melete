import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, CapabilityClaims, JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { browserManifest, createBrowserConnector } from '../../src/connectors/browser.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type { BrowserSubmitIntent } from '../../src/workers/browser/controller.ts';
import type { BrowserRecipePlan } from '../../src/workers/browser/planning.ts';
import {
  type BrowserRecipeCandidate,
  PostgresBrowserRecipeStore,
} from '../../src/workers/browser/recipes.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import type { VisibleSchema } from '../../src/workers/browser/visible.ts';
import { seedJob } from './broker.ts';
import type { TestDatabase } from './database.ts';

export type BrowserDetail = {
  session_id: string;
  control_epoch: number;
  observation?: {
    id: string;
    url: string;
    schema: VisibleSchema;
    tree: { artifact_id: string; path: string };
    screenshot: { artifact_id: string; path: string };
  };
  result?: { submit_intents?: BrowserSubmitIntent[]; recipe?: BrowserRecipePlan; text?: string };
};

/** A scripted caller exercises the real broker; only the fixture's explicit owner approval is automated. */
export async function browserBrokerFixture(db: TestDatabase) {
  const root = await mkdtemp(join(tmpdir(), 'melete-w10b-matrix-'));
  const pool = new BrowserWorkerPool({
    spacesRoot: root,
    allowLocalProcess: true,
    workerEntry: new URL('./browser-child.ts', import.meta.url),
  });
  const boss = new PgBoss({ connectionString: db.url, max: 2 });
  boss.on('error', () => {});
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
  const seeded = await seedJob(db.sql, {
    provider: 'web',
    scopes: browserManifest.tools.map((tool) => tool.name),
    constraints: { allowed_domains: ['127.0.0.1'] },
    budget: { max_actions: 300, max_attempts: 30, max_turns: 300 },
  });
  let claims: CapabilityClaims = seeded.claims;
  const sessions = new BrowserSessionService(db.sql, pool);
  const recipes = new PostgresBrowserRecipeStore(db.sql);
  const recipe: BrowserRecipeCandidate = {
    id: 'contact-form',
    space_id: claims.space_id,
    version: 1,
    state: 'promoted',
    reason: 'recorded',
    schema: [
      { label: 'Name', role: 'textbox', required: true, sensitive: false },
      { label: 'Email', role: 'textbox', required: true, sensitive: false },
      { label: 'Save', role: 'button', required: false, sensitive: false },
    ],
    steps: [
      { action: 'fill', label: 'Name', value_key: 'name' },
      { action: 'fill', label: 'Email', value_key: 'email' },
      { action: 'submit', role: 'button', name: 'Save' },
    ],
    safe_aliases: { Email: 'Email address' },
  };
  await recipes.save(recipe);
  const connector = createBrowserConnector({
    sessions,
    recipes,
    spaceId: claims.space_id,
    artifacts: browserArtifactSink(db.sql, root),
  });
  const broker = new BrokerService({
    sql: db.sql,
    boss,
    connectors: { get: (id) => (id === seeded.connectionId ? connector : undefined) },
    resolveTrust: createTableTrustResolver({}, { fallback: 'external_content' }),
  });
  let detail: BrowserDetail | undefined;
  let observations = 0;
  const observedIds = new Set<string>();
  let inputs = 0;
  const accept = (action: Action) => {
    const next = action.receipt?.detail as BrowserDetail | undefined;
    if (next) {
      detail = {
        ...detail,
        ...next,
        observation: next.observation ?? detail?.observation,
        result: next.result ?? detail?.result,
      };
      if (next.observation && !observedIds.has(next.observation.id)) {
        observedIds.add(next.observation.id);
        observations++;
      }
    }
    return action;
  };
  const call = async (kind: string, args: JsonObject = {}) => {
    const identity: JsonObject = detail
      ? { session_id: detail.session_id, control_epoch: detail.control_epoch }
      : {};
    const refresh: JsonObject =
      kind !== 'submit' && detail?.observation ? { after_observation: detail.observation.id } : {};
    const proposed = await broker.propose(claims, {
      kind: `browser.${kind}`,
      connection_id: seeded.connectionId,
      payload: { ...identity, ...refresh, ...args },
    });
    if (['fill', 'click', 'select'].includes(kind) && !proposed.repeated) inputs++;
    return accept(await loadAction(db.sql, proposed.action_id));
  };
  const approveAndDispatch = async (action: Action) => {
    await broker.decide(action.id, {
      decision: 'approved',
      payload_hash: action.payload_hash,
      note: 'Approve this local fixture effect.',
    });
    // The scripted fixture replaces the runtime wake; the real pg-boss wake and approval records remain.
    await db.sql`update job set state = 'running', wait = '{"kind":"none"}'::jsonb where id = ${claims.job_id}`;
    await broker.admit(claims, action.id, action.payload_hash);
    return accept(await broker.dispatch(action.id));
  };
  const resume = async () => {
    const [job] = await db.sql`select state, lease_epoch from job where id = ${claims.job_id}`;
    if (job?.state === 'running') return;
    const attemptId = recordId('att');
    const [updated] =
      await db.sql`update job set state = 'running', wait = '{"kind":"none"}'::jsonb,
      lease_epoch = lease_epoch + 1 where id = ${claims.job_id} returning lease_epoch`;
    const epoch = Number(updated?.lease_epoch);
    await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptId}, ${claims.job_id}, ${epoch}, 'fixture', 'fake', 'scripted')`;
    claims = { ...claims, attempt_id: attemptId, epoch };
  };
  await call('observe');
  return {
    root,
    pool,
    sessions,
    recipes,
    recipe,
    broker,
    call,
    approveAndDispatch,
    resume,
    claims: () => claims,
    detail: () => detail,
    counts: () => ({ observations, inputs }),
    setEpoch: (epoch: number) => {
      if (detail) detail.control_epoch = epoch;
    },
    close: async () => {
      await pool.close();
      await boss.stop({ graceful: true });
    },
  };
}
