import { GatewayError, type GatewayUsage } from './types.ts';

/**
 * What a provider charges for input it read from, or wrote to, its prompt
 * cache, as a share of its ordinary input price. Read from each provider's
 * published pricing: Anthropic bills a cache read at a tenth and a five-minute
 * cache write at a quarter more; OpenAI's current models, and the ChatGPT plan
 * served the same way, bill cached input at a tenth; Fireworks at half; Gemini's
 * implicit cache at a quarter. A provider not listed here, an operator's own
 * endpoint included, is assumed to give no discount, so a person is never
 * charged less than the call may have cost.
 */
export const CACHED_INPUT_PRICE: Readonly<Record<string, { read: number; write: number }>> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.1, write: 1 },
  chatgpt: { read: 0.1, write: 1 },
  fireworks: { read: 0.5, write: 1 },
  google: { read: 0.25, write: 1 },
};

const NO_DISCOUNT = { read: 1, write: 1 } as const;

/**
 * The input a request is charged for, in full-price-equivalent tokens: what was
 * neither read from nor written to the cache at full price, cached input at the
 * provider's cached price, and a cache write at its write price. Rounded up, so
 * a call with any input is never charged nothing.
 */
export function chargedInputTokens(
  usage: Pick<GatewayUsage, 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'>,
  provider: string,
): number {
  const price = Object.hasOwn(CACHED_INPUT_PRICE, provider)
    ? (CACHED_INPUT_PRICE[provider] ?? NO_DISCOUNT)
    : NO_DISCOUNT;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const fresh = usage.inputTokens - cached - written;
  return Math.ceil(fresh + cached * price.read + written * price.write);
}

/** Usage with its charged input filled in for the provider that served it. */
export function withChargedInput(usage: GatewayUsage, provider: string): GatewayUsage {
  return { ...usage, chargedInputTokens: chargedInputTokens(usage, provider) };
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Codepoints worth about a token each: Hangul Jamo, the CJK radicals and
 * ideographs with the kana blocks between them, Hangul syllables, the
 * compatibility ideographs, and the fullwidth and halfwidth forms.
 */
const TOKEN_DENSE = /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-힯豈-﫿＀-￯]/g;

/** Four characters of request body to the token. */
const CHARS_PER_TOKEN = 4;

/**
 * What a serialized request is worth in input tokens.
 *
 * This has to be the engine's own estimate, because the engine decides when to
 * compact by it: a stricter count here refuses a conversation before the engine
 * ever gets the chance to shorten it, and a looser one bills an attempt for more
 * input than its owner allowed. So it reproduces the pinned engine's
 * `estimate_tokens_rough`: a whole token for each codepoint in the scripts a
 * tokenizer charges by the character, and four UTF-8 bytes to the token for
 * everything else. Counting bytes rather than characters for the remainder is
 * what keeps Cyrillic, Greek and Arabic — two bytes to the character and about
 * two to three characters to the token — from being counted at half their price.
 */
export function estimateInputTokens(serialized: string): number {
  // Every codepoint in those blocks is one UTF-16 unit, so what the removal took
  // out of the length is how many there were. One pass, no per-match array.
  const rest = serialized.replace(TOKEN_DENSE, '');
  const dense = serialized.length - rest.length;
  return dense + Math.ceil(Buffer.byteLength(rest, 'utf8') / CHARS_PER_TOKEN);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Accumulates usage from JSON, OpenAI SSE, Responses SSE, and Anthropic SSE. */
/** Fields of a streamed event that carry what the model wrote: text, reasoning or tool arguments. */
const WRITTEN = new Set([
  'content',
  'text',
  'thinking',
  'reasoning',
  'reasoning_content',
  'arguments',
  'partial_json',
  'delta',
]);

/** Everything a streamed event says the model wrote, in any of the three protocols. */
function written(value: unknown, depth = 0): string {
  if (depth > 6 || !value || typeof value !== 'object') return '';
  let found = '';
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      if (WRITTEN.has(key)) found += child;
    } else found += written(child, depth + 1);
  }
  return found;
}

export class UsageCollector {
  modelActual: string | null = null;
  usage: GatewayUsage | null = null;
  completed = false;
  /** Tokens the streamed output came to so far, estimated from its text. */
  private writtenTokens = 0;
  private pending = '';
  private eventData: string[] = [];
  private bytes = 0;
  private decoder = new TextDecoder();
  private inputObserved = false;
  private outputObserved = false;

  constructor(
    readonly streaming: boolean,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  observe(value: unknown): void {
    const root = object(value);
    if (!root) return;
    const response = object(root.response) ?? object(root.message) ?? root;
    if (typeof response.model === 'string') this.modelActual = response.model;
    const usage = object(response.usage) ?? object(root.usage);
    if (usage) {
      const rawInput = usage.input_tokens ?? usage.prompt_tokens;
      const rawOutput = usage.output_tokens ?? usage.completion_tokens;
      const hasCounts = rawInput !== undefined || rawOutput !== undefined;
      if (!hasCounts) return;
      if (
        (rawInput !== undefined && !validCount(rawInput)) ||
        (rawOutput !== undefined && !validCount(rawOutput)) ||
        [
          usage.total_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          object(usage.prompt_tokens_details)?.cached_tokens,
          object(usage.input_tokens_details)?.cached_tokens,
        ].some((value) => value !== undefined && !validCount(value))
      ) {
        this.usage = null;
        this.inputObserved = false;
        this.outputObserved = false;
        return;
      }
      this.inputObserved ||= validCount(rawInput);
      this.outputObserved ||= validCount(rawOutput);
      const previous = this.usage;
      const input =
        usage.input_tokens !== undefined || usage.prompt_tokens !== undefined
          ? count(usage.input_tokens ?? usage.prompt_tokens)
          : (previous?.inputTokens ?? 0);
      const output =
        usage.output_tokens !== undefined || usage.completion_tokens !== undefined
          ? count(usage.output_tokens ?? usage.completion_tokens)
          : (previous?.outputTokens ?? 0);
      // Anthropic names a cache read itself; Chat Completions reports it under
      // prompt_tokens_details and Responses under input_tokens_details.
      const cached = count(
        usage.cache_read_input_tokens ??
          object(usage.prompt_tokens_details)?.cached_tokens ??
          object(usage.input_tokens_details)?.cached_tokens,
      );
      // Anthropic reports uncached input separately. The raw total counts every
      // input token; the price of the cached part is applied by chargedInputTokens.
      const cacheCreation = count(usage.cache_creation_input_tokens);
      const inputTotal = input + ('cache_read_input_tokens' in usage ? cached : 0) + cacheCreation;
      if (!Number.isSafeInteger(inputTotal + output)) {
        this.usage = null;
        this.inputObserved = false;
        this.outputObserved = false;
        return;
      }
      this.usage = {
        inputTokens: inputTotal,
        outputTokens: output,
        cachedInputTokens: cached || previous?.cachedInputTokens || 0,
        // Only Anthropic reports a cache write; elsewhere the field is left out.
        ...(cacheCreation || previous?.cacheWriteInputTokens
          ? { cacheWriteInputTokens: cacheCreation || previous?.cacheWriteInputTokens }
          : {}),
        totalTokens: Math.max(count(usage.total_tokens), inputTotal + output),
      };
    }
    if (root.type === 'message_stop' || root.type === 'response.completed') this.completed = true;
  }

  feed(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) throw new GatewayError(502, 'provider_response_too_large');
    this.pending += this.decoder.decode(chunk, { stream: true });
    if (!this.streaming) return;
    let boundary = this.pending.indexOf('\n');
    while (boundary >= 0) {
      const line = this.pending.slice(0, boundary).replace(/\r$/, '');
      this.pending = this.pending.slice(boundary + 1);
      if (line === '') this.flushEvent();
      else if (line.startsWith('data:')) this.eventData.push(line.slice(5).trimStart());
      boundary = this.pending.indexOf('\n');
    }
  }

  finish(): void {
    this.pending += this.decoder.decode();
    if (this.streaming) {
      if (this.pending.startsWith('data:')) this.eventData.push(this.pending.slice(5).trim());
      this.flushEvent();
    } else {
      this.observe(JSON.parse(this.pending));
      this.completed = true;
    }
    // An empty or partial usage object cannot turn an unmetered call into a free call.
    if (!this.inputObserved || !this.outputObserved) this.usage = null;
  }

  private flushEvent(): void {
    const data = this.eventData.join('\n');
    this.eventData = [];
    if (!data) return;
    if (data === '[DONE]') {
      this.completed = true;
      return;
    }
    const event = JSON.parse(data);
    const text = written(event);
    if (text) this.writtenTokens += estimateInputTokens(text);
    this.observe(event);
  }

  /**
   * What a stream cut off before its usage arrived cost, as best it can be
   * told: the input the gateway counted and the output streamed so far, never
   * more output than the request was allowed.
   */
  estimate(inputTokens: number, maxOutputTokens: number): GatewayUsage {
    const outputTokens = Math.min(maxOutputTokens, this.writtenTokens);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: 0,
    };
  }
}

/** Redacts known credentials even when a provider splits one across stream chunks. */
export class SecretRedactor {
  private pending = '';
  private decoder = new TextDecoder();

  constructor(private readonly secrets: string[]) {}

  feed(chunk: Uint8Array, final = false): string {
    this.pending += this.decoder.decode(chunk, { stream: !final });
    let output = '';
    while (this.pending) {
      const secret = this.secrets.find((key) => this.pending.startsWith(key));
      if (secret) {
        output += '[redacted]';
        this.pending = this.pending.slice(secret.length);
      } else if (!final && this.secrets.some((key) => key.startsWith(this.pending))) {
        break;
      } else {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    return output;
  }
}
