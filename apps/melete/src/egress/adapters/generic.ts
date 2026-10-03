/**
 * The request itself as the thing a person approves: what any adapter falls
 * back on for a write it has no better summary for, and what the relay uses
 * when an adapter cannot read a request at all. The relay adds the exact body
 * digest and the forwarded headers to every write's payload as well, so the
 * approval is bound to the bytes that are sent, not to how they parse.
 */
import { createHash } from 'node:crypto';
import { canonicalizePayload, type JsonObject } from '@melete/contracts';
import type { Classification, InterceptedRequest } from './types.ts';

/** The most of a body a card shows; the rest is counted, never hidden silently. */
export const SHOWN_BODY_CHARS = 3500;

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const TEXT_TYPE =
  /^(?:text\/|application\/(?:x-www-form-urlencoded|(?:[\w.+-]+\+)?xml|graphql|javascript)\b)/i;

/** A body by its size and digest, with the canonical JSON beside it for display. */
export function canonicalBody(request: InterceptedRequest): JsonObject {
  if (request.body.length === 0) return { bytes: 0 };
  const digest = {
    bytes: request.body.length,
    sha256: createHash('sha256').update(request.body).digest('hex'),
  };
  if (JSON_TYPE.test(request.headers['content-type'] ?? '')) {
    try {
      const parsed: unknown = JSON.parse(request.body.toString('utf8'));
      return {
        ...digest,
        json: canonicalizePayload({ value: parsed as JsonObject }).canonical.value ?? null,
      };
    } catch {
      // Not JSON after all: shown as text or by its digest like any other body.
    }
  }
  return digest;
}

/** Text with a plain note of how much was left out. */
export function shownText(text: string): string {
  if (text.length <= SHOWN_BODY_CHARS) return text;
  return `${text.slice(0, SHOWN_BODY_CHARS)}\n… ${text.length - SHOWN_BODY_CHARS} more characters not shown`;
}

/** The body as a person can read it: JSON, text, or its size and digest. */
export function shownBody(request: InterceptedRequest, body: JsonObject): string {
  if (request.body.length === 0) return 'No body';
  if ('json' in body) return shownText(JSON.stringify(body.json, null, 2));
  const text = request.body.toString('utf8');
  const readable =
    TEXT_TYPE.test(request.headers['content-type'] ?? '') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes mark a binary body.
    (!text.includes('�') && !/[\u0000-\u0008\u000E-\u001F]/.test(text));
  if (readable) return shownText(text);
  return `${request.body.length} bytes of binary data, sha256 ${String(body.sha256)}`;
}

/** A generic write: the request itself, which is what the person approves. */
export function requestWrite(request: InterceptedRequest): Classification {
  const body = canonicalBody(request);
  const target = `${request.path}${request.query ? `?${request.query}` : ''}`;
  return {
    kind: 'write',
    operation: 'request',
    payload: {
      host: request.host,
      method: request.method,
      url_path: request.path,
      query: request.query,
      body,
    },
    summary: {
      title: `${request.method} ${target} on ${request.host}`,
      facts: [
        { label: 'Request', value: `${request.method} https://${request.host}${target}` },
        { label: 'Details', value: shownBody(request, body) },
      ],
    },
    // A delete removes, and a put replaces whatever was there.
    destructive: request.method === 'DELETE' || request.method === 'PUT',
  };
}
