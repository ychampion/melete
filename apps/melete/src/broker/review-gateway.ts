/**
 * The model auto-review asks. It is the service's own model gateway, as the
 * memory extractor's is: the provider key never leaves the gateway, a call is
 * one request of a bounded size, and a call token is good for that call only.
 * How often a person's actions may be reviewed is the broker's limit, counted
 * from its own review records, so this gateway keeps no ledger of its own.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import { GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import { createModelReviewer, type ReviewChat, type Reviewer } from './reviewer.ts';

const INPUT_TOKENS = 8_000;
const OUTPUT_TOKENS = 300;

const responsesReply = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
    }),
  ),
});
const messagesReply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const chatReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export type ReviewGatewayOptions = {
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
  timeoutMs: number;
};

export async function openReviewGateway(options: ReviewGatewayOptions) {
  const live = new Set<string>();
  const server = createModelGateway({
    budget: {
      async reserve(request) {
        if (request.provider !== options.provider || request.model !== options.model)
          throw new GatewayError(403, 'review_principal_denied');
        if (
          request.estimatedTokens > INPUT_TOKENS + OUTPUT_TOKENS ||
          request.maxOutputTokens > OUTPUT_TOKENS
        )
          throw new GatewayError(429, 'review_call_too_large');
        return { id: randomUUID() };
      },
      async settle() {},
    },
    providers: options.providers,
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: options.timeoutMs,
    maxRequestBytes: 128 * 1024,
    maxResponseBytes: 32 * 1024,
    async authenticate(token) {
      // One token, one call: it is spent the moment the gateway accepts it.
      if (!live.delete(token)) throw new GatewayError(401, 'review_principal_denied');
      const principal: GatewayPrincipal = {
        jobId: 'review',
        attemptId: `review:${token}`,
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: INPUT_TOKENS + OUTPUT_TOKENS,
        allowedModels: [{ provider: options.provider, model: options.model }],
      };
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const protocol = protocolForApiMode(modelApiMode(options.provider, options.model));

  const chat: ReviewChat = async (messages, signal) => {
    const token = randomUUID();
    live.add(token);
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const body =
      protocol === 'responses'
        ? { model: options.model, input: messages, max_output_tokens: OUTPUT_TOKENS }
        : protocol === 'messages'
          ? {
              model: options.model,
              system,
              messages: messages.filter((message) => message.role !== 'system'),
              max_tokens: OUTPUT_TOKENS,
            }
          : { model: options.model, messages, max_tokens: OUTPUT_TOKENS };
    try {
      const response = await fetch(`${base}/providers/${options.provider}/v1/${protocol}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-melete-capability': token,
          ...(protocol === 'messages'
            ? { 'x-api-key': 'melete-surrogate-review' }
            : { authorization: 'Bearer melete-surrogate-review' }),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new Error(`review gateway ${response.status}`);
      const result = await response.json();
      return protocol === 'responses'
        ? responsesReply
            .parse(result)
            .output.flatMap((item) => item.content ?? [])
            .filter((item) => item.type === 'output_text')
            .map((item) => item.text)
            .join('')
        : protocol === 'messages'
          ? messagesReply
              .parse(result)
              .content.filter((item) => item.type === 'text')
              .map((item) => item.text ?? '')
              .join('')
          : (chatReply.parse(result).choices[0]?.message.content ?? '');
    } finally {
      live.delete(token);
    }
  };
  return {
    reviewer: createModelReviewer({ model: `${options.provider}/${options.model}`, chat }),
    async close() {
      live.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * The reviewer this deployment runs, or none when the operator turned it off.
 * Without one, every action that would be reviewed goes to the person.
 */
export async function configuredReviewGateway(
  env: Env,
  signIn?: ProviderSignIn,
  fake?: GatewayOptions['fake'],
): Promise<Awaited<ReturnType<typeof openReviewGateway>> | null> {
  const setting = env.MELETE_REVIEW_MODEL?.trim();
  if (setting === 'off') return null;
  return openReviewGateway({
    provider: env.MELETE_REVIEW_PROVIDER?.trim() || env.MELETE_DEFAULT_PROVIDER,
    model: setting || env.MELETE_DEFAULT_MODEL,
    providers: configuredProviders(env, () => {}, signIn),
    fake,
    timeoutMs: env.MELETE_REVIEW_TIMEOUT_MS,
  });
}

export type { Reviewer };
