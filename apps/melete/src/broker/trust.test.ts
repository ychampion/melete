import { describe, expect, test } from 'bun:test';
import { canonicalizePayload } from '@melete/contracts';
import {
  collectOriginFields,
  createTableTrustResolver,
  describeOrigin,
  resolveOriginWarnings,
} from './trust.ts';

const fields = (payload: Record<string, unknown>) =>
  collectOriginFields(canonicalizePayload(payload).canonical);

const input = (payload: Record<string, unknown>) => ({
  space_id: 'sp_01J00000000000000000000000',
  job_id: 'job_01J00000000000000000000000',
  connection_id: 'conn_01J00000000000000000000000',
  kind: 'email.send',
  effect_class: 'write_external',
  canonical_payload: canonicalizePayload(payload).canonical,
  fields: fields(payload),
});

describe('the fields an effect is gated on', () => {
  test('a message body chooses nothing and is not gated', () => {
    expect(fields({ body: 'Meet at 3pm.', subject: 'Lunch' })).toEqual([]);
  });

  test('every recipient is named by its own path', () => {
    expect(fields({ to: ['b@example.com', 'a@example.com'], body: 'hi' })).toEqual([
      { path: 'to[0]', category: 'recipient', value: 'a@example.com' },
      { path: 'to[1]', category: 'recipient', value: 'b@example.com' },
    ]);
  });

  test('destinations, amounts and resources are gated alongside recipients', () => {
    const found = fields({
      url: 'https://example.com/hook',
      amount: 42.5,
      path: 'notes/plan.md',
      body: 'ignored',
    });
    expect(found).toEqual([
      { path: 'amount', category: 'amount', value: '42.5' },
      { path: 'path', category: 'resource', value: 'notes/plan.md' },
      { path: 'url', category: 'destination', value: 'https://example.com/hook' },
    ]);
  });

  test('a gated name nested inside an object is still gated', () => {
    expect(fields({ invoice: { payee: 'acme', total: 10 } })).toEqual([
      { path: 'invoice.payee', category: 'recipient', value: 'acme' },
      { path: 'invoice.total', category: 'amount', value: '10' },
    ]);
  });

  test('an empty or non-scalar value carries no decision to gate', () => {
    expect(fields({ to: '   ', url: null, amount: true })).toEqual([]);
  });
});

describe('the stub resolver', () => {
  test('answers unknown for a value it has never heard of', async () => {
    const resolver = createTableTrustResolver(new Map());
    const warnings = await resolveOriginWarnings(
      null as never,
      resolver,
      input({ to: 'stranger@example.com' }),
    );
    expect(warnings).toEqual([
      {
        field: 'to',
        origin_trust: 'unknown',
        handle: null,
        description: 'Melete cannot say where this value came from.',
      },
    ]);
  });

  test('a value the owner supplied produces no warning', async () => {
    const resolver = createTableTrustResolver({
      'zara@example.com': { origin_trust: 'owner' },
    });
    expect(
      await resolveOriginWarnings(
        null as never,
        resolver,
        input({ to: 'Zara <ZARA@example.com>' }),
      ),
    ).toEqual([]);
  });

  test('the table can change its mind between two questions', async () => {
    const table = new Map([['zara@example.com', { origin_trust: 'owner' as const }]]);
    const resolver = createTableTrustResolver(table);
    const ask = () =>
      resolveOriginWarnings(null as never, resolver, input({ to: 'zara@example.com' }));
    expect(await ask()).toEqual([]);
    table.set('zara@example.com', {
      origin_trust: 'external_content',
      handle: 'web:friday-page',
      description: 'This address came from a web page fetched on Friday.',
    } as never);
    expect(await ask()).toEqual([
      {
        field: 'to',
        origin_trust: 'external_content',
        handle: 'web:friday-page',
        description: 'This address came from a web page fetched on Friday.',
      },
    ]);
  });

  test('a resolver that stays silent about a gated field does not excuse it', async () => {
    const silent = {
      async resolve() {
        return [];
      },
    };
    const warnings = await resolveOriginWarnings(
      null as never,
      silent,
      input({ to: 'zara@example.com', url: 'https://example.com' }),
    );
    expect(warnings.map((warning) => [warning.field, warning.origin_trust])).toEqual([
      ['to', 'unknown'],
      ['url', 'unknown'],
    ]);
  });

  test('no resolver at all means nothing is asked and nothing is warned about', async () => {
    expect(
      await resolveOriginWarnings(null as never, undefined, input({ to: 'zara@example.com' })),
    ).toEqual([]);
  });

  test('the description names the handle the value came from', () => {
    expect(describeOrigin('external_content', 'web:friday-page')).toBe(
      'This value came from content Melete read, not from you. It came from web:friday-page.',
    );
    expect(describeOrigin('owner', null)).toBe('You supplied this value.');
  });
});
