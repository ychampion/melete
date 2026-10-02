/**
 * The request itself as the thing a person approves: what any adapter falls
 * back on for a write it has no better summary for, and what the relay uses
 * when an adapter cannot read a request at all.
 */
import { createHash } from 'node:crypto';
import { canonicalizePayload, type JsonObject } from '@melete/contracts';
import type { Classification, InterceptedRequest } from './types.ts';

/** A JSON body as canonical JSON; anything else by its digest and size. */
export function canonicalBody(request: InterceptedRequest): JsonObject {
  if (request.body.length === 0) return { bytes: 0 };
  if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(request.headers['content-type'] ?? '')) {
    try {
      const parsed: unknown = JSON.parse(request.body.toString('utf8'));
      return { json: canonicalizePayload({ value: parsed as JsonObject }).canonical.value ?? null };
    } catch {
      // Not JSON after all: held by its digest like any other body.
    }
  }
  return {
    bytes: request.body.length,
    sha256: createHash('sha256').update(request.body).digest('hex'),
  };
}

/** A generic write: the request itself, which is what the person approves. */
export function requestWrite(request: InterceptedRequest): Classification {
  const body = canonicalBody(request);
  const shown =
    'json' in body
      ? JSON.stringify(body.json, null, 2).slice(0, 4000)
      : `${body.bytes} bytes${body.bytes ? `, sha256 ${String(body.sha256).slice(0, 12)}` : ''}`;
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
        { label: 'Details', value: shown },
      ],
    },
    destructive: request.method === 'DELETE',
  };
}
