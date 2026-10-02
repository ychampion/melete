import { describe, expect, test } from 'bun:test';
import type { Action } from '@melete/contracts';
import type { ConnectorContext } from '../connectors/types.ts';
import { createCommandLineConnector, type ForwardResult, relaying } from './connector.ts';

const HASH = 'a'.repeat(64);
const action = { id: 'act_1', connection_id: 'conn_1', payload_hash: HASH } as unknown as Action;
const connector = createCommandLineConnector('github');

/** What the broker records for a change whose request got this answer. */
const recorded = async (result: ForwardResult) =>
  (
    await relaying(
      HASH,
      async () => result,
      () => connector.execute(action, {} as ConnectorContext),
    )
  ).value;
const answered = (status: number, extra: Partial<ForwardResult & { outcome: 'answered' }> = {}) =>
  recorded({
    outcome: 'answered',
    response: { status, headers: {}, body: Buffer.alloc(0) },
    detail: { status },
    ...extra,
  });

describe('what a sent change is recorded as', () => {
  test('a server error after the change was sent may have taken effect, and is never recorded as nothing changed', async () => {
    for (const status of [500, 502, 503, 504]) {
      const outcome = await answered(status);
      expect(outcome.outcome).toBe('unknown');
      expect('reason' in outcome ? outcome.reason : '').toContain('may have taken effect');
    }
    // A refusal is the service saying it did nothing.
    expect(await answered(422)).toMatchObject({ outcome: 'failed', retryable: false });
  });

  test('an answer that cannot say whether the change landed is unknown, and a rejected one failed', async () => {
    expect(await answered(200, { uncertain: 'it may have landed' })).toEqual({
      outcome: 'unknown',
      reason: 'it may have landed',
    });
    expect(await answered(200, { rejected: 'refused' })).toMatchObject({
      outcome: 'failed',
      reason: 'refused',
    });
    expect((await answered(201)).outcome).toBe('succeeded');
  });
});
