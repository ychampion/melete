import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { CellResult } from './types.ts';

export const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
export type Price = {
  input: number;
  cached: number;
  output: number;
  source: string;
  checked_on: string;
};
/**
 * Fireworks serverless prices per million tokens. Only a model listed here can
 * be spent on: a request for any other is refused before it leaves.
 */
export const PRICES: Record<string, Price> = {
  [MODEL]: {
    input: 0.22,
    cached: 0.007,
    output: 0.66,
    source: 'https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash',
    checked_on: '2026-09-12',
  },
  'accounts/fireworks/models/kimi-k3': {
    input: 3,
    cached: 0.3,
    output: 15,
    source: 'https://fireworks.ai/models/fireworks/kimi-k3',
    checked_on: '2026-10-03',
  },
  'accounts/fireworks/models/qwen3p8-max': {
    input: 2,
    cached: 0.25,
    output: 6,
    source: 'https://fireworks.ai/models/fireworks/qwen3p8-max',
    checked_on: '2026-10-03',
  },
};
const DEFAULT_PRICE = PRICES[MODEL] as Price;
export const PRICE = {
  input: DEFAULT_PRICE.input,
  cached: DEFAULT_PRICE.cached,
  output: DEFAULT_PRICE.output,
};
export const PRICE_SOURCE = DEFAULT_PRICE.source;
export const priceOf = (model: string): Price | undefined =>
  Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export class BudgetExceeded extends Error {}
export class State {
  readonly db: Database;
  cell = 'preflight';
  /** The models this campaign may spend on: the agent's and the grader's. */
  readonly models: ReadonlySet<string>;
  constructor(
    path: string,
    readonly limit: number,
    models: readonly string[] = [MODEL],
  ) {
    for (const model of models) if (!priceOf(model)) throw new Error(`Unpriced model: ${model}`);
    this.models = new Set(models);
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
    const model = String(body.model);
    const price = priceOf(model);
    if (!price || !this.models.has(model))
      throw new Error('Unpriced model refused: this campaign only prices its requested models');
    if (body.n !== undefined && body.n !== 1) throw new Error('Multiple completions refused');
    const max = Number(body.max_tokens ?? body.max_completion_tokens);
    if (!Number.isSafeInteger(max) || max < 1 || max > 8192)
      throw new Error('Unbounded completion refused');
    const input = Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096;
    const reserved = (input * price.input + max * price.output) / 1e6;
    const id = randomUUID();
    this.db
      .transaction(() => {
        if (this.used() + reserved > this.limit)
          throw new BudgetExceeded('Campaign spend cap reached');
        this.db
          .query('INSERT INTO calls(id,cell,role,reserved,request_hash,model) VALUES (?,?,?,?,?,?)')
          .run(id, this.cell, role, reserved, sha256(JSON.stringify(body)), model);
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
    const requested = this.db
      .query<{ model: string }, [string]>('SELECT model FROM calls WHERE id=?')
      .get(id)?.model;
    const price = priceOf(requested ?? '') ?? DEFAULT_PRICE;
    const cost = valid
      ? ((input - cached) * price.input + cached * price.cached + output * price.output) / 1e6
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
  /**
   * Forget the progress of this campaign's unfinished cells. Only for a stack
   * whose database ended with the last process: their jobs no longer exist, and
   * no effect they reached can be repeated, because their destination went with it.
   */
  resetUnfinished(prefix: string) {
    this.db
      .query('DELETE FROM cells WHERE result IS NULL AND substr(key,1,length(?1))=?1')
      .run(prefix);
  }
  /** Spend per model and role, from settled usage or the retained reservation. */
  spend(cellPrefix = '') {
    return this.db
      .query<
        { model: string; role: string; calls: number; cost: number; input: number; output: number },
        [string]
      >(
        `SELECT model, role, count(*) AS calls, coalesce(sum(coalesce(settled,reserved)),0) AS cost,
          coalesce(sum(input_tokens),0) AS input, coalesce(sum(output_tokens),0) AS output
         FROM calls WHERE substr(cell,1,length(?1))=?1 GROUP BY model, role ORDER BY model, role`,
      )
      .all(cellPrefix);
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
