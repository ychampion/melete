import type { Env } from '../env.ts';
import { withSignIn } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { fakeProvider, type GatewayOptions, providersFromEnv } from '../gateway/index.ts';
import type { JobService } from '../jobs/service.ts';
import { openProposalGateway } from './proposal-gateway.ts';
import { ProcedureProposer } from './proposer.ts';

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
