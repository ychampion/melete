/**
 * A decision on the stream settles the permission card it names, and only
 * that one. A request a later message made stale reads as replaced, never as
 * blank or as refused.
 */
import { expect, test } from 'bun:test';
import { permissionOutcome } from '../chat/parts.tsx';
import { applyEvent, emptyTranscript } from './reduce.ts';
import type { ExperienceEvent, Permission } from './types.ts';

const AT = '2026-09-25T09:00:00.000Z';
let seq = 0;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});
const permission = (id: string): Permission => ({
  id,
  conversation_id: 'job_1',
  what: 'Send the email to sam@example.test',
  why: ['This change needs your permission before it happens.'],
  options: ['allow_once', 'deny'],
  version: 'v1',
  preview: null,
  created_at: AT,
});
const decided = (transcript: ReturnType<typeof emptyTranscript>) =>
  transcript.turns.flatMap((turn) =>
    turn.blocks.flatMap((block) =>
      block.type === 'permission' ? [[block.permission.id, block.decided]] : [],
    ),
  );

test('a replaced permission settles as replaced, and the other card keeps waiting', () => {
  let transcript = emptyTranscript();
  for (const id of ['apr_old', 'apr_other'])
    transcript = applyEvent(transcript, event({ type: 'permission', permission: permission(id) }));
  transcript = applyEvent(
    transcript,
    event({
      type: 'decision',
      decision: {
        kind: 'permission',
        id: 'apr_old',
        outcome: 'replaced',
        answer: null,
        decided_at: AT,
      },
    }),
  );
  expect(decided(transcript)).toEqual([
    ['apr_old', 'replaced'],
    ['apr_other', null],
  ]);
});

test('every decided card says what it came to', () => {
  expect(permissionOutcome('replaced')).toBe('Replaced by your new message');
  expect(permissionOutcome('deny')).toBe('Denied');
  expect(permissionOutcome(null)).toBeNull();
});
