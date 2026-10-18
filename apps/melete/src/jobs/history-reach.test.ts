/**
 * A long chat's history is read with only the tool result bodies an attempt
 * can see (`resultsInReach`). Read that way, it must hand every attempt, and
 * every extension of its summary, exactly what reading every body would.
 */
import { describe, expect, test } from 'bun:test';
import type { CanonicalMessage } from '@melete/contracts';
import { estimateInputTokens } from '../gateway/metering.ts';
import {
  assembleHistory,
  BundleContextLimitError,
  boundHistory,
  collectHistory,
  resultsInReach,
  type TranscriptLimits,
} from './bundle.ts';
import {
  EMPTY_SUMMARY,
  planExtension,
  renderSummary,
  type StoredSummary,
  summaryPayload,
} from './history-summary.ts';

type Event = Parameters<typeof assembleHistory>[0][number];
type Attempt = Parameters<typeof assembleHistory>[1][number];

/** A small seeded generator, so a failing case can be run again. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)) };
}

const GENERATIONS = { policy_generation: 0, connection_generations: {} };
const stub = (seq: number) => ({ call_id: `unread:${seq}`, ok: true, result: {} });

type Chat = {
  events: Event[];
  attempts: Attempt[];
  settledAttempts: Set<string>;
  afterSeq: number;
  limits: TranscriptLimits;
};

/**
 * A chat of finished turns and one under way: times that tie and that run
 * backwards against the order events were written in, tool results large and
 * small, some of the turn under way, and sometimes a stored summary.
 */
function chat(seed: number): Chat {
  const pick = random(seed);
  const events: Event[] = [];
  const attempts: Attempt[] = [];
  const settledAttempts = new Set<string>();
  let seq = 0;
  let clock = Date.parse('2026-09-11T08:00:00.000Z');
  const turns = pick.int(1, 70);
  const times: number[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const current = turn === turns - 1;
    const attemptId = `att_${turn}`;
    if (!current || pick.next() < 0.3) settledAttempts.add(attemptId);
    clock += pick.int(0, 3) * 1000;
    times.push(clock);
    events.push({
      seq: ++seq,
      type: 'notice',
      payload: { kind: 'user_message', text: `Turn ${turn}: ${'w'.repeat(pick.int(1, 400))}` },
      createdAt: new Date(clock),
    });
    for (let call = pick.int(0, 4); call > 0; call--) {
      // A result written after another can carry an earlier time.
      const when = clock + pick.int(-1, 2) * 1000;
      times.push(when);
      events.push({
        seq: ++seq,
        type: 'tool_result',
        attemptId,
        payload: {
          call_id: `call_${turn}_${call}`,
          ok: pick.next() < 0.9,
          result: { output: 'x'.repeat(pick.int(0, pick.next() < 0.2 ? 6_000 : 300)) },
        },
        createdAt: new Date(when),
      });
    }
    if (!current || pick.next() < 0.2) {
      clock += pick.int(0, 2) * 1000;
      times.push(clock);
      attempts.push({
        outcome: 'completed',
        outcomeDetail: {
          kind: 'completed',
          summary: `Answer ${turn}: ${'a'.repeat(pick.int(1, 600))}`,
          evidence: [],
        },
        startedAt: new Date(clock),
        endedAt: new Date(clock),
      });
    }
  }
  // Sometimes more than one message arrives for the turn under way.
  const afterSeq = Math.max(0, seq - pick.int(1, 3));
  if (pick.next() < 0.4 && times.length > 2) {
    const through = times[pick.int(0, times.length - 2)] ?? clock;
    const stored: StoredSummary = {
      through: new Date(through).toISOString(),
      summary: { ...EMPTY_SUMMARY, facts: ['The person writes letters.'] },
      messages: 3,
      generations: GENERATIONS,
    };
    events.push({
      seq: ++seq,
      type: 'notice',
      payload: summaryPayload(stored),
      createdAt: new Date(clock),
    });
  }
  return {
    events,
    attempts,
    settledAttempts,
    afterSeq,
    limits: {
      maxMessages: pick.int(2, 40),
      maxTokens: pick.int(200, 30_000),
      maxBytes: pick.int(2_000, 400_000),
    },
  };
}

/** The history read as the service now reads it: bodies only where an attempt can reach. */
function readInReach(
  { events, attempts, settledAttempts }: Chat,
  afterSeq: number,
  maxMessages: number,
) {
  const unread = events.map((entry) =>
    entry.type === 'tool_result' ? { ...entry, payload: stub(entry.seq) } : entry,
  );
  const sketch = collectHistory(unread, attempts, afterSeq, { settledAttempts });
  const { results } = resultsInReach(sketch, maxMessages);
  const read = events.map((entry) =>
    entry.type === 'tool_result' && !results.has(entry.seq)
      ? { ...entry, payload: stub(entry.seq) }
      : entry,
  );
  return {
    history: collectHistory(read, attempts, afterSeq, { settledAttempts }),
    unread: events.filter((entry) => entry.type === 'tool_result' && !results.has(entry.seq))
      .length,
  };
}

const bounded = <T>(run: () => T): T | 'refused' => {
  try {
    return run();
  } catch (error) {
    if (error instanceof BundleContextLimitError) return 'refused';
    throw error;
  }
};

/** The extension `extendHistory` plans, and the bundle it bounds again around it. */
function extension(
  full: readonly CanonicalMessage[],
  fresh: readonly CanonicalMessage[],
  stored: StoredSummary | null,
  settled: ReadonlySet<CanonicalMessage>,
  limits: TranscriptLimits,
) {
  const isFresh = new Set(fresh);
  const through = stored ? Date.parse(stored.through) : Number.NEGATIVE_INFINITY;
  const prior = full.filter((message) => !isFresh.has(message) && Date.parse(message.at) > through);
  const plan = planExtension(
    prior,
    {
      tokens:
        limits.maxTokens -
        estimateInputTokens(JSON.stringify(fresh)) -
        (stored ? estimateInputTokens(JSON.stringify(renderSummary(stored.summary))) : 0) -
        1_000,
      messages: limits.maxMessages - fresh.length,
    },
    Math.min(...fresh.map((message) => Date.parse(message.at))),
  );
  if (!plan) return null;
  const extended: StoredSummary = {
    through: plan.through,
    summary: stored?.summary ?? EMPTY_SUMMARY,
    messages: 1,
    generations: GENERATIONS,
  };
  return {
    through: plan.through,
    // What the summariser reads: never a tool result.
    said: plan.summarise.filter((message) => message.role !== 'tool'),
    bundle: bounded(() => boundHistory(full, fresh, extended, limits, settled)),
  };
}

describe("a long chat's history read within reach", () => {
  test('hands every attempt what reading every tool result would', () => {
    let skipped = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const conversation = chat(seed);
      const reference = bounded(() =>
        assembleHistory(conversation.events, conversation.attempts, conversation.afterSeq, {
          settledAttempts: conversation.settledAttempts,
          limits: conversation.limits,
        }),
      );
      const { history, unread } = readInReach(
        conversation,
        conversation.afterSeq,
        conversation.limits.maxMessages,
      );
      skipped += unread;
      const read = bounded(() =>
        boundHistory(
          history.full,
          history.inputs.new_user_messages,
          history.stored,
          conversation.limits,
          history.settled,
        ),
      );
      if (reference === 'refused' || read === 'refused') {
        expect({ seed, read }).toEqual({ seed, read: reference });
        continue;
      }
      const expected = reference;
      expect({ seed, ...read }).toEqual({
        seed,
        transcript: expected.transcript,
        ...(expected.earlier ? { earlier: expected.earlier } : {}),
      });
      expect(history.inputs).toEqual(expected.inputs);
    }
    // The case worth having: most chats leave bodies unread.
    expect(skipped).toBeGreaterThan(1_000);
  });

  test('extends the summary over what reading every tool result would, and bounds the same', () => {
    let planned = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const conversation = chat(seed);
      const reference = collectHistory(
        conversation.events,
        conversation.attempts,
        conversation.afterSeq,
        { settledAttempts: conversation.settledAttempts },
      );
      const fresh = reference.inputs.new_user_messages;
      if (fresh.length === 0) continue;
      // The extension reads only what the claim saw, so nothing in it is new.
      const last = Math.max(...conversation.events.map((entry) => entry.seq));
      const { history } = readInReach(
        conversation,
        last,
        conversation.limits.maxMessages + fresh.length,
      );
      const key = (message: CanonicalMessage) => `${message.at}\u0000${message.content}`;
      const freshKeys = new Set(fresh.map(key));
      const readFresh = history.full.filter(
        (message) => message.role === 'user' && freshKeys.has(key(message)),
      );
      const expected = extension(
        reference.full,
        fresh,
        reference.stored,
        reference.settled,
        conversation.limits,
      );
      const read = extension(
        history.full,
        readFresh,
        history.stored,
        history.settled,
        conversation.limits,
      );
      if (expected) planned++;
      expect({ seed, read }).toEqual({ seed, read: expected });
    }
    expect(planned).toBeGreaterThan(100);
  });
});
