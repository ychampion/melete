import { describe, expect, test } from 'bun:test';
import { ID_PREFIXES } from './common.ts';
import {
  attemptBundle,
  attemptOutcome,
  CONTEXT_LIMITS,
  dedupKey,
  isDurableRuntimeEvent,
  RUNTIME_EVENT_TYPES,
  runtimeEvent,
} from './runtime.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const id = (prefix: string) => `${prefix}_${SUFFIX}`;
const NOW = '2026-09-11T00:00:00.000Z';

const bundle = {
  attempt: {
    id: id(ID_PREFIXES.attempt),
    job_id: id(ID_PREFIXES.job),
    epoch: 2,
    revision: 1,
    token: 'header.payload.signature',
  },
  job: {
    title: 'Chase the lease renewal',
    objective: 'Get a signed renewal before the end of the month.',
    constraints: {},
    progress_summary: 'Sent one message; waiting on a reply.',
    unresolved_questions: [],
    deliverable: { kind: 'message_sent' },
  },
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [] },
  transcript: [{ role: 'user', content: 'chase the landlord', at: NOW }],
  tools: [
    {
      name: 'email.send',
      description: 'Send a message from a connected mailbox.',
      input_schema: { type: 'object' },
      effect_class: 'write_external',
      connection_id: id(ID_PREFIXES.connection),
    },
  ],
  skills: [{ name: 'draft-follow-up', body: 'Write four sentences. Ask for a date.' }],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 12, max_output_tokens: 8000, max_wall_ms: 300000, max_actions: 5 },
  model: { provider: 'fireworks', model: 'deepseek-v4p1-flash', fallback: null },
};

describe('attempt bundle', () => {
  test('parses the shape the runtime is handed', () => {
    const parsed = attemptBundle.parse(bundle);
    expect(parsed.workspace.mount).toBe('/work');
    expect(parsed.tools[0]?.effect_class).toBe('write_external');
  });

  test('refuses a workspace mounted anywhere but /work', () => {
    const wrong = { ...bundle, workspace: { mount: '/', files: [] } };
    expect(attemptBundle.safeParse(wrong).success).toBe(false);
  });

  test('refuses an attempt with no capability token', () => {
    const wrong = { ...bundle, attempt: { ...bundle.attempt, token: '' } };
    expect(attemptBundle.safeParse(wrong).success).toBe(false);
  });
});

describe('attempt outcome', () => {
  test('a completed outcome carries its evidence', () => {
    const parsed = attemptOutcome.parse({
      kind: 'completed',
      summary: 'Sent the follow-up.',
      evidence: [{ kind: 'action', action_id: id(ID_PREFIXES.action) }],
    });
    expect(parsed.kind).toBe('completed');
  });

  test('waiting for approval must name at least one action', () => {
    expect(attemptOutcome.safeParse({ kind: 'waiting_for_approval', action_ids: [] }).success).toBe(
      false,
    );
  });

  test('there is no outcome kind outside the six the contract allows', () => {
    expect(attemptOutcome.safeParse({ kind: 'succeeded' }).success).toBe(false);
  });
});

describe('runtime events', () => {
  test('the dedup key is attempt id and local sequence, and both sides agree on it', () => {
    expect(dedupKey('att_1', 7)).toBe('att_1:7');
  });

  test('an event parses with its dedup key', () => {
    const parsed = runtimeEvent.parse({
      type: 'tool_call_proposed',
      attempt_id: id(ID_PREFIXES.attempt),
      local_seq: 3,
      dedup_key: dedupKey(id(ID_PREFIXES.attempt), 3),
      at: NOW,
      tool: 'email.draft',
      call_id: 'call_1',
      arguments: { to: 'a@example.com' },
    });
    expect(parsed.dedup_key).toBe(`${id(ID_PREFIXES.attempt)}:3`);
  });

  test('only text deltas are transient', () => {
    for (const type of RUNTIME_EVENT_TYPES) {
      expect(isDurableRuntimeEvent(type)).toBe(type !== 'text_delta');
    }
  });
});

describe('context limits', () => {
  test('the thin-harness numbers are in the contract, not in prose somewhere', () => {
    expect(CONTEXT_LIMITS.identity_tokens).toBe(250);
    expect(CONTEXT_LIMITS.max_skills).toBe(3);
    expect(CONTEXT_LIMITS.max_tools).toBe(15);
  });
});
