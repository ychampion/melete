import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { CellResult } from './types.ts';

export const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
export const PRICE = { input: 0.22, cached: 0.007, output: 0.66 };
export const PRICE_SOURCE = 'https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export class BudgetExceeded extends Error {}
export class State {
  readonly db: Database;
  cell = 'preflight';
  constructor(
    path: string,
    readonly limit: number,
  ) {
    if (!Number.isFinite(limit) || limit <= 0 || limit > 50)
      throw new Error('Budget must be greater than zero and at most $50');
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, cell TEXT NOT NULL, role TEXT NOT NULL,
        reserved REAL NOT NULL, settled REAL, request_hash TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, response_model TEXT,
        status INTEGER, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS cells (key TEXT PRIMARY KEY, space_id TEXT, job_id TEXT,
        phase TEXT NOT NULL DEFAULT 'new', data TEXT NOT NULL DEFAULT '{}', result TEXT);
    `);
  }
  pin(key: string, value: string) {
    const found = this.db
      .query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key=?')
      .get(key);
    if (found && found.value !== value)
      throw new Error(`Resume metadata mismatch: ${key}; use a new campaign`);
    this.db.query('INSERT OR IGNORE INTO metadata VALUES (?,?)').run(key, value);
  }
  used() {
    return (
      this.db
        .query<{ used: number }, []>(
          'SELECT coalesce(sum(coalesce(settled,reserved)),0) AS used FROM calls',
        )
        .get()?.used ?? 0
    );
  }
  requestTime(now = Date.now(), delay = 0): number {
    return this.db
      .transaction(() => {
        const key = 'paid-request-next-at';
        const previous = this.db
          .query<{ value: string }, [string]>('SELECT value FROM metadata WHERE key=?')
          .get(key);
        const start = Math.max(now + delay, Number(previous?.value ?? 0));
        // Shared by agent and rubric calls, including after a process restart.
        this.db
          .query(
            'INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(key, String(start + 7000));
        return start;
      })
      .immediate();
  }
  reserve(body: Record<string, unknown>, role: string) {
    if (body.model !== MODEL)
      throw new Error(
        'Unpriced model refused: this campaign only prices the requested Fireworks model',
      );
    if (body.n !== undefined && body.n !== 1) throw new Error('Multiple completions refused');
    const max = Number(body.max_tokens ?? body.max_completion_tokens);
    if (!Number.isSafeInteger(max) || max < 1 || max > 8192)
      throw new Error('Unbounded completion refused');
    const input = Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096;
    const reserved = (input * PRICE.input + max * PRICE.output) / 1e6;
    const id = randomUUID();
    this.db
      .transaction(() => {
        if (this.used() + reserved > this.limit)
          throw new BudgetExceeded('Campaign spend cap reached');
        this.db
          .query('INSERT INTO calls(id,cell,role,reserved,request_hash,model) VALUES (?,?,?,?,?,?)')
          .run(id, this.cell, role, reserved, sha256(JSON.stringify(body)), MODEL);
      })
      .immediate();
    return id;
  }
  settle(id: string, status: number, text: string) {
    let usage: Record<string, unknown> | null = null;
    let model: string | null = null;
    const streamed = text.startsWith('data:') || text.includes('\ndata:');
    const chunks = streamed
      ? text
          .split('\n')
          .filter((s) => s.startsWith('data:'))
          .map((s) => s.slice(5).trim())
      : [text];
    for (const chunk of chunks) {
      try {
        const value = JSON.parse(chunk);
        if (typeof value.model === 'string') model = value.model;
        if (value.usage) usage = value.usage;
      } catch {
        /* SSE terminal marker or an incomplete frame: keep the reservation. */
      }
    }
    const input = usage?.prompt_tokens;
    const output = usage?.completion_tokens;
    const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
    const cached = details?.cached_tokens ?? 0;
    // A truncated stream can contain intermediate usage. Only the terminal marker
    // proves that the final invoice was received; otherwise keep the reservation.
    const complete = !streamed || chunks.at(-1) === '[DONE]';
    const valid =
      complete &&
      typeof input === 'number' &&
      typeof output === 'number' &&
      typeof cached === 'number' &&
      [input, output, cached].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      cached <= input;
    const cost = valid
      ? ((input - cached) * PRICE.input + cached * PRICE.cached + output * PRICE.output) / 1e6
      : null;
    this.db
      .query(
        'UPDATE calls SET settled=?,input_tokens=?,cached_tokens=?,output_tokens=?,response_model=?,status=? WHERE id=?',
      )
      .run(
        cost,
        valid ? input : null,
        valid ? cached : null,
        valid ? output : null,
        model,
        status,
        id,
      );
  }
  cost(cell: string) {
    return (
      this.db
        .query<{ cost: number; uncertain: number }, [string]>(
          'SELECT coalesce(sum(coalesce(settled,reserved)),0) AS cost, count(*) FILTER(WHERE settled IS NULL) AS uncertain FROM calls WHERE cell=?',
        )
        .get(cell) ?? { cost: 0, uncertain: 0 }
    );
  }
  get(key: string) {
    this.db.query('INSERT OR IGNORE INTO cells(key) VALUES (?)').run(key);
    const row = this.db
      .query<
        {
          key: string;
          space_id: string | null;
          job_id: string | null;
          phase: string;
          data: string;
          result: string | null;
        },
        [string]
      >('SELECT * FROM cells WHERE key=?')
      .get(key);
    if (!row) throw new Error('Cell journal missing');
    return {
      ...row,
      data: JSON.parse(row.data) as Record<string, unknown>,
      result: row.result ? (JSON.parse(row.result) as CellResult) : null,
    };
  }
  update(key: string, phase: string, data: Record<string, unknown>) {
    this.db
      .query('UPDATE cells SET phase=?, data=? WHERE key=?')
      .run(phase, JSON.stringify(data), key);
  }
  identities(key: string, spaceId: string, jobId?: string) {
    this.db
      .query('UPDATE cells SET space_id=?,job_id=coalesce(?,job_id) WHERE key=?')
      .run(spaceId, jobId ?? null, key);
  }
  finish(key: string, result: CellResult) {
    this.db
      .query("UPDATE cells SET phase='finished',result=? WHERE key=?")
      .run(JSON.stringify(result), key);
  }
  results(prefix = ''): CellResult[] {
    return this.db
      .query<{ result: string }, [string]>(
        'SELECT result FROM cells WHERE result IS NOT NULL AND substr(key,1,length(?1))=?1 ORDER BY key',
      )
      .all(prefix)
      .map((r) => JSON.parse(r.result));
  }
  close() {
    this.db.close();
  }
}
