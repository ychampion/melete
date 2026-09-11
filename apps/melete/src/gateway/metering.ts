import { GatewayError, type GatewayUsage } from './types.ts';

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Accumulates usage from JSON, OpenAI SSE, Responses SSE, and Anthropic SSE. */
export class UsageCollector {
  modelActual: string | null = null;
  usage: GatewayUsage | null = null;
  completed = false;
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
      const cached = count(
        usage.cache_read_input_tokens ?? object(usage.prompt_tokens_details)?.cached_tokens,
      );
      // Anthropic reports uncached input separately; caching still consumes the token allowance.
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
    this.observe(JSON.parse(data));
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
