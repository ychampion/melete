import { describe, expect, test } from 'bun:test';
import type { AttemptOutcome, CanonicalMessage, Deliverable } from '@melete/contracts';
import {
  assembleHistory,
  BundleContextLimitError,
  boundTranscript,
  type CompletionRecords,
  evaluateCompletion,
  TRANSCRIPT_MAX_CHARACTERS,
  TRANSCRIPT_MAX_MESSAGES,
} from './bundle.ts';

const at = '2026-09-11T08:00:00.000Z';
const later = '2026-09-11T08:01:00.000Z';
const actionId = 'act_01J00000000000000000000000';
const artifactId = 'art_01J00000000000000000000000';
const knowledgeId = 'k_01J00000000000000000000000';
const jobId = 'job_01J00000000000000000000000';
const spaceId = 'sp_01J00000000000000000000000';
const connectionId = 'conn_01J00000000000000000000000';
const completed: Extract<AttemptOutcome, { kind: 'completed' }> = {
  kind: 'completed',
  summary: 'A supported answer.',
  evidence: [],
};
const subject = (deliverable: Deliverable = { kind: 'none' }) => ({
  id: jobId,
  spaceId,
  constraints: { deliverable },
});
const records = (): CompletionRecords => ({ actions: [], artifacts: [], knowledge: [] });
const storedArtifact: CompletionRecords['artifacts'][number] = {
  id: artifactId,
  jobId,
  spaceId,
  path: 'reports/result.md',
  contentHash: 'verified-hash',
  size: 80,
};
const storedKnowledge: CompletionRecords['knowledge'][number] = {
  id: knowledgeId,
  spaceId,
  status: 'active',
  contentHash: 'verified-hash',
};
const storedAction: CompletionRecords['actions'][number] = {
  id: actionId,
  jobId,
  spaceId,
  connectionId,
  kind: 'test.send',
  effectClass: 'write_external',
  status: 'succeeded',
  receipt: {
    action_id: actionId,
    connection_id: connectionId,
    external_ref: 'message-id',
    detail: { sent: true },
    received_at: at,
    late: false,
  },
};

describe('durable attempt context', () => {
  test('separates inputs after the cursor and ignores streamed text as canonical history', () => {
    const result = assembleHistory(
      [
        {
          seq: 1,
          type: 'notice',
          payload: { kind: 'user_message', text: 'Earlier.' },
          createdAt: new Date(at),
        },
        {
          seq: 2,
          type: 'text_delta',
          payload: { text: 'Uncommitted streamed answer.' },
          createdAt: new Date(at),
        },
        {
          seq: 3,
          type: 'notice',
          payload: { kind: 'user_message', text: 'New input.' },
          createdAt: new Date(later),
        },
        {
          seq: 4,
          type: 'approval_decided',
          payload: { action_id: actionId, decision: 'denied' },
          createdAt: new Date(later),
        },
        {
          seq: 5,
          type: 'notice',
          payload: { kind: 'trigger_event', event: { cursor: '42', subject: 'Ready.' } },
          createdAt: new Date(later),
        },
      ],
      [],
      2,
    );
    expect(result.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'New input.',
    ]);
    expect(result.inputs.approval_results).toEqual([
      { action_id: actionId, decision: 'denied', note: null },
    ]);
    expect(result.inputs.trigger_events).toEqual([{ cursor: '42', subject: 'Ready.' }]);
    expect(result.transcript.map((message) => message.content)).toEqual(['Earlier.', 'New input.']);
  });

  test('retains durable tool results and only committed, unfenced summaries or drafts', () => {
    const result = assembleHistory(
      [
        {
          seq: 1,
          type: 'tool_result',
          payload: { call_id: 'stable-call', ok: true, result: { saved: true } },
          createdAt: new Date(at),
        },
      ],
      [
        {
          outcome: 'completed',
          outcomeDetail: { ...completed, summary: 'Latest durable summary.' },
          endedAt: new Date(later),
          startedAt: new Date(at),
        },
        {
          outcome: 'waiting_for_input',
          outcomeDetail: {
            kind: 'waiting_for_input',
            question: 'Which?',
            draft: 'A durable draft.',
          },
          endedAt: new Date(at),
          startedAt: new Date(at),
        },
        {
          outcome: 'completed',
          outcomeDetail: { ...completed, summary: 'Not yet committed.' },
          endedAt: null,
          startedAt: new Date(later),
        },
        {
          outcome: 'fenced',
          outcomeDetail: { ...completed, summary: 'Stale answer.' },
          endedAt: new Date(later),
          startedAt: new Date(at),
        },
        {
          outcome: 'failed',
          outcomeDetail: { ...completed, summary: 'Mismatched outcome.' },
          endedAt: new Date(later),
          startedAt: new Date(at),
        },
      ],
      0,
    );
    expect(result.transcript.map((message) => message.content)).toEqual([
      '{"ok":true,"result":{"saved":true}}',
      'A durable draft.',
      'Latest durable summary.',
    ]);
    expect(result.transcript[0]).toMatchObject({ role: 'tool', tool_call_id: 'stable-call' });
    expect(result.progressSummary).toBe('Latest durable summary.');
  });

  test('refuses a malformed persisted tool result instead of losing its replay identity', () => {
    expect(() =>
      assembleHistory(
        [
          {
            seq: 1,
            type: 'tool_result',
            payload: { ok: true, result: {} },
            createdAt: new Date(at),
          },
        ],
        [],
        0,
      ),
    ).toThrow();
  });

  test('reserves every completed tool identity before selecting the latest conversation', () => {
    const messages: CanonicalMessage[] = [
      { role: 'tool', tool_call_id: 'old-effect', content: 'Saved.', at },
      ...Array.from(
        { length: 120 },
        (_, index): CanonicalMessage => ({ role: 'user', content: `Message ${index}`, at }),
      ),
    ];
    const bounded = boundTranscript(messages);
    expect(bounded).toHaveLength(TRANSCRIPT_MAX_MESSAGES);
    expect(bounded[0]?.tool_call_id).toBe('old-effect');
    expect(bounded.at(-1)?.content).toBe('Message 119');
    expect(bounded.some((message) => message.content === 'Message 0')).toBe(false);
  });

  test('preserves the latest result for a repeated call ID once', () => {
    const bounded = boundTranscript([
      { role: 'tool', tool_call_id: 'same-call', content: 'First result.', at },
      { role: 'user', content: 'A message.', at },
      { role: 'tool', tool_call_id: 'same-call', content: 'Final durable result.', at: later },
    ]);
    expect(bounded).toHaveLength(2);
    expect(bounded.at(-1)?.content).toBe('Final durable result.');
  });

  test('bounds escaped serialized content and marks abbreviation without mutating history', () => {
    const content = '\n"\\'.repeat(20_000);
    const messages: CanonicalMessage[] = [
      { role: 'tool', tool_call_id: 'effect-1', content, at },
      { role: 'user', content, at: later },
    ];
    const bounded = boundTranscript(messages);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(TRANSCRIPT_MAX_CHARACTERS);
    expect(bounded[0]?.tool_call_id).toBe('effect-1');
    expect(
      bounded.every((message) => message.content.includes('Content omitted from bounded context')),
    ).toBe(true);
    expect(messages[0]?.content).toBe(content);
  });

  test('fails closed when completed tool identities exceed either context cap', () => {
    const tooMany = Array.from(
      { length: 101 },
      (_, index): CanonicalMessage => ({
        role: 'tool',
        tool_call_id: `call-${index}`,
        content: '{}',
        at,
      }),
    );
    expect(() => boundTranscript(tooMany)).toThrow(BundleContextLimitError);
    expect(() =>
      boundTranscript([{ role: 'tool', tool_call_id: 'x'.repeat(32_001), content: '{}', at }]),
    ).toThrow(BundleContextLimitError);
  });
});

describe('persisted completion evidence', () => {
  test('no declared deliverable needs no evidence', () => {
    expect(evaluateCompletion(subject(), completed, records())).toEqual({
      all_actions_terminal: true,
      has_unknown_action: false,
      deliverable_declared: false,
      deliverable_satisfied: true,
      artifact_validations_passed: true,
      artifact_failures: [],
    });
  });

  test.each(['proposed', 'admitted', 'dispatched'])(
    'an action in %s prevents all-actions-terminal',
    (status) => {
      const facts = evaluateCompletion(subject(), completed, {
        ...records(),
        actions: [{ ...storedAction, status }],
      });
      expect(facts.all_actions_terminal).toBe(false);
      expect(facts.has_unknown_action).toBe(false);
    },
  );

  test.each(['unknown', 'unresolved'])('an action in %s requires reconciliation', (status) => {
    const facts = evaluateCompletion(subject(), completed, {
      ...records(),
      actions: [{ ...storedAction, status }],
    });
    expect(facts.all_actions_terminal).toBe(false);
    expect(facts.has_unknown_action).toBe(true);
  });

  test.each(['failed', 'denied', 'succeeded'])('an action in %s is terminal', (status) => {
    expect(
      evaluateCompletion(subject(), completed, {
        ...records(),
        actions: [{ ...storedAction, status }],
      }).all_actions_terminal,
    ).toBe(true);
  });

  test('artifact completion requires a referenced record matching the declared glob', () => {
    const job = subject({ kind: 'artifact', path_glob: 'reports/*.md' });
    const evidence = {
      ...completed,
      evidence: [{ kind: 'artifact' as const, artifact_id: artifactId }],
    };
    expect(evaluateCompletion(job, evidence, records()).deliverable_satisfied).toBe(false);
    expect(
      evaluateCompletion(job, completed, { ...records(), artifacts: [storedArtifact] })
        .deliverable_satisfied,
    ).toBe(false);
    expect(
      evaluateCompletion(job, evidence, { ...records(), artifacts: [storedArtifact] })
        .deliverable_satisfied,
    ).toBe(true);
    expect(
      evaluateCompletion(job, evidence, {
        ...records(),
        artifacts: [{ ...storedArtifact, path: 'reports/result.csv' }],
      }).deliverable_satisfied,
    ).toBe(false);
    expect(
      evaluateCompletion(job, evidence, {
        ...records(),
        artifacts: [{ ...storedArtifact, path: 'reports\\result.md' }],
      }).deliverable_satisfied,
    ).toBe(true);
    expect(
      evaluateCompletion(job, evidence, {
        ...records(),
        artifacts: [{ ...storedArtifact, path: 'reports/../result.md' }],
      }).deliverable_satisfied,
    ).toBe(false);
  });

  test.each([
    { jobId: 'different-job' },
    { spaceId: 'different-space' },
    { contentHash: '' },
    { size: -1 },
  ])('rejects artifact evidence outside durable ownership or integrity: %j', (change) => {
    const evidence = {
      ...completed,
      evidence: [{ kind: 'artifact' as const, artifact_id: artifactId }],
    };
    expect(
      evaluateCompletion(subject({ kind: 'artifact', path_glob: '**/*.md' }), evidence, {
        ...records(),
        artifacts: [{ ...storedArtifact, ...change }],
      }).deliverable_satisfied,
    ).toBe(false);
  });

  test('message-sent completion checks connection and the matching stored receipt', () => {
    const job = subject({ kind: 'message_sent', connection_id: connectionId });
    const evidence = { ...completed, evidence: [{ kind: 'action' as const, action_id: actionId }] };
    expect(
      evaluateCompletion(job, evidence, { ...records(), actions: [storedAction] })
        .deliverable_satisfied,
    ).toBe(true);
    for (const change of [
      { kind: 'email.read' },
      { effectClass: 'read' },
      { receipt: null },
      { receipt: {} },
      {
        receipt: {
          action_id: actionId,
          connection_id: 'conn_01J00000000000000000000001',
          external_ref: 'wrong',
          detail: {},
          received_at: at,
        },
      },
      { status: 'dispatched' },
      { jobId: 'different-job' },
      { spaceId: 'different-space' },
      { connectionId: 'different-connection' },
    ]) {
      expect(
        evaluateCompletion(job, evidence, {
          ...records(),
          actions: [{ ...storedAction, ...change }],
        }).deliverable_satisfied,
      ).toBe(false);
    }
  });

  test('answer completion requires a nonempty summary and valid persisted evidence', () => {
    const job = subject({ kind: 'answer' });
    const evidence = {
      ...completed,
      evidence: [{ kind: 'knowledge' as const, record_id: knowledgeId }],
    };
    expect(evaluateCompletion(job, evidence, records()).deliverable_satisfied).toBe(false);
    expect(
      evaluateCompletion(job, completed, { ...records(), knowledge: [storedKnowledge] })
        .deliverable_satisfied,
    ).toBe(false);
    expect(
      evaluateCompletion(job, evidence, { ...records(), knowledge: [storedKnowledge] })
        .deliverable_satisfied,
    ).toBe(true);
    expect(
      evaluateCompletion(
        job,
        { ...evidence, summary: ' \n ' },
        { ...records(), knowledge: [storedKnowledge] },
      ).deliverable_satisfied,
    ).toBe(false);
  });

  test.each([
    { spaceId: 'different-space' },
    { status: 'retracted' },
    { status: 'superseded' },
    { status: 'disputed' },
    { contentHash: '' },
  ])('rejects unavailable knowledge evidence: %j', (change) => {
    const evidence = {
      ...completed,
      evidence: [{ kind: 'knowledge' as const, record_id: knowledgeId }],
    };
    expect(
      evaluateCompletion(subject({ kind: 'answer' }), evidence, {
        ...records(),
        knowledge: [{ ...storedKnowledge, ...change }],
      }).deliverable_satisfied,
    ).toBe(false);
  });
});
