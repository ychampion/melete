/** Diagnostic only: schema acceptance is not an implementation or an end-to-end test. */
import {
  eventType,
  memoryAudience,
  responsibilityEvent,
  runtimeEvent,
  skillFrontmatter,
  spaceKind,
} from '@melete/contracts';

const attemptId = `att_${'01J'.padEnd(26, '0')}`;
const hook = {
  attempt_id: attemptId,
  local_seq: 0,
  dedup_key: `${attemptId}:0`,
  at: '2026-09-12T00:00:00.000Z',
  name: 'pre_tool_call',
  tool_name: 'test.read',
  timing: { duration_ms: 0 },
  outcome: 'observed',
  redacted_args_digest: '0'.repeat(64),
};
const skill = skillFrontmatter.parse({
  name: 'shared-procedure',
  description: 'Probe the audience round trip.',
  triggers: ['probe'],
  audience: 'space:sp_01J00000000000000000000000',
});

// A valid control prevents an unrelated base-field typo from looking like a missing variant.
runtimeEvent.parse({ ...hook, type: 'turn_started', turn: 0 });

process.stdout.write(
  `${JSON.stringify({
    runtime_hook_event: runtimeEvent.safeParse({ ...hook, type: 'hook_event' }).success,
    runtime_hook_error: runtimeEvent.safeParse({ ...hook, type: 'hook_error' }).success,
    persisted_hook_event: eventType.safeParse('hook_event').success,
    responsibility_hook_event: responsibilityEvent.shape.type.safeParse('hook_event').success,
    shared_space_kind: spaceKind.safeParse('shared').success,
    space_qualified_memory_audience: memoryAudience.safeParse('space:sp_example').success,
    skill_audience_round_trip: Object.hasOwn(skill, 'audience'),
  })}\n`,
);
