import { expect, test } from 'bun:test';
import type { Action } from '@melete/contracts';
import { dispositionMessage } from './service.ts';

const failed = (effectClass: string, reconciliation: Record<string, unknown> | null) =>
  ({
    id: 'act_01J00000000000000000000000',
    status: 'failed',
    effect_class: effectClass,
    created_at: '2026-10-01T05:31:05.000Z',
    resolved_at: '2026-10-01T05:31:05.500Z',
    receipt: null,
    reconciliation,
  }) as unknown as Action;

test('a failed effect says why it failed, so the model is not left to guess', () => {
  const busy = dispositionMessage(
    failed('write_internal', {
      late: false,
      reason: 'workspace_busy: another attempt is using this agent’s workspace',
      retryable: true,
    }),
    false,
  );
  expect(busy).toContain('workspace_busy: another attempt is using this agent’s workspace');
  expect(busy).toContain('can be tried again');
  expect(busy).toContain('Nothing was sent again.');
});

test('a failed effect that may not be retried does not invite a retry', () => {
  const refused = dispositionMessage(
    failed('write_external', { reason: 'the provider refused the message', retryable: false }),
    false,
  );
  expect(refused).toContain('the provider refused the message');
  expect(refused).not.toContain('tried again');
  const bare = dispositionMessage(failed('write_external', null), true);
  expect(bare).toBe(
    'This effect already failed at 2026-10-01T05:31:05.500Z. Nothing was sent again.',
  );
});

test('a failed read still names its reason', () => {
  expect(
    dispositionMessage(
      failed('read', { reason: 'The page did not answer within 15 seconds.' }),
      false,
    ),
  ).toBe(
    'This read failed: The page did not answer within 15 seconds.. It changed nothing, so it can be tried again or done another way.',
  );
});
