/**
 * The live extractor. It is the service's own model gateway with a scan-sized
 * ledger, exactly as the learning lane's proposal gateway is the same gateway
 * with an episode-sized one.
 *
 * The point of going through the gateway rather than calling a provider is that
 * the key never leaves it. This module holds a capability token and a surrogate
 * bearer; the gateway holds the credential, pins the upstream to HTTPS, meters
 * the call and settles it. A scan that is cancelled or that overruns its call
 * budget is refused at the ledger, not by asking the model nicely.
 *
 * `gpt-6-astra` is served over the Responses protocol, which
 * `requiresResponsesProtocol` already decides for every `gpt-6` model, so the
 * protocol here is derived rather than chosen.
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createModelGateway, type GatewayOptions } from '../gateway/index.ts';
import { modelApiMode, protocolForApiMode } from '../gateway/providers.ts';
import { type GatewayBudget, GatewayError, type GatewayPrincipal } from '../gateway/types.ts';
import {
  type CompanyExtractor,
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  type ExtractedItem,
  type ExtractionRequest,
  extractionInput,
  parseExtractionReply,
} from './extract.ts';

export const EXTRACTION_LIMITS = {
  /** One message, one call. A retry is a new message's call, never a second opinion. */
  callsPerMessage: 1,
  total_tokens: 16_000,
  output_tokens: 2_048,
  timeout_ms: 45_000,
} as const;

/** The model a live scan uses when the deployment has a key. */
export const DEFAULT_EXTRACTION_MODEL = 'gpt-6-astra';

const responsesReply = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
    }),
  ),
});
const chatReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export type ExtractionGatewayOptions = {
  provider: string;
  model: string;
  providers: NonNullable<GatewayOptions['providers']>;
  fake?: GatewayOptions['fake'];
  fetch?: GatewayOptions['fetch'];
  /** Calls this gateway will admit in total, across the whole scan. */
  maxCalls: number;
};

/**
 * Open a gateway for one scan. The caller closes it when the scan ends, which
 * also drops every token it issued, so nothing outlives the work it was for.
 */
export async function openExtractionGateway(options: ExtractionGatewayOptions) {
  let spent = 0;
  const unanswered = new Set<string>();
  const tokens = new Set<string>();
  const budget: GatewayBudget = {
    async reserve(request) {
      if (request.provider !== options.provider || request.model !== options.model)
        throw new GatewayError(403, 'extraction_model_denied');
      if (
        request.estimatedTokens > EXTRACTION_LIMITS.total_tokens ||
        request.maxOutputTokens > EXTRACTION_LIMITS.output_tokens
      )
        throw new GatewayError(429, 'extraction_budget_exceeded');
      if (spent >= options.maxCalls) throw new GatewayError(429, 'extraction_calls_exhausted');
      spent++;
      return { id: `${spent}` };
    },
    async settle() {},
  };
  const server = createModelGateway({
    budget,
    providers: options.providers,
    fake: options.fake,
    fetch: options.fetch,
    defaultProvider: options.provider,
    timeoutMs: EXTRACTION_LIMITS.timeout_ms,
    maxRequestBytes: 512 * 1024,
    maxResponseBytes: 256 * 1024,
    async authenticate(token) {
      if (!tokens.has(token)) throw new GatewayError(401, 'extraction_principal_denied');
      return {
        jobId: 'companies-scan',
        attemptId: `scan:${token.slice(0, 8)}`,
        epoch: 0,
        revision: 0,
        maxRequests: EXTRACTION_LIMITS.callsPerMessage,
        maxTokens: EXTRACTION_LIMITS.total_tokens,
        allowedModels: [{ provider: options.provider, model: options.model }],
      } satisfies GatewayPrincipal;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const protocol = protocolForApiMode(modelApiMode(options.provider, options.model));

  const extractor: CompanyExtractor = {
    async extract(request: ExtractionRequest): Promise<ExtractedItem[]> {
      const token = randomUUID();
      tokens.add(token);
      const input = extractionInput(request);
      // No tools, and the schema is the only shape the reply may take.
      const body =
        protocol === 'responses'
          ? {
              model: options.model,
              input: [
                { role: 'system', content: EXTRACTION_INSTRUCTIONS },
                { role: 'user', content: input },
              ],
              max_output_tokens: EXTRACTION_LIMITS.output_tokens,
              text: {
                format: {
                  type: 'json_schema',
                  name: EXTRACTION_SCHEMA_NAME,
                  schema: EXTRACTION_SCHEMA,
                  strict: true,
                },
              },
            }
          : {
              model: options.model,
              messages: [
                { role: 'system', content: EXTRACTION_INSTRUCTIONS },
                { role: 'user', content: input },
              ],
              max_tokens: EXTRACTION_LIMITS.output_tokens,
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: EXTRACTION_SCHEMA_NAME,
                  schema: EXTRACTION_SCHEMA,
                  strict: true,
                },
              },
            };
      let answered = false;
      try {
        const response = await fetch(`${base}/providers/${options.provider}/v1/${protocol}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-melete-capability': token,
            authorization: 'Bearer melete-surrogate-companies',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(EXTRACTION_LIMITS.timeout_ms + 1000),
        });
        if (!response.ok) {
          unanswered.add(request.messageId);
          return [];
        }
        answered = true;
        const result = await response.json();
        const text =
          protocol === 'responses'
            ? responsesReply
                .parse(result)
                .output.flatMap((item) => item.content ?? [])
                .filter((item) => item.type === 'output_text')
                .map((item) => item.text)
                .join('')
            : (chatReply.parse(result).choices[0]?.message.content ?? '');
        // A reply that is not the schema yields no items. It never yields a guess.
        return parseExtractionReply(JSON.parse(text));
      } catch {
        // Nothing came back at all: ask again another time. A reply that came
        // back but was not the schema was an answer, and is not paid for twice.
        if (!answered) unanswered.add(request.messageId);
        return [];
      } finally {
        tokens.delete(token);
      }
    },
  };

  return {
    extractor,
    /** Messages whose call got no answer from the provider, for the scan to ask again. */
    unanswered: unanswered as ReadonlySet<string>,
    get callsSpent() {
      return spent;
    },
    async close() {
      tokens.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
