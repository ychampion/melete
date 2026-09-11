import type { Env } from '../env.ts';
import { fakeProvider, providersFromEnv } from '../gateway/index.ts';
import type { JobService } from '../jobs/service.ts';
import { openProposalGateway } from './proposal-gateway.ts';
import { ProcedureProposer } from './proposer.ts';

/** One durable drain; a second timer tick cannot overlap a bounded model call. */
export async function startLearning(jobs: JobService, env: Env, workers: boolean) {
  const gateway = await openProposalGateway({
    db: jobs.db,
    provider: env.MELETE_DEFAULT_PROVIDER,
    model: env.MELETE_DEFAULT_MODEL,
    providers: [
      ...providersFromEnv({
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
        OPENAI_API_KEY: env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        GOOGLE_API_KEY: env.GOOGLE_API_KEY,
        OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
        OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
      }),
      ...(env.MELETE_ENABLE_FAKE_PROVIDER ? [fakeProvider] : []),
    ],
  });
  const proposer = new ProcedureProposer(jobs, gateway);
  let pending: Promise<void> | undefined;
  let closed = false;
  const tick = () => {
    if (closed || pending) return;
    pending = proposer
      .drain()
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
