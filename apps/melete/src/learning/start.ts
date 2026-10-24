import type { Env } from '../env.ts';
import { withSignIn } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { fakeProvider, type GatewayOptions, providersFromEnv } from '../gateway/index.ts';
import { type ModelSettingsService, sideCallSource } from '../gateway/model-settings.ts';
import { routingFromEnv } from '../gateway/routing.ts';
import type { JobService } from '../jobs/service.ts';
import { type Commits, quietLoop } from '../ops/quiet-loop.ts';
import { ProcedureService } from './procedures.ts';
import { openProposalGateway } from './proposal-gateway.ts';
import { ProcedureProposer } from './proposer.ts';

/**
 * Proposes from waiting corrections and puts each proposal to work at once, on
 * the owner's own jobs in the space it was taught in. Nothing waits for the
 * person: they see it used in the job's trail and can keep, stop or change it
 * with one answer. A proposal that cannot be tried stays in their list.
 */
export async function applyLearned(proposer: ProcedureProposer, procedures: ProcedureService) {
  const tried = [];
  for (const { ownerId, spaceId, candidate } of await proposer.drain()) {
    if (candidate.state !== 'candidate') continue;
    try {
      tried.push(
        await procedures.startTrial(ownerId, spaceId, candidate.id, candidate.bodyHash, true),
      );
    } catch {
      process.stderr.write('learning trial not started\n');
    }
  }
  return tried;
}

/**
 * The model a proposal is written with. A proposal is a short side call like
 * reading chat into memory, so it takes the fast model, or the secondary of
 * the space's owner, before the model new chats use.
 */
export function proposalModelSource(env: Env, settings?: ModelSettingsService) {
  return sideCallSource('learning', { env, settings, routing: routingFromEnv(env) });
}

/**
 * One durable drain; a second pass cannot overlap a bounded model call. It
 * looks each second while corrections keep coming, as soon as a change is
 * committed, and otherwise at most every half minute.
 */
export async function startLearning(
  jobs: JobService,
  env: Env,
  workers: boolean,
  fake: GatewayOptions['fake'] | undefined,
  signIn: ProviderSignIn | undefined,
  privacy: GatewayOptions['privacy'],
  settings?: ModelSettingsService,
  /** Whether this instance drains now, when several share the database. */
  leads?: () => Promise<boolean>,
  spending?: GatewayOptions['spending'],
  /** Says when a change may have been committed, such as a correction. */
  wakeOn?: Commits,
) {
  const gateway = await openProposalGateway({
    db: jobs.db,
    privacy,
    spending,
    reasoningEffort: env.MELETE_REASONING_EFFORT_SIDE,
    provider: env.MELETE_DEFAULT_PROVIDER,
    model: env.MELETE_DEFAULT_MODEL,
    source: proposalModelSource(env, settings),
    // The same explicitly configured fake provider covers the proposal call.
    // Real provider credentials still stay inside the existing model gateway.
    fake,
    providers: [
      ...withSignIn(
        providersFromEnv({
          FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
          ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
          GOOGLE_API_KEY: env.GOOGLE_API_KEY,
          OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
          OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
        }),
        signIn,
      ),
      ...(env.MELETE_ENABLE_FAKE_PROVIDER ? [fakeProvider] : []),
    ],
  });
  const proposer = new ProcedureProposer(jobs, gateway);
  const procedures = new ProcedureService(jobs);
  const loop = workers
    ? quietLoop(
        async () => {
          if (leads && !(await leads())) return false;
          return (await applyLearned(proposer, procedures)).length > 0;
        },
        {
          busyMs: 1000,
          idleMs: 30_000,
          wakeOn,
          onError: () => {
            process.stderr.write('learning proposal drain failed\n');
          },
        },
      )
    : undefined;
  return {
    proposer,
    async close() {
      await loop?.stop();
      await gateway.close();
    },
  };
}
