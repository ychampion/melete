import { describe, expect, test } from 'bun:test';
import type { Action } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { ConnectorContext } from '../../apps/melete/src/connectors/types.ts';
import { fixtureConnector, TOOLS } from '../destination.ts';
import { loadCorpus } from '../regrade.ts';
import type { Domain, Scenario } from '../types.ts';

type ObjectSchema = {
  type: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
};
const DOMAINS = Object.keys(TOOLS) as Domain[];
/** A destination that is never reached: these tests read manifests or stop before any query matters. */
const fakeSql = (binding: { scenario: Scenario; memory_scope: unknown }, statements: string[]) =>
  ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    statements.push(text);
    return Promise.resolve(text.includes('FROM eval_fixture') ? [binding] : []);
  }) as unknown as Sql;
const toolsOf = (domain: Domain) =>
  fixtureConnector(fakeSql({ scenario: {} as Scenario, memory_scope: null }, []), domain).manifest
    .tools;
const schemaOf = (domain: Domain, name: string) => {
  const tool = toolsOf(domain).find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing fixture tool ${name}`);
  return tool.input_schema as unknown as ObjectSchema;
};

describe('fixture tool schemas', () => {
  test('each tool declares its own described fields and closes the rest', () => {
    for (const domain of DOMAINS)
      for (const tool of toolsOf(domain)) {
        const schema = tool.input_schema as unknown as ObjectSchema;
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
        const fields = Object.entries(schema.properties);
        expect(fields.length).toBeGreaterThan(0);
        // One shared list of synonyms made every tool look the same to a model.
        expect(fields.length).toBeLessThanOrEqual(5);
        for (const [, field] of fields)
          expect((field.description ?? '').length).toBeGreaterThan(10);
        for (const name of schema.required ?? []) expect(schema.properties[name]).toBeDefined();
      }
  });

  test('a write or a draft names what it cannot do without, and a read asks for nothing', () => {
    for (const domain of DOMAINS) {
      const names = TOOLS[domain];
      expect(schemaOf(domain, names.read).required ?? []).toEqual([]);
      expect((schemaOf(domain, names.write).required ?? []).length).toBeGreaterThan(0);
      expect((schemaOf(domain, names.draft).required ?? []).length).toBeGreaterThan(0);
    }
    expect(schemaOf('mail', TOOLS.mail.write).required).toEqual(['to', 'subject', 'body']);
    expect(Object.keys(schemaOf('mail', TOOLS.mail.write).properties)).toEqual([
      'to',
      'subject',
      'body',
    ]);
    expect(schemaOf('files', TOOLS.files.write).required).toEqual(['path', 'recipient']);
    expect(schemaOf('calendar', TOOLS.calendar.write).required).toEqual(['title', 'start', 'end']);
    // No tool offers another tool's word for the same thing.
    expect(schemaOf('mail', TOOLS.mail.write).properties.recipient).toBeUndefined();
    expect(schemaOf('files', TOOLS.files.write).properties.to).toBeUndefined();
    expect(schemaOf('watch', TOOLS.watch.write).properties.body).toBeUndefined();
  });

  test('every scripted call in the corpus is valid for the tool it names', async () => {
    const corpus = await loadCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(60);
    for (const scenario of corpus) {
      const kind = scenario.script.tool;
      if (kind === 'none') continue;
      const schema =
        kind === 'memory'
          ? schemaOf(scenario.domain, 'memory.recall')
          : schemaOf(scenario.domain, TOOLS[scenario.domain][kind]);
      const given = Object.keys(scenario.script.arguments);
      for (const name of schema.required ?? []) expect(given).toContain(name);
      for (const name of given) expect(Object.keys(schema.properties)).toContain(name);
    }
  });
});

describe('fixture memory recall', () => {
  test('a job with no memory scope recalls nothing, and that is not a failure', async () => {
    const statements: string[] = [];
    const scenario = { id: 'no-memory', domain: 'mail', source: {} } as unknown as Scenario;
    const connector = fixtureConnector(
      fakeSql({ scenario, memory_scope: null }, statements),
      'mail',
    );
    const action = {
      id: 'act_1',
      job_id: 'job_1',
      kind: 'memory.recall',
      connection_id: 'conn_1',
      payload_hash: 'hash',
      canonical_payload: { query: 'anything saved about this' },
    } as unknown as Action;
    const result = await connector.execute(action, {
      idempotency_key: 'act_1',
      job_id: 'job_1',
    } as unknown as ConnectorContext);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('unreachable');
    expect(result.receipt.detail).toEqual({ status: 'complete', items: [], disputed_keys: [] });
    // The call still crosses the recorded boundary like any other read.
    expect(statements.some((text) => text.includes('INSERT INTO eval_dispatch'))).toBe(true);
    expect(statements.some((text) => text.includes('INSERT INTO eval_destination'))).toBe(false);
  });
});
