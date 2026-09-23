import type { Env } from '../env.ts';
import { withSignIn } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { fakeProvider, type GatewayOptions, providersFromEnv } from '../gateway/index.ts';
import type { JobService } from '../jobs/service.ts';
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

/** One durable drain; a second timer tick cannot overlap a bounded model call. */
export async function startLearning(
  jobs: JobService,
  env: Env,
  workers: boolean,
  fake?: GatewayOptions['fake'],
  signIn?: ProviderSignIn,
) {
  const gateway = await openProposalGateway({
    db: jobs.db,
    provider: env.MELETE_DEFAULT_PROVIDER,
    model: env.MELETE_DEFAULT_MODEL,
    // The same explicitly configured fake provider covers the proposal call.
    // Real provider credentials still stay inside the existing model gateway.
    fake,
    providers: [
      ...withSignIn(
        providersFromEnv({
          FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
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
  let pending: Promise<void> | undefined;
  let closed = false;
  const tick = () => {
    if (closed || pending) return;
    pending = applyLearned(proposer, procedures)
      .then(() => undefined)
      .catch(() => {
        process.stderr.write('learning proposal drain failed\n');
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = workers ? setInterval(tick, 1000) : undefined;
  timer?.unref();
  if (workers) tick();
  return {
    proposer,
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
      await gateway.close();
    },
  };
}
