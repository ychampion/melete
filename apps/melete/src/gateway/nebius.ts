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

/** A tag may span both model deltas and transport chunks. */
class ThinkingText {
  private pending = '';
  private mode: 'undecided' | 'content' | 'reasoning' = 'undecided';

  constructor(private prefilled: boolean) {}

  split(text: string, separated: boolean, final: boolean, cutOff = false): TextParts {
    this.pending += text;
    const out: TextParts = { content: '', reasoning: '' };
    if (separated) this.prefilled = false;
    while (this.pending) {
      if (this.mode === 'content') {
        // Framing ends with the reasoning prefix. Tags quoted in the answer
        // after it are ordinary text.
        out.content += this.pending;
        this.pending = '';
      } else if (this.mode === 'undecided') {
        if (!this.prefilled) {
          // A parsed response, or thinking disabled by the request, can stream
          // as soon as an explicit opening tag is ruled out. Still recognize
          // one if the provider ignored the off switch.
          const leading = this.pending.trimStart();
          if (!final && '<think>'.startsWith(leading)) break;
          if (!leading.startsWith('<think>')) {
            this.mode = 'content';
            continue;
          }
        }
        const open = this.pending.indexOf('<think>');
        const shut = this.pending.indexOf('</think>');
        if (open >= 0 && (shut < 0 || open < shut)) {
          if (this.pending.slice(0, open).trim()) {
            this.mode = 'content';
            continue;
          }
          out.content += this.pending.slice(0, open);
          this.pending = this.pending.slice(open + '<think>'.length);
          this.mode = 'reasoning';
        } else if (shut >= 0) {
          // NVIDIA's generation template can prefill the opening tag. Until
          // the closing tag arrives, unclassified content must stay buffered.
          out.reasoning += this.pending.slice(0, shut);
          this.pending = this.pending.slice(shut + '</think>'.length);
          this.mode = 'content';
        } else {
          if (final) {
            // With thinking enabled, a raw continuation cut off before the
            // closing tag may still be reasoning. Never publish that guess.
            out[cutOff ? 'reasoning' : 'content'] += this.pending;
            this.pending = '';
          }
          break;
        }
      } else {
        const tag = '</think>';
        const at = this.pending.indexOf(tag);
        if (at >= 0) {
          out[this.mode] += this.pending.slice(0, at);
          this.pending = this.pending.slice(at + tag.length);
          this.mode = 'content';
        } else {
          let held = 0;
          if (!final)
            for (let size = 1; size < tag.length && size <= this.pending.length; size++)
              if (this.pending.endsWith(tag.slice(0, size))) held = size;
          out[this.mode] += this.pending.slice(0, this.pending.length - held);
          this.pending = this.pending.slice(this.pending.length - held);
          break;
        }
      }
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

  constructor(private readonly thinking = true) {}

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
      const thinking = this.choices.get(index) ?? new ThinkingText(this.thinking);
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
        choice.finish_reason === 'length',
      );
      if (typeof message.content === 'string' || parts.content) message.content = parts.content;
      if (reasoning || parts.reasoning) message.reasoning_content = reasoning + parts.reasoning;
      // Token Factory exposes this alias as well as reasoning_content.
      if (typeof message.reasoning === 'string') delete message.reasoning;
    }
    if (root.choices.length > 0) this.last = root;
    return root;
  }

  json(text: string): string {
    return JSON.stringify(this.normalize(JSON.parse(text), false));
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

  private event(text: string): string {
    const lines = text.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return `${text}\n\n`;
    if (data === '[DONE]') return `${this.flush()}data: [DONE]\n\n`;
    const normalized = this.normalize(JSON.parse(data), true);
    const extra = lines.filter((line) => !line.startsWith('data:')).join('\n');
    return `${extra ? `${extra}\n` : ''}data: ${JSON.stringify(normalized)}\n\n`;
  }

  push(text: string): string {
    this.pending += text;
    let out = '';
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      out += this.event(this.pending.slice(0, boundary.index));
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
    }
    return out;
  }

  end(): string {
    const rest = this.pending;
    this.pending = '';
    return (rest ? this.event(rest) : '') + this.flush();
  }
}
