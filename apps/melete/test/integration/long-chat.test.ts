/**
 * A conversation pushed far past what one attempt is handed.
 *
 * The engine keeps no session between attempts, so each attempt gets the
 * conversation so far, held to a share of the compaction trigger. Here the
 * person's first message carries the facts asked about at the end, and thirty
 * long messages follow it. What no longer fits is summarised once, in order,
 * and the last attempt still has those facts; no message is summarised twice,
 * no attempt is handed more than its room, and between summaries each
 * attempt's conversation starts the way the one before it did.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type {
  AttemptBundle,
  AttemptOutcome,
  CanonicalMessage,
  RuntimeAdapter,
} from '@melete/contracts';
import { renderInput } from '@melete/runtime-hermes';
import { and, eq, sql } from 'drizzle-orm';
import { event, space } from '../../src/db/schema.ts';
import { estimateInputTokens } from '../../src/gateway/metering.ts';
import { newId } from '../../src/ids.ts';
import { transcriptLimits } from '../../src/jobs/bundle.ts';
import { attemptContextBudget } from '../../src/jobs/context-budget.ts';
import { withHistorySummary } from '../../src/jobs/history-extend.ts';
import type { HistoryAnswer, HistorySummariser } from '../../src/jobs/history-gateway.ts';
import { HISTORY_SUMMARY_KIND } from '../../src/jobs/history-summary.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const KEY = 'long-chat-fixture-signing-key-32-bytes';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
const TURNS = 30;
const FACTS = 'The container number is MSCU-7741-ZQ, the pilot is Ines Varga and the tug is teal.';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

/** A scripted summariser: it keeps every line marked FACT and notes each turn it read. */
function scriptedSummariser(refuse = false) {
  const calls: string[] = [];
  const summariser: HistorySummariser = {
    async summarise(_call, input): Promise<HistoryAnswer> {
      calls.push(input.messages);
      if (refuse) return { ok: false, reason: 'kept_private' };
      const facts = [...input.messages.matchAll(/FACT: ([^\n]+)/g)].map((match) => match[1] ?? '');
      const turns = [...input.messages.matchAll(/TURN-(\d+) /g)].map((match) => match[1]);
      return {
        ok: true,
        model: 'fake/fake-scripted-v1',
        summary: {
          ...input.previous,
          facts: [...input.previous.facts, ...facts],
          story: `${input.previous.story} Read turns ${turns.join(', ')}.`.trim(),
        },
      };
    },
    async close() {},
  };
  return { summariser, calls };
}

/** The engine, as far as this test needs one: it keeps what it was handed. */
function capture() {
  const seen: AttemptBundle[] = [];
  const runtime: RuntimeAdapter = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: false, version: 'test' }),
    async start(bundle): Promise<AttemptOutcome> {
      seen.push(bundle);
      return { kind: 'completed', summary: 'unused', evidence: [] };
    },
  };
  return { runtime, seen };
}

async function claim(row: JobRow) {
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
}

const filler = (turn: number) =>
  `TURN-${turn} ${'The shipment notes go on about cranes, berths and weather windows. '.repeat(60)}`;

/** One turn: the person's message, the attempt as the engine would get it, the reply. */
async function turn(wrapped: RuntimeAdapter, row: JobRow, text: string | null): Promise<JobRow> {
  if (text !== null) await required(jobs).input(row.id, text);
  const claimed = await claim(await required(jobs).get(row.id));
  await wrapped.start(claimed.bundle, { emit: async () => {} }, new AbortController().signal);
  await required(runner).commitOutcome(claimed.claims, {
    kind: 'waiting_for_input',
    question: 'Anything else?',
    draft: 'Noted.',
  });
  return required(jobs).get(row.id);
}

async function conversation() {
  const spaceId = newId('sp');
  await required(handle).db.insert(space).values({ id: spaceId, name: 'Long', gitPath: spaceId });
  return required(jobs).create({
    space_id: spaceId,
    title: 'Shipment',
    objective: 'Help the person plan a shipment.',
    // Every turn is an attempt of this one job.
    budget: { max_attempts: 100 },
  });
}

const key = (message: CanonicalMessage) => `${message.at}|${message.content}`;
const summaries = async (jobId: string) =>
  required(handle)
    .db.select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        eq(event.type, 'notice'),
        sql`${event.payload}->>'kind' = ${HISTORY_SUMMARY_KIND}`,
      ),
    );

withDb('a long conversation', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('keeps its first facts through summaries made once each, within the room every turn', async () => {
    const { summariser, calls } = scriptedSummariser();
    const { runtime, seen } = capture();
    const wrapped = withHistorySummary(runtime, {
      jobs: required(jobs),
      summariser,
      chunkTokens: 4000,
    });
    let row = await conversation();
    row = await turn(wrapped, row, null);
    row = await turn(wrapped, row, `FACT: ${FACTS}\n${filler(1)}`);
    for (let index = 2; index <= TURNS; index++) row = await turn(wrapped, row, filler(index));
    row = await turn(
      wrapped,
      row,
      'What was the container number, who was the pilot and what colour was the tug?',
    );

    const room = transcriptLimits(attemptContextBudget('script', {})).maxTokens;
    const last = required(seen.at(-1));
    const input = renderInput(last);
    // The first turn's facts reach the last attempt, through the summary.
    expect(input).toContain('MSCU-7741-ZQ');
    expect(input).toContain('Ines Varga');
    expect(input).toContain('teal');
    expect(input).toContain('## Earlier in this conversation');
    expect(JSON.stringify(last.transcript)).not.toContain('TURN-1 ');
    expect(last.earlier?.left_out).toBe(0);

    // The whole conversation is far past the room, and no attempt was handed more.
    expect(TURNS * estimateInputTokens(filler(1))).toBeGreaterThan(3 * room);
    for (const bundle of seen) {
      const summary = bundle.earlier?.summary ?? '';
      expect(
        estimateInputTokens(JSON.stringify(bundle.transcript)) + estimateInputTokens(summary),
      ).toBeLessThanOrEqual(room);
    }

    // Each message was summarised once, in order, and by far fewer calls than turns.
    const read = calls.flatMap((text) => [...text.matchAll(/TURN-(\d+) /g)].map((m) => m[1]));
    expect(new Set(read).size).toBe(read.length);
    expect(read.map(Number)).toEqual([...read.map(Number)].sort((a, b) => a - b));
    expect(calls.length).toBeLessThan(TURNS / 2);
    const stored = await summaries(row.id);
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.length).toBeLessThan(TURNS / 3);

    // Between summaries, each attempt's conversation starts as the one before it did.
    let steady = 0;
    for (let index = 1; index < seen.length; index++) {
      const before = required(seen[index - 1]);
      const after = required(seen[index]);
      if (before.earlier?.through !== after.earlier?.through) continue;
      steady += 1;
      expect(after.earlier?.summary ?? null).toBe(before.earlier?.summary ?? null);
      const kept = after.transcript.map(key);
      expect(kept.slice(0, before.transcript.length)).toEqual(before.transcript.map(key));
    }
    expect(steady).toBeGreaterThan(TURNS / 2);
  }, 240_000);

  test('when the summary cannot be made, the attempt is told how much it cannot see', async () => {
    const { summariser, calls } = scriptedSummariser(true);
    const { runtime, seen } = capture();
    const wrapped = withHistorySummary(runtime, { jobs: required(jobs), summariser });
    let row = await conversation();
    row = await turn(wrapped, row, null);
    for (let index = 1; index <= 16; index++) row = await turn(wrapped, row, filler(index));
    const last = required(seen.at(-1));
    expect(calls.length).toBeGreaterThan(0);
    expect(await summaries(row.id)).toHaveLength(0);
    expect(last.earlier?.summary).toBeNull();
    expect(last.earlier?.left_out).toBeGreaterThan(0);
    expect(renderInput(last)).toContain(
      `${last.earlier?.left_out} earlier messages are left out for length.`,
    );
  }, 240_000);
});
