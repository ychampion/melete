/**
 * What one turn of a long chat costs the service, with a scripted engine, so
 * the numbers are the service's own overhead and no model's.
 *
 * A template chat runs a few real turns through the API and the runner: the
 * person's message, the claim that builds the attempt's bundle, the history
 * extension the service runs before the engine starts, three terminal steps
 * (an action row, its proposal and its result; every fifth turn's output is
 * about 120 KB), the reply's words, and the commit. Its rows are then copied
 * into a fresh chat as that chat's history, as many times as the chat length
 * asks for, with new ids and earlier times. That chat then runs a few more
 * real turns, each timed by phase, and the claim's reads are taken apart.
 *
 *   bun apps/melete/test/bench/turn-cost.ts 100 500 1000
 *
 * Embedded Postgres starts on its own; DATABASE_URL points it at another.
 */
import { createHash, randomBytes } from 'node:crypto';
import { agentResponse, conversationResponse, dedupKey, jsonObject } from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { onEventOrderHeld } from '../../src/db/lock-guard.ts';
import { attempt, connection, event, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { assembleHistory } from '../../src/jobs/bundle.ts';
import { extendHistory } from '../../src/jobs/history-extend.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { shareTestServer, testDatabase } from '../helpers/database.ts';

const lengths = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const LENGTHS = lengths.length ? lengths : [100, 500, 1000];
/** Real turns in the template; the copies repeat it. */
const TEMPLATE_TURNS = 5;
/** Real turns timed at each length. */
const MEASURED_TURNS = Number(process.env.TURN_BENCH_MEASURED ?? 5);
const BIG_OUTPUT = 'x'.repeat(120_000);

const stopServer = shareTestServer();
const tested = await testDatabase();
if (!tested) throw new Error('no Postgres for the bench');
const handle = tested;
const queue = await startQueue(handle.url);
const jobs = new JobService(handle.db, queue.boss);
const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
  key: 'turn-cost-bench-signing-key-32-bytes',
});
const app = createApp({
  db: handle.db,
  env: loadEnv({ NODE_ENV: 'test' }),
  jobs,
  runner,
  sql: handle.sql,
  checkDatabase: async () => 'ok',
});
const spaceId = newId('sp');
const ownerId = newId('own');
const connectionId = newId('conn');
const token = randomBytes(32).toString('base64url');
await handle.db.insert(owner).values({ id: ownerId, email: 'bench@example.test' });
await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
await handle.db
  .insert(space)
  .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
await handle.db.insert(session).values({
  tokenHash: createHash('sha256').update(token).digest('hex'),
  ownerId,
  spaceId,
  expiresAt: new Date(Date.now() + 6 * 3600_000),
});
await handle.db
  .insert(connection)
  .values({ id: connectionId, spaceId, provider: 'computer', label: 'Computer' });

// Every hold of the event order lock, by where it was taken.
const holds: { site: string; ms: number }[] = [];
onEventOrderHeld((ms, site) => holds.push({ ms, site }));

async function request(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function newChat(title: string) {
  const persona = agentResponse.parse(
    await (await request('/agents', { method: 'POST', body: JSON.stringify(freshAgent()) })).json(),
  ).agent;
  return conversationResponse.parse(
    await (
      await request('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title, agent_id: persona.id }),
      })
    ).json(),
  ).conversation;
}

/** A history summariser with no model behind it, as on a service with none set up. */
const noSummaries = {
  async summarise() {
    return { ok: false as const, reason: 'failed' as const };
  },
  async close() {},
};

type Phases = {
  send: number;
  claim: number;
  claimLock: number;
  extend: number;
  extendLock: number;
  steps: number;
  commit: number;
  total: number;
  transcript: number;
  leftOut: number;
};

/** One whole turn, as the service runs it, timed by phase. */
async function turn(chatId: string, n: number): Promise<Phases> {
  const t0 = performance.now();
  const sent = await request(`/conversations/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: `Step ${n}: run the three checks and tell me what changed.` }),
    headers: { 'Idempotency-Key': `bench-${randomBytes(6).toString('hex')}` },
  });
  if (sent.status !== 200) throw new Error(`send failed: ${sent.status} ${await sent.text()}`);
  const t1 = performance.now();
  const row = await jobs.get(chatId);
  holds.length = 0;
  const claimed = await runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'input',
  });
  if (!claimed) throw new Error('nothing claimed');
  const claimLock = holds.reduce((sum, hold) => sum + hold.ms, 0);
  const t2 = performance.now();
  holds.length = 0;
  if ((claimed.bundle.earlier?.left_out ?? 0) > 0)
    await extendHistory(
      claimed.bundle,
      { jobs, summariser: noSummaries },
      new AbortController().signal,
    );
  const extendLock = holds.reduce((sum, hold) => sum + hold.ms, 0);
  const t3 = performance.now();
  const { claims } = claimed;
  let local = 0;
  const emit = (body: Record<string, unknown>) =>
    runner.emit(claims, {
      ...body,
      attempt_id: claims.attempt_id,
      local_seq: ++local,
      dedup_key: dedupKey(claims.attempt_id, local),
      at: new Date().toISOString(),
    } as Parameters<AttemptRunner['emit']>[1]);
  for (let step = 0; step < 3; step++) {
    const callId = `call_${randomBytes(8).toString('hex')}`;
    const command = `check-${step} --turn ${n}`;
    const output = step === 0 && n % 5 === 0 ? BIG_OUTPUT : `ok: ${command}\n`;
    await emit({
      type: 'tool_call_proposed',
      tool: 'terminal.run',
      call_id: callId,
      arguments: { command },
    });
    const actionId = newId('act');
    await handle.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, dispatched_at, receipt, resolved_at)
      values (${actionId}, ${chatId}, ${claims.attempt_id}, ${connectionId}, 'terminal.run', 'write_reversible',
        ${JSON.stringify({ command })}::jsonb, ${randomBytes(16).toString('hex')}, 'succeeded', ${actionId},
        now(), ${JSON.stringify({ action_id: actionId, connection_id: connectionId, external_ref: null, detail: { command, exit_code: 0, output } })}::jsonb, now())`;
    await emit({
      type: 'tool_result',
      call_id: callId,
      ok: true,
      result: { action_id: actionId, status: 'succeeded', exit_code: 0, output },
    });
  }
  await emit({ type: 'text_delta', text: `Turn ${n}: all three checks passed. ` });
  await emit({ type: 'text_delta', text: 'Nothing changed since the last run.' });
  const t4 = performance.now();
  await runner.commitOutcome(claims, {
    kind: 'completed',
    summary: `Turn ${n}: all three checks passed. Nothing changed since the last run.`,
    evidence: [],
  });
  const t5 = performance.now();
  return {
    send: t1 - t0,
    claim: t2 - t1,
    claimLock,
    extend: t3 - t2,
    extendLock,
    steps: t4 - t3,
    commit: t5 - t4,
    total: t5 - t0,
    transcript: claimed.bundle.transcript.length,
    leftOut: claimed.bundle.earlier?.left_out ?? 0,
  };
}

/** The job's tables and their rows for one chat: what a template turn wrote. */
async function jobTables(): Promise<string[]> {
  const rows = await handle.sql<
    { table_name: string }[]
  >`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'job_id' order by table_name`;
  return rows.map((entry) => entry.table_name);
}

const ID = /\b([a-z]+)_([0-9A-HJKMNP-TV-Z]{26})\b/g;
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * Copy the template chat's rows into `target` as its history: `copies` times,
 * each copy with ids of its own and times moved back, oldest first, so seq
 * and time agree. Ids that are not the template's own (space, owner, agent,
 * connection) are kept.
 */
async function seedHistory(template: string, target: string, copies: number) {
  const keep = new Set([spaceId, ownerId, connectionId]);
  const [templateJob] = await handle.db.select().from(job).where(eq(job.id, template));
  if (templateJob?.agentId) keep.add(templateJob.agentId);
  const tables = await jobTables();
  // Parents first: attempt before the rows that name an attempt.
  // Only the rows a turn's history is read from; the rest are one per job or bookkeeping.
  const order = ['experience_turn', 'attempt', 'event', 'action'];
  const byTable = new Map<string, Record<string, unknown>[]>();
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const name of order) {
    if (!tables.includes(name) && name !== 'experience_turn') continue;
    const column = name === 'experience_turn' ? await turnJobColumn() : 'job_id';
    if (!column) continue;
    const rows = await handle.sql.unsafe(
      `select row_to_json(t)::text as row from ${name} t where ${column} = $1 ${name === 'event' ? 'order by seq' : ''}`,
      [template],
    );
    const parsed = rows.map((entry) => JSON.parse(entry.row as string) as Record<string, unknown>);
    if (!parsed.length) continue;
    byTable.set(name, parsed);
    for (const value of parsed)
      for (const stamp of JSON.stringify(value).match(STAMP) ?? []) {
        const at = Date.parse(stamp);
        first = Math.min(first, at);
        last = Math.max(last, at);
      }
  }
  const span = last - first + 60_000;
  const [{ max: maxEpoch } = { max: 0 }] = await handle.sql<
    { max: number }[]
  >`select coalesce(max(epoch), 0)::int as max from attempt where job_id = ${template}`;
  const stride = maxEpoch + 1;
  const columns = new Map<string, string[]>();
  for (const name of byTable.keys()) {
    const rows = await handle.sql<
      { column_name: string }[]
    >`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = ${name} order by ordinal_position`;
    columns.set(
      name,
      rows
        .map((entry) => entry.column_name)
        .filter((column) => !(name === 'event' && column === 'seq')),
    );
  }
  for (let copy = 0; copy < copies; copy++) {
    const shift = -(copies - copy) * span - 3_600_000;
    const ids = new Map<string, string>([[template, target]]);
    const remap = (text: string) =>
      text
        .replace(ID, (whole, prefix: string) => {
          if (keep.has(whole)) return whole;
          let next = ids.get(whole);
          if (!next) {
            next = newId(prefix as Parameters<typeof newId>[0]);
            ids.set(whole, next);
          }
          return next;
        })
        .replace(STAMP, (stamp) => new Date(Date.parse(stamp) + shift).toISOString());
    for (const [name, rows] of byTable) {
      const cols = columns.get(name) ?? [];
      const copied = rows.map((value) => {
        const next = JSON.parse(remap(JSON.stringify(value))) as Record<string, unknown>;
        if (name === 'attempt') next.epoch = copy * stride + Number(value.epoch);
        if (name === 'event' && typeof value.epoch === 'number')
          next.epoch = copy * stride + value.epoch;
        if (typeof next.dedup_key === 'string')
          next.dedup_key = `${next.dedup_key}:${target}:${copy}`;
        if (typeof next.idempotency_key === 'string')
          next.idempotency_key = `${next.idempotency_key}:${target}:${copy}`;
        if (typeof next.intent_key === 'string')
          next.intent_key = `${next.intent_key}:${target}:${copy}`;
        if (typeof next.submission_id === 'string')
          next.submission_id = `${next.submission_id}:${target}:${copy}`;
        return next;
      });
      const list = cols.map((column) => `"${column}"`).join(', ');
      for (let start = 0; start < copied.length; start += 200)
        await handle.sql.unsafe(
          `insert into ${name} (${list}) select ${list} from json_populate_recordset(null::${name}, $1::json)`,
          [JSON.stringify(copied.slice(start, start + 200))],
        );
    }
  }
  // The chat's own epoch goes past every copied attempt's.
  await handle.sql`update job set lease_epoch = ${copies * stride + 1} where id = ${target}`;
}

let turnColumn: string | null | undefined;
async function turnJobColumn(): Promise<string | null> {
  if (turnColumn !== undefined) return turnColumn;
  const rows = await handle.sql<
    { column_name: string }[]
  >`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'experience_turn' and column_name in ('job_id', 'conversation_id', 'chat_id')`;
  turnColumn = rows[0]?.column_name ?? null;
  return turnColumn;
}

/** The claim's history read, taken apart: the database, parsing, checking, assembly. */
async function claimReads(chatId: string) {
  const types = ['notice', 'tool_result', 'approval_decided', 'steer_delivered'];
  const timed = async <T>(work: () => Promise<T> | T): Promise<[T, number]> => {
    const start = performance.now();
    const value = await work();
    return [value, performance.now() - start];
  };
  const [[totals]] = await timed(
    () => handle.sql<
      { bytes: number; rows: number }[]
    >`select coalesce(sum(length(payload::text)), 0)::bigint as bytes, count(*)::int as rows
      from event where job_id = ${chatId} and type = any(${types})`,
  );
  const bytes = totals?.bytes ?? 0;
  const rows = totals?.rows ?? 0;
  const [texts, dbText] = await timed(
    () => handle.sql<
      { payload: string }[]
    >`select seq, type, attempt_id, created_at, payload::text as payload
      from event where job_id = ${chatId} and type = any(${types}) order by seq`,
  );
  const [, parse] = await timed(() => texts.map((entry) => JSON.parse(entry.payload)));
  const [events, dbParsed] = await timed(() =>
    handle.db
      .select()
      .from(event)
      .where(eq(event.jobId, chatId))
      .orderBy(asc(event.seq))
      .then((all) => all.filter((entry) => types.includes(entry.type))),
  );
  const [, check] = await timed(() => events.map((entry) => jsonObject.parse(entry.payload)));
  const [attempts, dbAttempts] = await timed(() =>
    handle.db.select().from(attempt).where(eq(attempt.jobId, chatId)),
  );
  const [, assemble] = await timed(() =>
    assembleHistory(
      events,
      attempts.filter((entry) => entry.endedAt),
      Number.MAX_SAFE_INTEGER,
      {},
    ),
  );
  return {
    rows: Number(rows),
    mb: Number(bytes) / 1e6,
    dbText,
    parse,
    dbParsed,
    check,
    dbAttempts,
    assemble,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

try {
  const template = await newChat('Template');
  for (let n = 1; n <= TEMPLATE_TURNS; n++) await turn(template.id, n);
  const census = [];
  for (const name of await jobTables()) {
    const [count] = await handle.sql.unsafe(
      `select count(*)::int as n from ${name} where job_id = $1`,
      [template.id],
    );
    if (Number(count?.n) > 0) census.push(`${name}=${count?.n}`);
  }
  process.stdout.write(`template rows: ${census.join(' ')}\n`);
  const results: Record<string, unknown>[] = [];
  for (const length of LENGTHS) {
    const chat = await newChat(`Long ${length}`);
    const seeding = performance.now();
    await seedHistory(
      template.id,
      chat.id,
      Math.max(0, Math.round((length - MEASURED_TURNS) / TEMPLATE_TURNS)),
    );
    const seeded = performance.now() - seeding;
    const phases: Phases[] = [];
    for (let n = 1; n <= MEASURED_TURNS; n++)
      phases.push(await turn(chat.id, length - MEASURED_TURNS + n));
    const reads = await claimReads(chat.id);
    const summary = Object.fromEntries(
      (Object.keys(phases[0] ?? {}) as (keyof Phases)[]).map((key) => [
        key,
        Math.round(median(phases.map((entry) => entry[key]))),
      ]),
    );
    const line = {
      turns: length,
      seeded_s: Math.round(seeded / 100) / 10,
      ...summary,
      history_rows: reads.rows,
      history_mb: Math.round(reads.mb * 10) / 10,
      read_db_text_ms: Math.round(reads.dbText),
      json_parse_ms: Math.round(reads.parse),
      read_db_parsed_ms: Math.round(reads.dbParsed),
      zod_check_ms: Math.round(reads.check),
      read_attempts_ms: Math.round(reads.dbAttempts),
      assemble_ms: Math.round(reads.assemble),
    };
    results.push(line);
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
  process.stdout.write(`\nRESULTS ${JSON.stringify(results)}\n`);
} finally {
  await queue.stop();
  await handle.close();
  await stopServer();
}
