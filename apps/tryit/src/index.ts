/**
 * The Worker. Four routes and the wiring underneath them.
 *
 * Which model runs is one decision, made here from one variable: with
 * `OPENAI_API_KEY` set it is the live Responses API, without it the scripted
 * provider, and everything downstream is identical either way.
 *
 * Which counter runs is the other: the Durable Object when it is bound, and an
 * in-isolate counter when it is not. The second is only ever right for one
 * isolate, so the live model path refuses to run behind it — an approximate
 * spend cap on a real key is not a spend cap.
 */
import type { DurableObjectNamespace, ExecutionContext } from './cf.ts';
import type { LogLine } from './handler.ts';
import { caseFileRoute, WORDS } from './handler.ts';
import type { Limiter } from './limiter.ts';
import { durableLimiter, memoryLimiter, TryItLimiter } from './limiter.ts';
import type { Limits } from './limits.ts';
import { limitsFrom } from './limits.ts';
import { openAiProvider } from './openai.ts';
import { page } from './page.ts';
import type { CaseFileProvider } from './provider.ts';
import { SAMPLES } from './samples.ts';
import { scriptedProvider } from './scripted.ts';

export { TryItLimiter };

export type Env = {
  OPENAI_API_KEY?: string;
  LIMITER?: DurableObjectNamespace;
  LANDING_URL?: string;
  REPO_URL?: string;
  MODEL?: string;
  REASONING_EFFORT?: 'low' | 'medium' | 'high';
  /** Optional secret. See `counterKey` in handler.ts. */
  TRYIT_COUNTER_SALT?: string;
  /**
   * Set by `bun run dev`. Lets `x-forwarded-for` stand in for Cloudflare's
   * address header, which a deployed Worker never does. See `clientIp`.
   */
  TRYIT_LOCAL?: string;
};

const DEFAULT_LANDING = 'https://melete.axcelner.com';
const DEFAULT_REPO = 'https://github.com/ychampion/melete';

/** Nothing here is served from anywhere else, so the policy can say exactly that. */
const headers = (nonce: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    "img-src 'self'",
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
});

function providerFor(env: Env): CaseFileProvider {
  if (!env.OPENAI_API_KEY) return scriptedProvider();
  return openAiProvider({
    apiKey: env.OPENAI_API_KEY,
    ...(env.MODEL ? { model: env.MODEL } : {}),
    ...(env.REASONING_EFFORT ? { effort: env.REASONING_EFFORT } : {}),
  });
}

/**
 * The fallback counter has to outlive the request or it counts nothing, so it
 * is built once per isolate and kept. The Durable Object needs no such care:
 * it is the same object for everyone, which is the point of it.
 */
let fallback: Limiter | null = null;

function limiterFor(env: Env, limits: Limits): Limiter {
  if (env.LIMITER) return durableLimiter(env.LIMITER);
  fallback ??= memoryLimiter(limits);
  return fallback;
}

/** Sizes, timings and an outcome. Deliberately never the text. */
const log = (line: LogLine): void => {
  console.log(JSON.stringify(line));
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const limits = limitsFrom(env as unknown as Record<string, unknown>);

    if (url.pathname === '/api/case-file') {
      // A real key behind an isolate-local counter would be a cap in name only.
      if (env.OPENAI_API_KEY && !env.LIMITER) {
        console.log(JSON.stringify({ event: 'config', error: 'limiter_unbound' }));
        return Response.json({ ok: false, code: 'busy', message: WORDS.busy }, { status: 503 });
      }
      return caseFileRoute(request, {
        provider: providerFor(env),
        limiter: limiterFor(env, limits),
        limits,
        log,
        heartbeatMs: 10_000,
        local: env.TRYIT_LOCAL === '1',
        // Optional. Without it the counter's key still rotates daily and keeps
        // the address out of storage; with it, an address cannot be searched
        // for at all. See `counterKey`.
        ...(env.TRYIT_COUNTER_SALT ? { salt: env.TRYIT_COUNTER_SALT } : {}),
      });
    }

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        provider: env.OPENAI_API_KEY ? 'live' : 'scripted',
        limiter: env.LIMITER ? 'durable' : 'isolate',
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405 });

    if (url.pathname !== '/') return new Response('Not found', { status: 404 });

    const nonce = crypto.randomUUID().replace(/-/g, '');
    const body = page({
      landingUrl: env.LANDING_URL ?? DEFAULT_LANDING,
      repoUrl: env.REPO_URL ?? DEFAULT_REPO,
      samples: SAMPLES,
      maxInputChars: limits.maxInputChars,
      perIpPerDay: limits.perIpPerDay,
      nonce,
    });
    return new Response(request.method === 'HEAD' ? null : body, { headers: headers(nonce) });
  },
};
