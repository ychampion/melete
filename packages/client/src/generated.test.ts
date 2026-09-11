/**
 * The generated types must match the committed contract. A client whose types
 * were generated from an older openapi.json is worse than no types at all,
 * because it is wrong with authority.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generateSchemaTypes, openApiPath, schemaPath } from '../scripts/generate.ts';
import type { paths } from './schema.d.ts';

describe('schema.d.ts', () => {
  test('is byte-identical to a fresh run of client:generate', async () => {
    const committed = readFileSync(schemaPath(), 'utf8');
    const fresh = await generateSchemaTypes();
    expect(committed).toBe(fresh);
  });

  test('covers every path in openapi.json', () => {
    const document = JSON.parse(readFileSync(openApiPath(), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const generated = readFileSync(schemaPath(), 'utf8');
    for (const path of Object.keys(document.paths)) {
      expect(generated).toContain(`"${path}"`);
    }
  });

  test('types the job state as the closed set the state machine uses', () => {
    type State = NonNullable<
      paths['/jobs/{jobId}']['get']['responses'][200]['content']['application/json']['job']
    >['state'];
    const states: State[] = [
      'queued',
      'running',
      'waiting_for_input',
      'waiting_for_approval',
      'waiting_for_event_or_time',
      'needs_reconciliation',
      'completed',
      'failed',
      'cancelled',
    ];
    expect(states).toHaveLength(9);
  });
});
