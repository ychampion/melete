import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceeded, MODEL, PRICE, State } from '../state.ts';
import type { CellResult } from '../types.ts';

const states: State[] = [];
const directories: string[] = [];
function state(limit = 50, file = ':memory:') {
  const value = new State(file, limit);
  states.push(value);
  return value;
}
afterEach(() => {
  for (const value of states.splice(0)) value.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const request = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [{ role: 'user', content: 'Fixture only.' }],
  max_tokens: 32,
  ...extra,
});
const usage = (input: number, output: number, cached = 0) =>
  JSON.stringify({
    model: MODEL,
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      prompt_tokens_details: { cached_tokens: cached },
    },
  });

describe('the durable money gate', () => {
  test('agent and judge request slots stay spaced across handles and restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melete-eval-rate-'));
    directories.push(directory);
    const file = join(directory, 'state.sqlite');
    const first = state(50, file);
    const second = state(50, file);
    expect(first.requestTime(100_000)).toBe(100_000);
    expect(second.requestTime(100_000)).toBe(107_000);
    const reopened = state(50, file);
    expect(reopened.requestTime(100_000, 30_000)).toBe(130_000);
    expect(first.requestTime(101_000)).toBe(137_000);
    expect(first.used()).toBe(0);
  });
  for (const limit of [0, -1, 50.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`refuses invalid or over-authorized budget ${limit}`, () => {
      expect(() => new State(':memory:', limit)).toThrow();
    });
  }
  test('rejects an unpriced model without a reservation', () => {
    const value = state();
    expect(() => value.reserve(request({ model: 'unpriced' }), 'agent')).toThrow();
    expect(value.used()).toBe(0);
  });
  for (const max_tokens of [undefined, -1, 0, 8193, 1.5, 'unbounded']) {
    test(`rejects unbounded completion ${max_tokens}`, () => {
      const value = state();
      expect(() => value.reserve(request({ max_tokens }), 'agent')).toThrow();
      expect(value.used()).toBe(0);
    });
  }
  test('rejects multiple completions', () => {
    const value = state();
    expect(() => value.reserve(request({ n: 2 }), 'rubric')).toThrow();
  });
  test('agent and rubric share a cap across cells and campaigns', () => {
    const value = state(0.002);
    value.cell = 'first:1';
    value.reserve(request(), 'agent');
    const before = value.used();
    value.cell = 'second:1';
    expect(() => value.reserve(request({ max_tokens: 8192 }), 'rubric')).toThrow(BudgetExceeded);
    expect(value.used()).toBe(before);
  });
  test('unknown calls keep their full reservation after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melete-eval-state-'));
    directories.push(directory);
    const file = join(directory, 'state.sqlite');
    const first = state(50, file);
    first.cell = 'crashed:1';
    first.reserve(request(), 'agent');
    const reserved = first.used();
    const second = state(50, file);
    expect(second.used()).toBe(reserved);
    expect(second.cost('crashed:1').uncertain).toBe(1);
  });
  test('uses uncached, cached, and output token prices', () => {
    const value = state();
    const id = value.reserve(request(), 'agent');
    value.settle(id, 200, usage(100, 10, 60));
    expect(value.used()).toBeCloseTo(
      (40 * PRICE.input + 60 * PRICE.cached + 10 * PRICE.output) / 1e6,
      12,
    );
    expect(value.cost('preflight').uncertain).toBe(0);
  });
  test('reads final streaming usage and ignores terminal markers', () => {
    const value = state();
    const id = value.reserve(request(), 'agent');
    value.settle(id, 200, `data: {"choices":[]}\n\ndata: ${usage(100, 10)}\n\ndata: [DONE]\n\n`);
    expect(value.used()).toBeCloseTo((100 * PRICE.input + 10 * PRICE.output) / 1e6, 12);
  });
  test('an interrupted stream keeps the reservation even after an intermediate invoice', () => {
    const value = state();
    const id = value.reserve(request(), 'agent');
    const reserved = value.used();
    value.settle(id, 200, `data: ${usage(100, 10)}\n\n`);
    expect(value.used()).toBe(reserved);
    expect(value.cost('preflight').uncertain).toBe(1);
  });
  for (const body of [
    '{}',
    '<html>error</html>',
    usage(-1, 4),
    usage(10, -1),
    usage(10, 2, 20),
    usage(1.2, 3),
  ]) {
    test(`retains reserve for missing or invalid usage ${body.slice(0, 35)}`, () => {
      const value = state();
      const id = value.reserve(request(), 'agent');
      const reserved = value.used();
      value.settle(id, 200, body);
      expect(value.used()).toBe(reserved);
      expect(value.cost('preflight').uncertain).toBe(1);
    });
  }
  test('separate handles cannot reserve more than the shared cap', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melete-eval-state-'));
    directories.push(directory);
    const file = join(directory, 'state.sqlite');
    const first = state(0.01, file);
    const second = state(0.01, file);
    let refused = 0;
    for (let index = 0; index < 30; index++) {
      try {
        (index % 2 ? first : second).reserve(request(), 'agent');
      } catch (error) {
        expect(error).toBeInstanceOf(BudgetExceeded);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(first.used()).toBeLessThanOrEqual(0.01);
    expect(first.used()).toBe(second.used());
  });
});

describe('resume identity', () => {
  test('source, selection, provider, and identity pins cannot silently move', () => {
    const value = state();
    for (const name of ['source', 'identity', 'selection', 'provider', 'model']) {
      value.pin(name, 'original');
      value.pin(name, 'original');
      expect(() => value.pin(name, 'edited')).toThrow(/mismatch/);
    }
  });
  test('preserves submitted identities, partial steps, and completed results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'melete-eval-state-'));
    directories.push(directory);
    const file = join(directory, 'state.sqlite');
    const first = state(50, file);
    first.get('one:1');
    first.identities('one:1', 'space-original', 'job-original');
    first.update('one:1', 'first', { initial: { actions: ['action-original'] } });
    const second = state(50, file);
    expect(second.get('one:1')).toMatchObject({
      space_id: 'space-original',
      job_id: 'job-original',
      phase: 'first',
    });
    const result = { id: 'fixture', status: 'passed' } as CellResult;
    second.finish('one:1', result);
    expect(first.results('one:')).toEqual([result]);
    expect(first.results('other:')).toEqual([]);
  });
});

test('null and string token counts do not settle an unknown invoice', () => {
  const value = state();
  for (const input of [null, '100']) {
    const id = value.reserve(request(), 'agent');
    const before = value.used();
    value.settle(
      id,
      200,
      JSON.stringify({ usage: { prompt_tokens: input, completion_tokens: 1 } }),
    );
    expect(value.used()).toBe(before);
  }
});
