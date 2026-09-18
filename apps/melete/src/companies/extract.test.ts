/**
 * The schema the live call actually sends.
 *
 * Strict Structured Outputs is a subset of JSON Schema, and a schema carrying a
 * keyword outside that subset is rejected whole, with a 400, before the model
 * reads a word of it. That failure is invisible from inside the scan: the
 * request fails, no items come back, and a scan closes `done` having found
 * nothing — on every message, on every run, until somebody reads the provider's
 * logs. So the subset is asserted here rather than trusted.
 *
 * The constraints themselves are not lost. They live in the Zod schema beside
 * this one, which is what actually admits or rejects a reply, and they are
 * written into the descriptions so the model is still told what is wanted.
 */

import { describe, expect, test } from 'bun:test';
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  extractedItem,
  parseExtractionReply,
} from './extract.ts';

/**
 * Keywords strict Structured Outputs does not accept. A schema containing any
 * of them is refused with "uses unsupported keyword ... and cannot be
 * represented in strict Structured Outputs".
 */
const UNSUPPORTED = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'minContains',
  'maxContains',
  'uniqueItems',
  'default',
  'format',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
] as const;

type Found = { path: string; keyword: string; value: unknown };

function scan(node: unknown, path = '$', found: Found[] = []): Found[] {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const [index, entry] of node.entries()) scan(entry, `${path}[${index}]`, found);
    return found;
  }
  for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED as readonly string[]).includes(keyword))
      found.push({ path: `${path}.${keyword}`, keyword, value });
    scan(value, `${path}.${keyword}`, found);
  }
  return found;
}

describe('the schema sent to a strict provider', () => {
  test('carries no keyword the strict subset rejects', () => {
    // Reported as paths rather than a bare count, so a failure names the field.
    expect(scan(EXTRACTION_SCHEMA).map((entry) => entry.path)).toEqual([]);
  });

  test('every object states additionalProperties false and requires every property', () => {
    // The other half of the strict contract: a missing `required` entry is also
    // a 400, and it is the half that is easy to break when adding a field.
    const objects: { path: string; node: Record<string, unknown> }[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const [index, entry] of node.entries()) walk(entry, `${path}[${index}]`);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === 'object') objects.push({ path, node: record });
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(EXTRACTION_SCHEMA, '$');
    expect(objects.length).toBeGreaterThan(0);
    for (const { path, node } of objects) {
      expect([path, node.additionalProperties]).toEqual([path, false]);
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
      expect([path, [...(node.required as string[])].sort()]).toEqual([path, properties.sort()]);
    }
  });

  test('the constraints are still stated, so the model is told what is wanted', () => {
    const text = JSON.stringify(EXTRACTION_SCHEMA);
    // The numbers that used to be keywords now have to appear as words.
    expect(text).toContain('at most 12');
    expect(text).toContain('at most 8');
    expect(text).toContain('non-negative');
    expect(text).toContain('ISO-4217');
    expect(EXTRACTION_INSTRUCTIONS).toContain('one to eight quotes');
  });

  test('and the Zod schema still enforces every one of them', () => {
    const base = {
      kind: 'refund_owed',
      direction: 'owed_to_you',
      amount_minor: 100,
      currency: 'GBP',
      due_at: null,
      confidence: 'high',
      suggested_playbook: null,
      summary: 'x',
      evidence: [{ quote: 'q', start: 0, end: 1 }],
    };
    expect(extractedItem.safeParse(base).success).toBe(true);
    expect(extractedItem.safeParse({ ...base, amount_minor: -1 }).success).toBe(false);
    expect(extractedItem.safeParse({ ...base, currency: 'gbp' }).success).toBe(false);
    expect(extractedItem.safeParse({ ...base, summary: 'x'.repeat(501) }).success).toBe(false);
    expect(extractedItem.safeParse({ ...base, evidence: [] }).success).toBe(false);
    expect(
      extractedItem.safeParse({
        ...base,
        evidence: Array.from({ length: 9 }, () => base.evidence[0]),
      }).success,
    ).toBe(false);
    expect(
      extractedItem.safeParse({
        ...base,
        evidence: [{ quote: 'q'.repeat(2001), start: 0, end: 1 }],
      }).success,
    ).toBe(false);
    // And the reply ceiling the schema no longer states.
    expect(parseExtractionReply({ items: Array.from({ length: 13 }, () => base) })).toEqual([]);
  });

  test('is named, so a provider error names it back', () => {
    expect(EXTRACTION_SCHEMA_NAME).toBe('company_ledger_items');
  });
});
