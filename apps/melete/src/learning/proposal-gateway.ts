import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.ts';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import {
  type GatewayBudget,
  GatewayError,
  type GatewayPrincipal,
  type GatewayProtocol,
} from '../gateway/types.ts';
import { PROPOSAL_INSTRUCTIONS, STEP_BODIES } from './procedure.ts';
import { learningModelCall } from './proposal-schema.ts';
import { episode } from './schema.ts';

export const PROPOSAL_LIMITS = {
  calls: 1,
  total_tokens: 2048,
  output_tokens: 512,
  timeout_ms: 15000,
} as const;
type Admission = { episodeId: string; jobId: string; spaceId: string };
export type ProposalGateway = Awaited<ReturnType<typeof openProposalGateway>>;

/**
 * This is the existing model gateway with a learning-only ledger and no broker routes.
 * An ended job's capability cannot be reused for inference, so proposals get one
 * separate service-owned call reservation, never an effect capability.
 */
export async function openProposalGateway(options: {
  db: Database;
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
}) {
  const tokens = new Map<string, Admission>();
  const principals = new WeakMap<GatewayPrincipal, Admission>();
  const budget: GatewayBudget = {
    async reserve(request) {
      const admission = principals.get(request.principal);
      if (!admission || request.provider !== options.provider || request.model !== options.model)
        throw new GatewayError(403, 'proposal_principal_denied');
      if (
        request.estimatedTokens > PROPOSAL_LIMITS.total_tokens ||
        request.maxOutputTokens > PROPOSAL_LIMITS.output_tokens
      )
        throw new GatewayError(429, 'proposal_budget_exceeded');
      return options.db.transaction(async (tx) => {
        const [source] = await tx
          .select()
          .from(episode)
          .where(
            and(
              eq(episode.id, admission.episodeId),
              eq(episode.spaceId, admission.spaceId),
              eq(episode.restricted, false),
              gt(episode.expiresAt, new Date()),
            ),
          )
          .for('update');
        if (source?.generationState !== 'generating' || source.judgement !== 'corrected')
          throw new GatewayError(403, 'proposal_evidence_unavailable');
        const [saved] = await tx
          .insert(learningModelCall)
          .values({
            id: randomUUID(),
            episodeId: source.id,
            provider: options.provider,
            model: options.model,
            reservedTokens: request.estimatedTokens,
            maxOutputTokens: request.maxOutputTokens,
          })
          .onConflictDoNothing()
          .returning();
        if (!saved) throw new GatewayError(429, 'proposal_call_already_reserved');
        return { id: saved.id };
      });
    },
    async settle(reservation, settlement) {
      await options.db
        .update(learningModelCall)
        .set({ settlement })
        .where(eq(learningModelCall.id, reservation.id));
    },
  };
  const server = createModelGateway({
    budget,
    providers: options.providers,
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: PROPOSAL_LIMITS.timeout_ms,
    maxRequestBytes: 8192,
    maxResponseBytes: 8192,
    async authenticate(token) {
      const admission = tokens.get(token);
      if (!admission) throw new GatewayError(401, 'proposal_principal_denied');
      const principal: GatewayPrincipal = {
        jobId: admission.jobId,
        attemptId: `proposal:${admission.episodeId}`,
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: PROPOSAL_LIMITS.total_tokens,
        allowedModels: [{ provider: options.provider, model: options.model }],
      };
      principals.set(principal, admission);
      return principal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const protocol: GatewayProtocol =
    options.provider === 'openai' || options.model === 'gpt-6-astra'
      ? 'responses'
      : options.provider === 'anthropic'
        ? 'messages'
        : 'chat/completions';

  return {
    async propose(admission: Admission, signal: string) {
      const token = randomUUID();
      tokens.set(token, admission);
      // Only this finite signal and audited vocabulary cross into inference. No episode prose is read here.
      const input = JSON.stringify({ signal, vocabulary: Object.keys(STEP_BODIES) });
      const messages = [
        { role: 'system', content: PROPOSAL_INSTRUCTIONS },
        { role: 'user', content: input },
      ];
      const body =
        protocol === 'responses'
          ? {
              model: options.model,
              input: messages,
              max_output_tokens: PROPOSAL_LIMITS.output_tokens,
            }
          : protocol === 'messages'
            ? {
                model: options.model,
                system: PROPOSAL_INSTRUCTIONS,
                messages: [messages[1]],
                max_tokens: PROPOSAL_LIMITS.output_tokens,
              }
            : { model: options.model, messages, max_tokens: PROPOSAL_LIMITS.output_tokens };
      try {
        const response = await fetch(`${base}/providers/${options.provider}/v1/${protocol}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-melete-capability': token,
            ...(protocol === 'messages'
              ? { 'x-api-key': 'melete-surrogate-learning' }
              : { authorization: 'Bearer melete-surrogate-learning' }),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(PROPOSAL_LIMITS.timeout_ms + 1000),
        });
        if (!response.ok) throw new Error('proposal_gateway_failed');
        const result = await response.json();
        const text =
          protocol === 'responses'
            ? z
                .object({
                  output: z.array(
                    z.object({
                      type: z.string(),
                      content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
                    }),
                  ),
                })
                .parse(result)
                .output.flatMap((item) => item.content ?? [])
                .filter((item) => item.type === 'output_text')
                .map((item) => item.text)
                .join('')
            : protocol === 'messages'
              ? z
                  .object({
                    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
                  })
                  .parse(result)
                  .content.filter((item) => item.type === 'text')
                  .map((item) => item.text ?? '')
                  .join('')
              : (z
                  .object({
                    choices: z
                      .array(z.object({ message: z.object({ content: z.string() }) }))
                      .min(1),
                  })
                  .parse(result).choices[0]?.message.content ?? '');
        return JSON.parse(text) as unknown;
      } finally {
        tokens.delete(token);
      }
    },
    async close() {
      tokens.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
