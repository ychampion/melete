/**
 * Provider prompt-caching controls, set by the gateway on the way out.
 *
 * A provider reuses the longest prefix a request shares with an earlier one, and
 * the runtime already orders each request so its stable parts come first. What
 * differs by provider is what asks for that reuse:
 *
 * - Anthropic caches only up to explicit `cache_control` breakpoints. The engine
 *   places its own for a Claude model; when a request arrives with none, the
 *   gateway marks the end of the tool definitions, the end of the system prompt
 *   and, when it is written as blocks, the end of the newest message: at most
 *   three of the four breakpoints a request may carry.
 * - OpenAI, and the ChatGPT plan served over the same protocol, cache any long
 *   prefix on their own; `prompt_cache_key` routes requests that share one to
 *   the same cache, so every request of a conversation names the same key.
 * - Fireworks caches on its own too, per replica; the session-affinity header
 *   keeps a conversation's requests on the replica that holds its prefix.
 *
 * Nothing here changes what the model reads. The key is a digest of the job, so
 * no Melete identifier leaves the gateway, and a request the runtime already
 * marked or keyed is passed on as it is.
 */
import { createHash } from 'node:crypto';
import { object } from './metering.ts';
import type { GatewayProtocol } from './types.ts';

/** The header Fireworks routes a session's requests to one replica by. */
export const SESSION_AFFINITY_HEADER = 'x-session-affinity';

const EPHEMERAL = { type: 'ephemeral' } as const;

/** Blocks a cache breakpoint may not be placed on. */
const UNMARKABLE = new Set(['thinking', 'redacted_thinking']);

/** One conversation's cache key: stable across its requests, opaque outside the gateway. */
export const promptCacheKey = (jobId: string): string =>
  createHash('sha256').update(`melete-prompt-cache:${jobId}`).digest('hex').slice(0, 32);

function hasCacheControl(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasCacheControl(item, depth + 1));
  const node = object(value);
  if (!node) return false;
  if ('cache_control' in node) return true;
  return Object.values(node).some((item) => hasCacheControl(item, depth + 1));
}

/**
 * Marks the last block of a content field. A system prompt given as a plain
 * string becomes one text block carrying the mark; a message's content is never
 * reshaped, because history is passed on as the runtime wrote it, so a message
 * written as a plain string is left unmarked.
 */
function markContent(holder: Record<string, unknown>, key: string, reshape: boolean): boolean {
  const content = holder[key];
  if (typeof content === 'string') {
    if (!content || !reshape) return false;
    holder[key] = [{ type: 'text', text: content, cache_control: EPHEMERAL }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  const last = object(content.at(-1));
  if (!last || (typeof last.type === 'string' && UNMARKABLE.has(last.type))) return false;
  last.cache_control = EPHEMERAL;
  return true;
}

/**
 * Anthropic breakpoints for a request that carries none: the last tool, the
 * system prompt and the newest message. Returns how many were placed.
 */
export function markAnthropicCache(body: Record<string, unknown>): number {
  if (hasCacheControl(body)) return 0;
  let placed = 0;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const lastTool = object(tools.at(-1));
  if (lastTool) {
    lastTool.cache_control = EPHEMERAL;
    placed++;
  }
  if (markContent(body, 'system', true)) placed++;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const newest = object(messages.at(-1));
  if (newest && markContent(newest, 'content', false)) placed++;
  return placed;
}

/** What the caching controls added to one request, for its headers and for tests. */
export type CachingApplied = { markers: number; key: boolean; headers: Record<string, string> };

/**
 * Applies the controls this provider and protocol support to an outbound body,
 * in place, and returns the headers to send with it.
 */
export function applyPromptCaching(
  body: Record<string, unknown>,
  options: { provider: string; protocol: GatewayProtocol; jobId: string },
): CachingApplied {
  const applied: CachingApplied = { markers: 0, key: false, headers: {} };
  const key = promptCacheKey(options.jobId);
  if (options.protocol === 'messages') {
    applied.markers = markAnthropicCache(body);
  } else if (options.provider === 'openai' || options.provider === 'chatgpt') {
    if (body.prompt_cache_key === undefined) {
      body.prompt_cache_key = key;
      applied.key = true;
    }
  } else if (options.provider === 'fireworks') {
    applied.headers[SESSION_AFFINITY_HEADER] = key;
  }
  return applied;
}
