import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorManifest, toolsInScope } from './connector.ts';
import { sseFrame } from './events.ts';
import { buildOpenApiDocument, openApiJson } from './openapi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const committed = join(here, '..', 'openapi.json');

describe('the OpenAPI document', () => {
  const doc = buildOpenApiDocument() as {
    openapi: string;
    paths: Record<string, unknown>;
  };

  test('is OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
  });

  test('covers every surface v0.1 promises', () => {
    const paths = Object.keys(doc.paths);
    for (const expected of [
      '/health',
      '/spaces',
      '/jobs',
      '/jobs/{jobId}',
      '/jobs/{jobId}/events',
      '/events',
      '/actions',
      '/approvals',
      '/connections',
      '/knowledge/search',
      '/skills',
      '/browser/sessions/{id}/takeover',
      '/browser/sessions/{id}/handback',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test('the event endpoints take an after cursor', () => {
    const events = doc.paths['/events'] as {
      get: { parameters?: Array<{ name: string; in: string }> };
    };
    const names = (events.get.parameters ?? []).map((p) => p.name);
    expect(names).toContain('after');
  });

  test('an admission refusal may be a receipt or an error body alone', () => {
    // A denial inside the admission is recorded with a receipt; a retried key
    // whose history belongs to another account, or a malformed key, is not.
    const operations = [
      ['/jobs', 'post'],
      ['/responsibilities', 'post'],
      ['/jobs/{id}/input', 'post'],
      ['/jobs/{jobId}/messages', 'post'],
    ] as const;
    for (const [path, method] of operations) {
      const responses = (
        doc.paths[path] as Record<
          string,
          { responses: Record<string, { content: Record<string, { schema: unknown }> }> }
        >
      )[method]?.responses;
      for (const status of ['400', '403']) {
        const schema = responses?.[status]?.content['application/json']?.schema as {
          anyOf?: unknown[];
        };
        expect(schema.anyOf).toHaveLength(2);
      }
    }
  });

  test('the committed openapi.json is in sync with the schemas', () => {
    const onDisk = readFileSync(committed, 'utf8');
    expect(onDisk).toBe(openApiJson());
  });
});

describe('SSE framing', () => {
  test('the frame id is the sequence a client resumes from', () => {
    const frame = sseFrame({
      seq: 12,
      job_id: null,
      attempt_id: null,
      type: 'notice',
      payload: { title: 'hello' },
      dedup_key: 'x',
      created_at: '2026-09-11T00:00:00.000Z',
    });
    expect(frame.startsWith('id: 12\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame).toContain('event: notice');
  });
});

describe('connector manifests', () => {
  const manifest = connectorManifest.parse({
    name: 'test',
    version: '0.1.0',
    provider: 'test',
    description: 'A destination that can be told to drop its acknowledgement.',
    tools: [
      {
        name: 'test.send',
        description: 'Send a payload to the test destination.',
        input_schema: { type: 'object', properties: { drop_ack: { type: 'boolean' } } },
        effect_class: 'write_external',
        required_scopes: ['test.send'],
        verify: true,
        requires_approval: true,
      },
      {
        name: 'test.read',
        description: 'Read the destination ledger.',
        input_schema: { type: 'object' },
        effect_class: 'read',
        required_scopes: ['test.read'],
        verify: false,
      },
    ],
  });

  test('carries the effect class and the verify capability per tool', () => {
    expect(manifest.tools[0]?.effect_class).toBe('write_external');
    expect(manifest.tools[0]?.verify).toBe(true);
    expect(manifest.tools[1]?.verify).toBe(false);
  });

  test('an out-of-scope tool never appears in the catalog', () => {
    const visible = toolsInScope(manifest, ['test.read']).map((t) => t.name);
    expect(visible).toEqual(['test.read']);
  });

  test('refuses a tool name that is not connector.tool', () => {
    const bad = connectorManifest.safeParse({
      ...manifest,
      tools: [{ ...manifest.tools[0], name: 'send' }],
    });
    expect(bad.success).toBe(false);
  });
});
