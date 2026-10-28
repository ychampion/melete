import type { ProviderFailure } from '@melete/contracts';
import { object } from './metering.ts';
import { classifyProviderFailure, providerFailureError } from './provider-failure.ts';
import { GatewayError } from './types.ts';

/** An error inside an HTTP 200 response is still a provider failure. */
export class NebiusResponseError extends GatewayError {
  readonly failure: ProviderFailure;

  constructor(error: unknown) {
    const failure = classifyProviderFailure(500, JSON.stringify(error)) ?? 'provider_down';
    const mapped = providerFailureError(failure);
    super(mapped.status, mapped.code);
    this.failure = failure;
  }
}

type TextParts = { content: string; reasoning: string };

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Token Factory returns reasoning in reasoning_content or reasoning. Inline
 * thinking is recognized only when the reply opens with exactly <think>, and
 * only that span is held back until </think>. Everything else streams as it
 * arrives, so tags quoted later in an answer stay answer text. A tag may span
 * model deltas and transport chunks.
 */
class ThinkingText {
  private pending = '';
  private mode: 'undecided' | 'thinking' | 'content' = 'undecided';

  split(text: string, separated: boolean, final: boolean): TextParts {
    this.pending += text;
    const out: TextParts = { content: '', reasoning: '' };
    // With server-side reasoning, content is the answer.
    if (separated && this.mode === 'undecided') this.mode = 'content';
    if (this.mode === 'undecided') {
      const leading = this.pending.trimStart();
      if (leading.startsWith(OPEN)) {
        out.content += this.pending.slice(0, this.pending.length - leading.length);
        this.pending = leading.slice(OPEN.length);
        this.mode = 'thinking';
      } else if (final || !OPEN.startsWith(leading)) this.mode = 'content';
    }
    if (this.mode === 'thinking') {
      const at = this.pending.indexOf(CLOSE);
      if (at >= 0) {
        out.reasoning += this.pending.slice(0, at);
        this.pending = this.pending.slice(at + CLOSE.length);
        this.mode = 'content';
      } else if (final) {
        // An unclosed tag is not proof of reasoning: return the text as sent.
        out.content += OPEN + this.pending;
        this.pending = '';
        this.mode = 'content';
      }
    }
    if (this.mode === 'content') {
      out.content += this.pending;
      this.pending = '';
    }
    return out;
  }
}

/**
 * Normalize Nemotron's inline thinking into the separate OpenAI reasoning
 * field. Answer consumers, including memory's replyOf, read only content.
 * UsageCollector sees the original bytes, so all generated tokens are billed.
 */
export class NemotronReply {
  private pending = '';
  private readonly choices = new Map<number, ThinkingText>();
  private last: Record<string, unknown> | null = null;

  private normalize(value: unknown, streaming: boolean): Record<string, unknown> | null {
    const root = object(value);
    if (!root) return null;
    if (root.error) throw new NebiusResponseError(root.error);
    if (!Array.isArray(root.choices)) return root;
    for (const entry of root.choices) {
      const choice = object(entry);
      const message = object(streaming ? choice?.delta : choice?.message);
      if (!choice || !message) continue;
      const index = typeof choice.index === 'number' ? choice.index : 0;
      const thinking = this.choices.get(index) ?? new ThinkingText();
      this.choices.set(index, thinking);
      const reasoning =
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : typeof message.reasoning === 'string'
            ? message.reasoning
            : '';
      const text = typeof message.content === 'string' ? message.content : '';
      const parts = thinking.split(
        text,
        reasoning.length > 0,
        !streaming || !!choice.finish_reason,
      );
      if (typeof message.content === 'string' || parts.content) message.content = parts.content;
      if (reasoning || parts.reasoning) message.reasoning_content = reasoning + parts.reasoning;
      // Token Factory exposes this alias as well as reasoning_content.
      if (typeof message.reasoning === 'string') delete message.reasoning;
    }
    if (root.choices.length > 0) this.last = root;
    return root;
  }

  /** A body that is not a JSON object goes back as the provider sent it. */
  json(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    const normalized = this.normalize(parsed, false);
    return normalized ? JSON.stringify(normalized) : text;
  }

  private flush(): string {
    if (!this.last) return '';
    const choices = [...this.choices].flatMap(([index, thinking]) => {
      const parts = thinking.split('', false, true);
      return parts.content || parts.reasoning
        ? [
            {
              index,
              delta: {
                ...(parts.content ? { content: parts.content } : {}),
                ...(parts.reasoning ? { reasoning_content: parts.reasoning } : {}),
              },
              finish_reason: null,
            },
          ]
        : [];
    });
    return choices.length
      ? `data: ${JSON.stringify({ ...this.last, choices, usage: null })}\n\n`
      : '';
  }

  /** Events that are not JSON objects pass through unchanged. */
  private event(text: string, end: string): string {
    const lines = text.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return text + end;
    if (data === '[DONE]') return `${this.flush()}data: [DONE]\n\n`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return text + end;
    }
    const normalized = this.normalize(parsed, true);
    if (!normalized) return text + end;
    const extra = lines.filter((line) => !line.startsWith('data:')).join('\n');
    return `${extra ? `${extra}\n` : ''}data: ${JSON.stringify(normalized)}\n\n`;
  }

  push(text: string): string {
    this.pending += text;
    let out = '';
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      out += this.event(this.pending.slice(0, boundary.index), boundary[0]);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
    }
    return out;
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    const last = rest ? this.event(rest, '') : '';
    const held = this.flush();
    // A trailing fragment passed through as sent still needs a boundary
    // before any held text that follows it.
    return last && held && !last.endsWith('\n\n') ? `${last}\n\n${held}` : last + held;
  }
}
