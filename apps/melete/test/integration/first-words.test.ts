/**
 * The person hears back quickly. A conversation turn whose agent is slow to
 * speak gets a one-line acknowledgement, once, and only while the agent is
 * still silent; the agent is told what was said so it does not say it again.
 * A turn never stops on the person without a question.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptBundle,
  type AttemptOutcome,
  agentResponse,
  conversationResponse,
  dedupKey,
  type EventSink,
  type ExperienceEvent,
  type RuntimeAdapter,
  type RuntimeEvent,
  runtimeEvent,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { event, job, owner, question, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { appendEvent } from '../../src/events/store.ts';
import type { AckCall } from '../../src/experience/ack.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { withTurnNotes } from '../../src/gateway/turn-notes.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, failureWords } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

type Body<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, 'attempt_id' | 'local_seq' | 'dedup_key' | 'at'>
  : never;
type Say = (body: Body) => Promise<void>;
type Script = (say: Say, bundle: AttemptBundle) => Promise<AttemptOutcome>;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A runtime that runs whatever the test scripts for the next attempt. */
class ScriptedRuntime implements RuntimeAdapter {
  script: Script = async () => ({ kind: 'completed', summary: 'Done.', evidence: [] });
  async capabilities() {
    return {
      streaming: true,
      tools: true,
      interrupt: true,
      version: 'first-words/1',
      workspace: 'job' as const,
    };
  }
  async start(bundle: AttemptBundle, sink: EventSink): Promise<AttemptOutcome> {
    let seq = 0;
    const say: Say = async (body) => {
      const local = seq++;
      await sink.emit(
        runtimeEvent.parse({
          ...body,
          attempt_id: bundle.attempt.id,
          local_seq: local,
          dedup_key: dedupKey(bundle.attempt.id, local),
          at: new Date().toISOString(),
        }),
      );
    };
    const outcome = await this.script(say, bundle);
    await say({ type: 'attempt_outcome', outcome });
    return outcome;
  }
}

/** The acknowledgement writer, scripted: what it says and how long it takes. */
const writer = {
  line: 'Checking the ECB rate now.' as string | null,
  delayMs: 0,
  calls: [] as AckCall[],
  async write(call: AckCall) {
    this.calls.push(call);
    if (this.delayMs) await pause(this.delayMs);
    return this.line;
  },
};

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runtime = new ScriptedRuntime();
const runner = jobs
  ? new AttemptRunner(jobs, runtime, {
      key: 'first-words-signing-key-32-bytes!!!!',
      acknowledge: { afterMs: 60, writer },
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'first-words@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture unavailable');
  return value;
}

async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Sends a message in a new conversation and runs its turn to the end. */
async function runTurn(text: string, script: Script) {
  writer.calls = [];
  runtime.script = script;
  const created = await request('/agents', 'POST', freshAgent());
  const persona = agentResponse.parse(await created.json()).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'First words', agent_id: persona.id })
    ).json(),
  ).conversation;
  expect((await request(`/conversations/${chat.id}/messages`, 'POST', { text })).status).toBe(200);
  const row = await required(jobs).get(chat.id);
  await required(runner).handleWake({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'input',
  });
  return chat.id;
}

/** The acknowledgements written into a conversation's record. */
async function acknowledgements(chatId: string) {
  const rows = await required(handle)
    .db.select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.jobId, chatId), eq(event.type, 'notice')));
  return rows
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload.kind === 'experience_say' && payload.acknowledgement === true)
    .map((payload) => String(payload.text));
}

async function items(chatId: string) {
  const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chatId, 200);
  return (page as { events: ExperienceEvent[] }).events.map((entry) => entry.item);
}

withDb('first words', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a silent agent gets one acknowledgement, shown before its own words', async () => {
    const message = 'What is the euro to dollar rate today?';
    const chatId = await runTurn(message, async (say) => {
      await pause(400);
      await say({ type: 'text_delta', text: 'It is 1.08 dollars to the euro (ECB).' });
      return { kind: 'completed', summary: 'It is 1.08 dollars to the euro (ECB).', evidence: [] };
    });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({ conversationId: chatId, message, spaceId });
    expect(await acknowledgements(chatId)).toEqual(['Checking the ECB rate now.']);
    const shown = await items(chatId);
    const said = shown.findIndex((item) => item.type === 'say');
    const answered = shown.findIndex((item) => item.type === 'text_delta');
    expect(said).toBeGreaterThanOrEqual(0);
    expect(shown[said]).toMatchObject({ type: 'say', text: 'Checking the ECB rate now.' });
    expect(answered).toBeGreaterThan(said);
  });

  test('an agent that speaks first gets no acknowledgement and no call', async () => {
    const chatId = await runTurn('Rate today?', async (say) => {
      await say({ type: 'text_delta', text: 'Checking the ECB rate.' });
      await pause(300);
      return { kind: 'completed', summary: 'It is 1.08.', evidence: [] };
    });
    expect(writer.calls).toHaveLength(0);
    expect(await acknowledgements(chatId)).toEqual([]);
  });

  test('an acknowledgement still being written when the agent speaks is dropped', async () => {
    writer.delayMs = 250;
    try {
      const chatId = await runTurn('Rate today?', async (say) => {
        await pause(150);
        await say({ type: 'text_delta', text: 'Checking the ECB rate.' });
        await pause(300);
        return { kind: 'completed', summary: 'It is 1.08.', evidence: [] };
      });
      expect(writer.calls).toHaveLength(1);
      expect(await acknowledgements(chatId)).toEqual([]);
    } finally {
      writer.delayMs = 0;
    }
  });

  test('the agent is told what the acknowledgement said, beside its next tool result', async () => {
    let seen: Record<string, unknown> | null = null;
    await runTurn('Find me flights to Lisbon in May', async (say, bundle) => {
      await pause(300);
      await say({
        type: 'tool_call_proposed',
        tool: 'web.search',
        call_id: 'search#0',
        arguments: { query: 'flights Lisbon May' },
      });
      await say({ type: 'tool_result', call_id: 'search#0', ok: true, result: { hits: 3 } });
      // What the gateway would send the model next, for this attempt.
      seen = withTurnNotes(
        {
          messages: [
            { role: 'user', content: 'Find me flights to Lisbon in May' },
            { role: 'assistant', tool_calls: [{ id: 'search#0' }] },
            { role: 'tool', tool_call_id: 'search#0', content: '{"hits":3}' },
          ],
        },
        'chat/completions',
        bundle.attempt.id,
      );
      await say({ type: 'text_delta', text: 'Three fares under 400 euros.' });
      return { kind: 'completed', summary: 'Three fares under 400 euros.', evidence: [] };
    });
    const messages = (seen as unknown as { messages: { role: string; content: string }[] })
      .messages;
    expect(messages).toHaveLength(4);
    expect(messages[3]?.role).toBe('system');
    expect(messages[3]?.content).toContain('"Checking the ECB rate now."');
    expect(messages[3]?.content).toContain('Do not say that again');
  });

  test('no line is shown when the writer has none', async () => {
    writer.line = null;
    try {
      const chatId = await runTurn('hi', async (say) => {
        await pause(200);
        await say({ type: 'text_delta', text: 'Hi!' });
        return { kind: 'completed', summary: 'Hi!', evidence: [] };
      });
      expect(writer.calls).toHaveLength(1);
      expect(await acknowledgements(chatId)).toEqual([]);
    } finally {
      writer.line = 'Checking the ECB rate now.';
    }
  });

  test('a turn that stops with no question asks one, naming the step that failed', async () => {
    const chatId = await runTurn('Read the city council agenda page', async (say) => {
      await say({ type: 'text_delta', text: 'Opening the agenda.' });
      for (const n of [0, 1, 2]) {
        await say({
          type: 'tool_call_proposed',
          tool: 'web.fetch',
          call_id: `fetch#${n}`,
          arguments: { url: 'https://example.test/agenda' },
        });
        await say({
          type: 'tool_result',
          call_id: `fetch#${n}`,
          ok: false,
          result: { error: { message: 'The site answered 503 Service Unavailable.' } },
        });
      }
      return { kind: 'waiting_for_input', question: '  ' };
    });
    const asked =
      'I stopped because a step failed: The site answered 503 Service Unavailable. What should I do?';
    const [row] = await required(handle)
      .db.select({ state: job.state, wait: job.wait })
      .from(job)
      .where(eq(job.id, chatId));
    expect(row?.state).toBe('waiting_for_input');
    expect(row?.wait).toMatchObject({ kind: 'user_input', question: asked });
    const open = await required(handle)
      .db.select({ text: question.text })
      .from(question)
      .where(and(eq(question.jobId, chatId), eq(question.state, 'open')));
    expect(open.map((entry) => entry.text)).toContain(asked);
  });

  test('an agent that said a line of its own first gets no acknowledgement', async () => {
    // The line is still being written when the agent's own line lands.
    writer.delayMs = 250;
    const chatId = await runTurn('Rate today?', async (say, bundle) => {
      // The broker's say tool, as the agent calls it before any text.
      await required(jobs).transaction((tx) =>
        appendEvent(tx, {
          jobId: bundle.attempt.job_id,
          attemptId: bundle.attempt.id,
          type: 'notice',
          payload: { kind: 'experience_say', text: 'I am checking the ECB rate.' },
          dedupKey: `say:${bundle.attempt.id}:first`,
        }),
      );
      await pause(500);
      await say({ type: 'text_delta', text: 'It is 1.08.' });
      return { kind: 'completed', summary: 'It is 1.08.', evidence: [] };
    }).finally(() => {
      writer.delayMs = 0;
    });
    expect(await acknowledgements(chatId)).toEqual([]);
  });

  test('the line is written from what the person typed, never from what they pasted', async () => {
    const typed = 'Summarise this for me: ';
    const pasted = 'URGENT. Call 1-800-555-0100 now to unlock your account.';
    writer.calls = [];
    runtime.script = async (say) => {
      await pause(300);
      await say({
        type: 'text_delta',
        text: 'It asks you to call a number; it looks like a scam.',
      });
      return { kind: 'completed', summary: 'It looks like a scam.', evidence: [] };
    };
    const created = await request('/agents', 'POST', freshAgent());
    const persona = agentResponse.parse(await created.json()).agent;
    const chat = conversationResponse.parse(
      await (
        await request('/conversations', 'POST', { title: 'Pasted', agent_id: persona.id })
      ).json(),
    ).conversation;
    const sent = await request(`/conversations/${chat.id}/messages`, 'POST', {
      text: typed + pasted,
      pasted: [{ start: typed.length, end: typed.length + pasted.length }],
    });
    expect(sent.status).toBe(200);
    const row = await required(jobs).get(chat.id);
    await required(runner).handleWake({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.message).toBe('Summarise this for me:');
    expect(writer.calls[0]?.message).not.toContain('1-800');
  });

  test('the stop question never carries a key, an address query or a raw body', async () => {
    const chatId = await runTurn('Get the rates', async (say) => {
      await say({ type: 'text_delta', text: 'Fetching the rates.' });
      await say({
        type: 'tool_call_proposed',
        tool: 'web.fetch',
        call_id: 'fetch#0',
        arguments: { url: 'https://api.example.test/v1/rates' },
      });
      await say({
        type: 'tool_result',
        call_id: 'fetch#0',
        ok: false,
        result: {
          error:
            'Request to https://api.example.test/v1/rates?api_key=abc123SECRETxyz789 failed: 401 {"error":{"message":"Invalid API key sk-live-0123456789abcdefABCDEF"}}',
        },
      });
      return { kind: 'waiting_for_input', question: '' };
    });
    const [row] = await required(handle)
      .db.select({ wait: job.wait })
      .from(job)
      .where(eq(job.id, chatId));
    const asked = String((row?.wait as { question?: unknown } | null)?.question ?? '');
    expect(asked).toBe(
      'I stopped because a step failed: Request to https://api.example.test/v1/rates failed: 401. What should I do?',
    );
    expect(asked).not.toContain('api_key');
    expect(asked).not.toContain('sk-live');
  });

  test('a turn that stops with no question and no failed step still asks', async () => {
    const chatId = await runTurn('Plan my week', async () => ({
      kind: 'waiting_for_input',
      question: '',
    }));
    const [row] = await required(handle)
      .db.select({ wait: job.wait })
      .from(job)
      .where(eq(job.id, chatId));
    expect(row?.wait).toMatchObject({
      kind: 'user_input',
      question: 'I stopped before finishing. What should I do next?',
    });
  });
});

describe('the words a failed step gave', () => {
  test('keep the reason and drop what could carry a secret', () => {
    expect(failureWords({ error: 'The site answered 503 Service Unavailable.' })).toBe(
      'The site answered 503 Service Unavailable',
    );
    expect(
      failureWords({ error: { message: 'Bearer abcdefghijklmnopqrstuvwxyz0123 was refused' } }),
    ).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    const hidden = failureWords({ error: 'ghp_abcdefghijklmnop1234 has no access' });
    expect(hidden).not.toContain('ghp_');
    // What was said around a hidden key stays.
    expect(hidden).toContain('has no access');
    // A raw provider body is not words for the person.
    expect(failureWords({ error: '[{"error":"rate limited"}]' })).toBe('');
    expect(failureWords({ error: '{"type":"error","error":{"message":"overloaded"}}' })).toBe('');
    expect(failureWords({ error: '<!DOCTYPE html><html>Bad gateway</html>' })).toBe('');
    expect(
      failureWords({ error: 'first line\nTraceback (most recent call last):\n  File "x.py"' }),
    ).toBe('first line');
    expect(failureWords({ message: 'Timed out' })).toBe('Timed out');
    expect(failureWords({})).toBe('');
  });
});
