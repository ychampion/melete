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
 * Nothing here changes what the model reads. The key is an HMAC, under a secret
 * that never leaves this install, of the call's own scope: one conversation, or
 * one service call for one space and the conversation or call it works for. So
 * two people, two spaces or two installs never share a key, and nobody who
 * knows an id can compute one. A key the runtime set itself is replaced by this
 * one, never passed on.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { object } from './metering.ts';
import type { GatewayPrincipal, GatewayProtocol } from './types.ts';

/** The header Fireworks routes a session's requests to one replica by. */
export const SESSION_AFFINITY_HEADER = 'x-session-affinity';

const EPHEMERAL = { type: 'ephemeral' } as const;

/** Blocks a cache breakpoint may not be placed on. */
const UNMARKABLE = new Set(['thinking', 'redacted_thinking']);

/**
 * The secret a gateway keys its cache keys with when it is given none: drawn
 * once per process. Keys then change when the service restarts, which costs one
 * cache miss per conversation and never lets one be shared or computed.
 */
const PROCESS_SECRET = randomBytes(32).toString('hex');

/**
 * What one cache key covers. A conversation is its job. A service call is its
 * purpose, its space, and the conversation whose words it carries, or the call
 * itself when it carries none: a fixed job name such as a mailbox scan's is
 * shared by every space, so it is never the scope on its own.
 */
export function promptCacheScope(
  principal: Pick<GatewayPrincipal, 'jobId' | 'attemptId' | 'privacy'>,
): string {
  const privacy = principal.privacy;
  if (privacy.kind === 'service')
    return [
      'service',
      privacy.purpose,
      privacy.spaceId,
      privacy.sourceJobId ?? `call:${principal.attemptId}`,
    ].join('\u0000');
  return ['job', principal.jobId].join('\u0000');
}

/** One scope's cache key: stable across its requests, opaque outside the gateway. */
export const promptCacheKey = (scope: string, secret: string = PROCESS_SECRET): string =>
  createHmac('sha256', secret)
    .update(`melete-prompt-cache\u0000${scope}`)
    .digest('hex')
    .slice(0, 32);

/**
 * Whether the request already carries a breakpoint where one may be placed: on
 * a tool, the system prompt's blocks, or a message's blocks. A property named
 * cache_control inside a tool's schema or a tool call's arguments is content.
 */
function hasCacheControl(body: Record<string, unknown>): boolean {
  const marked = (value: unknown) => object(value)?.cache_control !== undefined;
  const blocks = (value: unknown) => (Array.isArray(value) ? value : []);
  if (blocks(body.tools).some(marked) || blocks(body.system).some(marked)) return true;
  return blocks(body.messages).some((message) => blocks(object(message)?.content).some(marked));
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
  options: { provider: string; protocol: GatewayProtocol; scope: string; secret?: string },
): CachingApplied {
  const applied: CachingApplied = { markers: 0, key: false, headers: {} };
  const key = promptCacheKey(options.scope, options.secret);
  if (options.protocol === 'messages') {
    applied.markers = markAnthropicCache(body);
  } else if (
    options.provider === 'openai' ||
    options.provider === 'chatgpt' ||
    body.prompt_cache_key !== undefined
  ) {
    // Set, or replaced when the runtime chose its own: a key the engine derives
    // from its session would carry the conversation's id to the provider.
    body.prompt_cache_key = key;
    applied.key = true;
  }
  if (options.provider === 'fireworks') applied.headers[SESSION_AFFINITY_HEADER] = key;
  return applied;
}
