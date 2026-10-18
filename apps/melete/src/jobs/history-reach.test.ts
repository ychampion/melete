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
  boundRoomTranscript,
  collectHistory,
  HISTORY_NOTICES,
  outlineHistory,
  resultsInReach,
  type TranscriptLimits,
  usableHistory,
} from './bundle.ts';
import {
  chunkMessages,
  EMPTY_SUMMARY,
  planExtension,
  renderSummary,
  type StoredSummary,
  summaryPayload,
} from './history-summary.ts';
import { PRIVACY_DECISION } from './questions.ts';

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

/**
 * The same, read as the service reads it (`outlineHistory`, with what it asks
 * for filled in), over chats with more in them: steps of older turns still
 * open, call ids used again, attempts fenced, failed, waiting on an approval
 * or made under a context since revoked, messages taken back, sent while a
 * reply was being written or by someone else, files, a privacy question's
 * resume, a stored summary made under a revoked context, notices that are no
 * part of a history, and a room's thread.
 */
const OWNER = 'prn_owner';
const actionId = (n: number) => `act_0${String(n).padStart(25, '0')}`;
const FILE_KINDS = ['text', 'pdf', 'image'] as const;

type RichChat = Chat & {
  generations: { policy_generation: number; connection_generations: Record<string, number> };
  currentAttempts: Set<string>;
  /** Every file the job has, by id: what reading them all would find. */
  files: Map<string, string | null>;
  room: { thread: CanonicalMessage[]; names: Map<string, string> } | null;
};

function richChat(seed: number): RichChat {
  const pick = random(seed);
  const chance = (p: number) => pick.next() < p;
  const events: Event[] = [];
  const attempts: (Attempt & { id: string })[] = [];
  const settledAttempts = new Set<string>();
  const currentAttempts = new Set<string>();
  const files = new Map<string, string | null>();
  const revoked = chance(0.25);
  const generations = { policy_generation: revoked ? 2 : 0, connection_generations: {} };
  const room = chance(0.2);
  let seq = 0;
  let clock = Date.parse('2026-09-11T08:00:00.000Z');
  // Times tie often: at the bound, a message sharing the edge's time is in reach.
  const step = () => {
    clock += chance(0.5) ? 0 : pick.int(1, 2) * 1000;
    return clock;
  };
  const turns = pick.int(1, 60);
  const times: number[] = [];
  let actions = 0;
  let steers = 0;
  for (let turn = 0; turn < turns; turn++) {
    const current = turn === turns - 1;
    // An older turn's steps can stay open: its attempts carry no turn.
    const open = !current && chance(0.04);
    // Before the context was revoked, early turns ran under the old one.
    const madeBefore = revoked && turn < turns / 2;
    const sent = step();
    times.push(sent);
    const attached = chance(0.25)
      ? Array.from({ length: pick.int(1, 2) }, (_, index) => {
          const id = `file_t${turn}x${index}`;
          const kind = FILE_KINDS[pick.int(0, 2)] ?? 'text';
          // Some files were read to no text, some were never stored here.
          if (!chance(0.1))
            files.set(id, chance(0.15) ? null : `File ${id}: ${'f'.repeat(pick.int(1, 900))}`);
          return { id, name: `${id}.txt`, kind, size: pick.int(10, 5000) };
        })
      : [];
    const speaker = room && chance(0.4) ? 'prn_ben' : OWNER;
    const taken = chance(0.04);
    events.push({
      seq: ++seq,
      type: 'notice',
      payload: {
        kind: 'user_message',
        // A message taken back keeps its place with no words.
        ...(taken ? { redacted: true } : { text: `Turn ${turn}: ${'w'.repeat(pick.int(1, 300))}` }),
        principal_id: speaker,
        ...(attached.length ? { attachments: attached } : {}),
      },
      createdAt: new Date(sent),
    });
    // A notice that is no part of any history.
    if (chance(0.2))
      events.push({
        seq: ++seq,
        type: 'notice',
        payload: { kind: 'submission_accepted', note: 'x'.repeat(pick.int(1, 50)) },
        createdAt: new Date(sent),
      });
    const tries = chance(0.25) ? 2 : 1;
    for (let tried = 0; tried < tries; tried++) {
      const attemptId = `att_${turn}_${tried}`;
      if (!current && !open) settledAttempts.add(attemptId);
      if (!madeBefore) currentAttempts.add(attemptId);
      for (let call = pick.int(0, 4); call > 0; call--) {
        const when = step() + pick.int(-1, 1) * 1000;
        times.push(when);
        events.push({
          seq: ++seq,
          type: 'tool_result',
          // Now and then a result with no attempt, as an old record has.
          ...(chance(0.03) ? {} : { attemptId }),
          payload: {
            // Call ids are used again, across turns and across a turn's tries.
            call_id: chance(0.3) ? `call_${call}` : `call_${turn}_${call}`,
            ok: chance(0.9),
            result: { output: 'x'.repeat(pick.int(0, chance(0.2) ? 6_000 : 300)) },
          },
          createdAt: new Date(when),
        });
      }
      const last = tried === tries - 1;
      if (!last) {
        // The try before stopped: fenced, failed, waiting on an approval, or
        // asking the person with a draft of its answer.
        const ended = step();
        times.push(ended);
        const kind = pick.int(0, 3);
        const id = actionId(++actions);
        attempts.push({
          id: attemptId,
          outcome: ['fenced', 'failed', 'waiting_for_approval', 'waiting_for_input'][kind] ?? null,
          outcomeDetail: [
            { kind: 'superseded' },
            { kind: 'failed', reason: 'lost', retryable: true },
            { kind: 'waiting_for_approval', action_ids: [id] },
            { kind: 'waiting_for_input', question: 'Which one?', draft: `Draft ${turn}` },
          ][kind],
          startedAt: new Date(ended),
          endedAt: new Date(ended),
        });
        if (kind === 2)
          events.push({
            seq: ++seq,
            type: 'approval_decided',
            attemptId,
            payload: { action_id: id, decision: chance(0.7) ? 'approved' : 'denied', note: null },
            createdAt: new Date(step()),
          });
        // Words the person sent while it ran, which it already read.
        if (chance(0.3)) {
          const steerId = `steer_${++steers}`;
          const at = step();
          events.push({
            seq: ++seq,
            type: 'notice',
            payload: {
              kind: 'user_message',
              text: `Also ${turn}`,
              principal_id: OWNER,
              steer: true,
              steer_id: steerId,
            },
            createdAt: new Date(at),
          });
          events.push({
            seq: ++seq,
            type: 'steer_delivered',
            attemptId,
            payload: { steer_id: steerId },
            createdAt: new Date(at),
          });
        }
      } else if (!current || chance(0.2)) {
        const ended = step();
        times.push(ended);
        attempts.push({
          id: attemptId,
          ...(chance(0.1)
            ? {
                outcome: 'failed',
                outcomeDetail: { kind: 'failed', reason: 'lost', retryable: false },
              }
            : {
                outcome: 'completed',
                outcomeDetail: {
                  kind: 'completed',
                  summary: `Answer ${turn}: ${'a'.repeat(pick.int(1, 600))}`,
                  evidence: [],
                },
              }),
          startedAt: new Date(ended),
          endedAt: new Date(ended),
        });
      }
    }
    // A message sent while the reply was still being written is older than it.
    if (!current && chance(0.05)) {
      events.push({
        seq: ++seq,
        type: 'notice',
        payload: { kind: 'user_message', text: `Meanwhile ${turn}`, principal_id: OWNER },
        createdAt: new Date(clock - 1000),
      });
    }
  }
  const afterSeq = Math.max(0, seq - pick.int(1, 4));
  // A privacy question's answer resumes the turn it held back.
  if (chance(0.15))
    events.push({
      seq: ++seq,
      type: 'notice',
      // Sometimes from far back, so a message new to the attempt is older than ones it is not.
      payload: {
        kind: PRIVACY_DECISION,
        resume_after: Math.max(0, afterSeq - pick.int(1, chance(0.5) ? 60 : 6)),
      },
      createdAt: new Date(clock),
    });
  if (chance(0.15))
    events.push({
      seq: ++seq,
      type: 'notice',
      payload: {
        kind: 'trigger_event',
        event: { kind: 'timer', at: new Date(clock).toISOString() },
      },
      createdAt: new Date(clock),
    });
  if (chance(0.45) && times.length > 2) {
    const through = times[pick.int(0, times.length - 2)] ?? clock;
    const stored: StoredSummary = {
      through: new Date(through).toISOString(),
      summary: { ...EMPTY_SUMMARY, facts: ['The person writes letters.'] },
      messages: 3,
      // A summary made under a revoked context is not read.
      generations: revoked && chance(0.3) ? { ...generations, policy_generation: 0 } : generations,
    };
    events.push({
      seq: ++seq,
      type: 'notice',
      payload: summaryPayload(stored),
      createdAt: new Date(clock),
    });
  }
  const thread: CanonicalMessage[] = room
    ? times
        .filter(() => chance(0.3))
        .map((at, index) =>
          index % 2
            ? {
                role: 'assistant' as const,
                content: `Elsewhere ${index}`,
                at: new Date(at).toISOString(),
              }
            : {
                role: 'user' as const,
                name: 'Cy',
                content: `Thread ${index}`,
                at: new Date(at).toISOString(),
              },
        )
        .sort((a, b) => a.at.localeCompare(b.at))
    : [];
  attempts.sort((left, right) => (right.endedAt?.getTime() ?? 0) - (left.endedAt?.getTime() ?? 0));
  return {
    events,
    attempts: attempts.filter((entry) => currentAttempts.has(entry.id)),
    settledAttempts,
    currentAttempts,
    generations,
    files,
    afterSeq,
    room: room
      ? {
          thread,
          names: new Map([
            [OWNER, 'Ada'],
            ['prn_ben', 'Ben'],
          ]),
        }
      : null,
    limits: {
      maxMessages: pick.int(2, 40),
      maxTokens: pick.int(200, 30_000),
      maxBytes: pick.int(2_000, 400_000),
    },
  };
}

/** Every event a history is made of, read whole, as the service read it before. */
function wholeRead(conversation: RichChat, afterSeq: number, speakers: { principal?: string }) {
  return collectHistory(
    usableHistory(conversation.events, conversation.generations, conversation.currentAttempts),
    conversation.attempts,
    afterSeq,
    {
      ...(conversation.room ? { names: conversation.room.names } : speakers),
      fileTexts: conversation.files,
      settledAttempts: conversation.settledAttempts,
    },
  );
}

/** The read as `historyRows` makes it, with `results` and `files` read from the record. */
function readAsService(
  conversation: RichChat,
  reach: Parameters<typeof outlineHistory>[3],
  speakers: { principal?: string },
) {
  const outline = conversation.events
    .filter(
      (entry) =>
        entry.type !== 'notice' ||
        HISTORY_NOTICES.includes(String((entry.payload as { kind?: unknown }).kind)),
    )
    .filter((entry) => reach.upTo === undefined || entry.seq <= reach.upTo)
    .map((entry) => (entry.type === 'tool_result' ? { ...entry, payload: null } : entry));
  const read = outlineHistory(
    outline,
    conversation.attempts,
    {
      generations: conversation.generations,
      currentAttempts: conversation.currentAttempts,
      settledAttempts: conversation.settledAttempts,
    },
    reach,
    conversation.room ? { names: conversation.room.names } : speakers,
  );
  const wanted = new Set(read.results);
  const bodies = new Map(
    conversation.events
      .filter((entry) => entry.type === 'tool_result' && wanted.has(entry.seq))
      .map((entry) => [entry.seq, entry.payload]),
  );
  const asked = new Set(read.files);
  read.fill(bodies, new Map([...conversation.files].filter(([id]) => asked.has(id))));
  const results = conversation.events.filter((entry) => entry.type === 'tool_result').length;
  return { history: read.history, unread: results - wanted.size, filesRead: asked.size };
}

describe("what sits at the edge of a long chat's bound is read whole", () => {
  const at = (second: number) => new Date(Date.parse('2026-09-11T08:00:00.000Z') + second * 1000);
  const said = (seq: number, second: number, text: string, extra = {}): Event => ({
    seq,
    type: 'notice',
    payload: { kind: 'user_message', text, principal_id: OWNER, ...extra },
    createdAt: at(second),
  });
  const hand = (
    events: Event[],
    attempts: (Attempt & { id: string })[],
    afterSeq: number,
    files: [string, string][] = [],
  ): RichChat => ({
    events,
    attempts,
    settledAttempts: new Set(['att_0', 'att_1']),
    currentAttempts: new Set(['att_0', 'att_1']),
    generations: GENERATIONS,
    files: new Map(files),
    room: null,
    afterSeq,
    limits: { maxMessages: 2, maxTokens: 30_000, maxBytes: 400_000 },
  });
  const both = (conversation: RichChat) => {
    const bound = (history: ReturnType<typeof wholeRead>) =>
      boundHistory(
        history.full,
        history.inputs.new_user_messages,
        history.stored,
        conversation.limits,
        history.settled,
      );
    return {
      read: bound(
        readAsService(
          conversation,
          { afterSeq: conversation.afterSeq, maxMessages: conversation.limits.maxMessages },
          {},
        ).history,
      ),
      whole: bound(wholeRead(conversation, conversation.afterSeq, {})),
    };
  };

  test("a message sharing the edge's time keeps its files", () => {
    // Nothing new and no step open: the bound picks the two newest, and the
    // older of them shares its time with the answer after it.
    const file = { id: 'file_edge', name: 'notes.txt', kind: 'text', size: 10 };
    const { read, whole } = both(
      hand(
        [said(1, 0, 'First'), said(2, 5, 'Second', { attachments: [file] })],
        [
          {
            id: 'att_1',
            outcome: 'completed',
            outcomeDetail: { kind: 'completed', summary: 'Done', evidence: [] },
            startedAt: at(5),
            endedAt: at(5),
          },
        ],
        2,
        [['file_edge', 'The notes, whole.']],
      ),
    );
    expect(JSON.stringify(whole.transcript)).toContain('The notes, whole.');
    expect(read).toEqual(whole);
  });

  test('an output kept when the new messages fill the bound', () => {
    // Two new messages and a bound of two: the one earlier message left room
    // for is the newest that is not new, the step's output.
    const { read, whole } = both(
      hand(
        [
          said(1, 0, 'First'),
          {
            seq: 2,
            type: 'tool_result',
            attemptId: 'att_0',
            payload: { call_id: 'call_1', ok: true, result: { output: 'The output, whole.' } },
            createdAt: at(1),
          },
          said(3, 2, 'Second'),
          said(4, 3, 'Third'),
        ],
        [],
        2,
      ),
    );
    expect(JSON.stringify(whole.transcript)).toContain('The output, whole.');
    expect(read).toEqual(whole);
  });
});

describe("a long chat's history read as the service reads it", () => {
  const SEEDS = 600;

  test('hands every attempt, in a conversation or a room, what reading everything would', () => {
    let unread = 0;
    let rooms = 0;
    let revoked = 0;
    let filesLeft = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const conversation = richChat(seed);
      const reference = wholeRead(conversation, conversation.afterSeq, {});
      const read = readAsService(
        conversation,
        { afterSeq: conversation.afterSeq, maxMessages: conversation.limits.maxMessages },
        {},
      );
      unread += read.unread;
      filesLeft += conversation.files.size - read.filesRead;
      if (conversation.room) rooms++;
      if (conversation.generations.policy_generation) revoked++;
      const bound = (history: typeof reference) =>
        bounded(() => {
          const result = boundHistory(
            history.full,
            history.inputs.new_user_messages,
            history.stored,
            conversation.limits,
            history.settled,
          );
          return conversation.room
            ? {
                transcript: boundRoomTranscript(conversation.room.thread, {
                  ...history,
                  transcript: result.transcript,
                }),
              }
            : result;
        });
      expect({ seed, bundle: bound(read.history), inputs: read.history.inputs }).toEqual({
        seed,
        bundle: bound(reference),
        inputs: reference.inputs,
      });
      expect({ seed, progress: read.history.progressSummary }).toEqual({
        seed,
        progress: reference.progressSummary,
      });
    }
    // The cases worth having are all there.
    expect(unread).toBeGreaterThan(1_000);
    expect(filesLeft).toBeGreaterThan(50);
    expect(rooms).toBeGreaterThan(60);
    expect(revoked).toBeGreaterThan(80);
  }, 60_000);

  test("extends the summary over what reading everything would, in the person's words", () => {
    let planned = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const conversation = richChat(seed);
      // A room's request is never summarised.
      if (conversation.room) continue;
      const claimed = wholeRead(conversation, conversation.afterSeq, {});
      const fresh = claimed.inputs.new_user_messages;
      // The extension reads only what the claim saw, so nothing in it is new.
      const last = Math.max(...conversation.events.map((entry) => entry.seq));
      const freshFrom = Math.min(...fresh.map((message) => Date.parse(message.at)));
      const reference = wholeRead(conversation, last, { principal: OWNER });
      const { history } = readAsService(
        conversation,
        {
          upTo: last,
          afterSeq: last,
          maxMessages: conversation.limits.maxMessages + fresh.length,
          summarising: { freshFrom },
        },
        { principal: OWNER },
      );
      const key = (message: CanonicalMessage) => `${message.at}\u0000${message.content}`;
      const freshKeys = new Set(fresh.map(key));
      const found = (full: readonly CanonicalMessage[]) =>
        full.filter((message) => message.role === 'user' && freshKeys.has(key(message)));
      const planOf = (read: typeof reference) => {
        const plan = extension(
          read.full,
          found(read.full),
          read.stored,
          read.settled,
          conversation.limits,
        );
        return plan && { ...plan, chunks: chunkMessages(plan.said, 400, read.personWords) };
      };
      const expected = planOf(reference);
      if (expected) planned++;
      expect({ seed, fresh: found(history.full).length, plan: planOf(history) }).toEqual({
        seed,
        fresh: found(reference.full).length,
        plan: expected,
      });
    }
    expect(planned).toBeGreaterThan(80);
  }, 60_000);
});
