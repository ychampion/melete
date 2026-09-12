import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { MODEL, State } from '../state.ts';
import { meteredTransport } from '../transport.ts';

const endpoint = 'https://api.fireworks.ai/inference/v1/chat/completions';
const states: State[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const request = (signal?: AbortSignal) =>
  new Request(endpoint, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [] }),
    ...(signal ? { signal } : {}),
  });
const invoice = JSON.stringify({
  model: MODEL,
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
function ledger() {
  const state = new State(':memory:', 50);
  states.push(state);
  // The rate scheduler has separate durable-clock coverage; these cases exercise I/O failure.
  spies.push(spyOn(state, 'requestTime').mockImplementation(() => Date.now()));
  return state;
}
function intercept(implementation: (input: Parameters<typeof fetch>[0]) => Promise<Response>) {
  // Never delegate to native fetch, including when a developer has a provider key set.
  const spy = spyOn(globalThis, 'fetch').mockImplementation(implementation as typeof fetch);
  spies.push(spy);
  return spy;
}
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  for (const state of states.splice(0)) state.close();
});

describe('paid transport interruption accounting', () => {
  test('an already cancelled request neither reserves money nor reaches transport', async () => {
    const state = ledger();
    const fetcher = intercept(async () => {
      throw new Error('Transport must not run');
    });
    await expect(meteredTransport(state, 'rubric')(request(AbortSignal.abort()))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.used()).toBe(0);
  });

  test('an interrupted request retains exactly one conservative reservation without retry', async () => {
    const state = ledger();
    const fetcher = intercept(async (input) => {
      expect(input).toBeInstanceOf(Request);
      expect((input as Request).url).toBe(endpoint);
      expect((input as Request).redirect).toBe('error');
      throw new DOMException('Request interrupted', 'AbortError');
    });
    await expect(meteredTransport(state, 'agent')(request())).rejects.toThrow('interrupted');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.cost('preflight').uncertain).toBe(1);
    const rows = state.db
      .query<{ reserved: number; settled: number | null }, []>(
        'SELECT reserved, settled FROM calls',
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settled).toBeNull();
    const reservation = rows[0];
    if (!reservation) throw new Error('Expected one recorded reservation');
    expect(state.used()).toBe(reservation.reserved);
  });

  test('a body interrupted after intermediate usage retains one reservation', async () => {
    const state = ledger();
    intercept(async () => {
      let first = true;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(new TextEncoder().encode(`data: ${invoice}\n\n`));
            } else controller.error(new Error('Response interrupted'));
          },
        }),
      );
    });
    await expect(meteredTransport(state, 'agent')(request())).rejects.toThrow('interrupted');
    const rows = state.db
      .query<{ reserved: number; settled: number | null }, []>(
        'SELECT reserved, settled FROM calls',
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settled).toBeNull();
    const reservation = rows[0];
    if (!reservation) throw new Error('Expected one recorded reservation');
    expect(state.used()).toBe(reservation.reserved);
  });

  test('settling the same completed response twice never adds another charge', async () => {
    const state = ledger();
    intercept(async () => new Response(invoice));
    expect((await meteredTransport(state, 'agent')(request())).status).toBe(200);
    const rows = state.db.query<{ id: string }, []>('SELECT id FROM calls').all();
    expect(rows).toHaveLength(1);
    const first = rows[0];
    if (!first) throw new Error('Expected one recorded request');
    const cost = state.used();
    state.settle(first.id, 200, invoice);
    expect(state.used()).toBe(cost);
    expect(state.cost('preflight').uncertain).toBe(0);
    expect(state.db.query('SELECT id FROM calls').all()).toHaveLength(1);
  });

  test('rate-limit retries are bounded and each unresolved request remains accounted', async () => {
    const state = ledger();
    const fetcher = intercept(async () => new Response('{}', { status: 429 }));
    expect((await meteredTransport(state, 'agent')(request())).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const rows = state.db.query<{ reserved: number }, []>('SELECT reserved FROM calls').all();
    expect(rows).toHaveLength(3);
    expect(state.cost('preflight').uncertain).toBe(3);
    expect(state.used()).toBeCloseTo(
      rows.reduce((sum, row) => sum + row.reserved, 0),
      12,
    );
  });

  test('a different destination is refused before reservation or transport', async () => {
    const state = ledger();
    const fetcher = intercept(async () => {
      throw new Error('Unexpected external destination');
    });
    await expect(
      meteredTransport(state, 'agent')(new Request('https://fixture.invalid/')),
    ).rejects.toThrow('Unexpected paid endpoint');
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.used()).toBe(0);
  });
});
