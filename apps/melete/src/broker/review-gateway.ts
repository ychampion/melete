/**
 * The model auto-review asks. It is the service's own model gateway, as the
 * memory extractor's is: the provider key never leaves the gateway, a call is
 * one request of a bounded size, and a call token is good for that call only.
 * How often a person's actions may be reviewed is the broker's limit, counted
 * from its own review records, so this gateway keeps no ledger of its own.
 *
 * The model and the keys are read for each review, so a model the owner
 * connects in the app reviews the next action without a restart. Each call's
 * principal names the space whose action it carries.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import {
  type ModelSettingsService,
  type ServiceModel,
  type ServiceModelSource,
  serviceModelSource,
} from '../gateway/model-settings.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import { GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import {
  createModelReviewer,
  ReviewCallFailed,
  type ReviewChat,
  type Reviewer,
  type ReviewScope,
} from './reviewer.ts';

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
  /** The model every review uses when no `source` is given. */
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  /** The model and keys each review uses, read per review. */
  source?: ServiceModelSource;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
  timeoutMs: number;
};

/**
 * Whose data a review call carries: the space the reviewed action belongs to
 * and the job that proposed it. It has the shape of a service call's privacy
 * scope, so a router that applies per-space privacy settings reads it as such.
 */
export type ReviewPrivacyScope = {
  kind: 'service';
  purpose: 'action_review';
  spaceId: string;
  sourceJobId: string;
};
export type ReviewPrincipal = GatewayPrincipal & { privacy: ReviewPrivacyScope };

/** The principal of one review call: one request, one model, one space. */
export function reviewPrincipal(
  token: string,
  scope: ReviewScope,
  target: ServiceModel,
): ReviewPrincipal {
  return {
    jobId: `review:${scope.spaceId}`,
    attemptId: `review:${token}`,
    privacy: {
      kind: 'service',
      purpose: 'action_review',
      spaceId: scope.spaceId,
      sourceJobId: scope.jobId,
    },
    epoch: 0,
    revision: 0,
    maxRequests: 1,
    maxTokens: INPUT_TOKENS + OUTPUT_TOKENS,
    allowedModels: [{ provider: target.provider, model: target.model }],
  };
}

export async function openReviewGateway(options: ReviewGatewayOptions) {
  type Call = { scope: ReviewScope; target: ServiceModel };
  const live = new Map<string, Call>();
  const server = createModelGateway({
    budget: {
      async reserve(request) {
        const [allowed] = request.principal.allowedModels;
        if (
          !allowed ||
          request.principal.allowedModels.length !== 1 ||
          request.provider !== allowed.provider ||
          request.model !== allowed.model
        )
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
    ...(options.source ? { currentProviders: options.source.providers } : {}),
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: options.timeoutMs,
    maxRequestBytes: 128 * 1024,
    maxResponseBytes: 32 * 1024,
    async authenticate(token) {
      // One token, one call: it is spent the moment the gateway accepts it.
      const call = live.get(token);
      live.delete(token);
      if (!call) throw new GatewayError(401, 'review_principal_denied');
      return reviewPrincipal(token, call.scope, call.target);
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const chat: ReviewChat = async (messages, signal, scope) => {
    // The model is read for each review, so one connected in the app applies at once.
    const target = options.source
      ? await options.source.current()
      : { provider: options.provider, model: options.model };
    const model = `${target.provider}/${target.model}`;
    const protocol = protocolForApiMode(modelApiMode(target.provider, target.model));
    const token = randomUUID();
    live.set(token, { scope, target });
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const body =
      protocol === 'responses'
        ? { model: target.model, input: messages, max_output_tokens: OUTPUT_TOKENS }
        : protocol === 'messages'
          ? {
              model: target.model,
              system,
              messages: messages.filter((message) => message.role !== 'system'),
              max_tokens: OUTPUT_TOKENS,
            }
          : { model: target.model, messages, max_tokens: OUTPUT_TOKENS };
    try {
      const response = await fetch(`${base}/providers/${target.provider}/v1/${protocol}`, {
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
      const text =
        protocol === 'responses'
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
      return { text, model };
    } catch (error) {
      throw new ReviewCallFailed(model, { cause: error });
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
 *
 * MELETE_REVIEW_PROVIDER and MELETE_REVIEW_MODEL, when set, name the model
 * outright. Otherwise reviews use the model new chats use, the one chosen in
 * the app included, and the keys connected there.
 */
export async function configuredReviewGateway(
  env: Env,
  signIn?: ProviderSignIn,
  fake?: GatewayOptions['fake'],
  connected: {
    settings?: ModelSettingsService;
    /** The upstream transport; tests pass a stand-in provider. */
    fetch?: GatewayOptions['fetch'];
  } = {},
): Promise<Awaited<ReturnType<typeof openReviewGateway>> | null> {
  const setting = env.MELETE_REVIEW_MODEL?.trim();
  if (setting === 'off') return null;
  const pinned = { provider: env.MELETE_REVIEW_PROVIDER?.trim(), model: setting };
  return openReviewGateway({
    provider: pinned.provider || env.MELETE_DEFAULT_PROVIDER,
    model: pinned.model || env.MELETE_DEFAULT_MODEL,
    providers: configuredProviders(env, () => {}, signIn),
    source: serviceModelSource({ env, settings: connected.settings, pinned }),
    fake,
    ...(connected.fetch ? { fetch: connected.fetch } : {}),
    timeoutMs: env.MELETE_REVIEW_TIMEOUT_MS,
  });
}

export type { Reviewer };
