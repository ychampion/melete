/**
 * Sign-ins between their start and the browser's return, and finished ones
 * the app may still ask about. A sign-in started on one service instance can
 * come back to another, so with Postgres every instance reads the same rows.
 *
 * A row holds a PKCE verifier and sometimes a client secret. It is sealed
 * with the master key and bound to its own row, so a payload copied onto
 * another row does not open, and it is found by a digest of the sign-in's id
 * or state, never the value itself. Rows live as long as the sign-in may.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { SealedSecretStore, type SecretRepository } from '../connectors/secrets.ts';

export interface SignInStore {
  /** Keeps `value` under the kind and key until `expiresAt`, replacing what was there. */
  put<T>(kind: string, key: string, value: T, expiresAt: number, subject?: string): Promise<void>;
  /** The live value, or nothing. */
  get<T>(kind: string, key: string, now: number): Promise<T | undefined>;
  /** Removes the value and returns it if it was live. Only one caller ever gets it. */
  take<T>(kind: string, key: string, now: number): Promise<T | undefined>;
  delete(kind: string, key: string): Promise<void>;
  /** Removes every value of the kind kept for the subject. */
  deleteSubject(kind: string, subject: string): Promise<void>;
  /** Whether any live value of the kind is kept for the subject. */
  hasSubject(kind: string, subject: string, now: number): Promise<boolean>;
}

type Entry = { value: string; expiresAt: number; subject?: string };

/** One process's sign-ins. Values are copied in and out, as a database would. */
export class MemorySignInStore implements SignInStore {
  private readonly entries = new Map<string, Entry & { kind: string }>();

  private sweep(now: number) {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }

  private live(kind: string, key: string, now: number) {
    const entry = this.entries.get(`${kind}\0${key}`);
    return entry && entry.expiresAt > now ? entry : undefined;
  }

  async put<T>(kind: string, key: string, value: T, expiresAt: number, subject?: string) {
    this.entries.set(`${kind}\0${key}`, {
      kind,
      value: JSON.stringify(value),
      expiresAt,
      ...(subject === undefined ? {} : { subject }),
    });
  }

  async get<T>(kind: string, key: string, now: number) {
    this.sweep(now);
    const entry = this.live(kind, key, now);
    return entry ? (JSON.parse(entry.value) as T) : undefined;
  }

  async take<T>(kind: string, key: string, now: number) {
    const entry = this.live(kind, key, now);
    this.entries.delete(`${kind}\0${key}`);
    return entry ? (JSON.parse(entry.value) as T) : undefined;
  }

  async delete(kind: string, key: string) {
    this.entries.delete(`${kind}\0${key}`);
  }

  async deleteSubject(kind: string, subject: string) {
    for (const [id, entry] of this.entries)
      if (entry.kind === kind && entry.subject === subject) this.entries.delete(id);
  }

  async hasSubject(kind: string, subject: string, now: number) {
    this.sweep(now);
    for (const entry of this.entries.values())
      if (entry.kind === kind && entry.subject === subject) return true;
    return false;
  }
}

/** The row a kind and key are kept under. */
export function signInKey(kind: string, key: string): string {
  return createHash('sha256').update(`${kind}\0${key}`).digest('hex');
}

/**
 * Sign-ins every instance on the database shares, in `signin_pending`. Expired
 * rows are deleted about once a minute by whichever instance reads.
 */
export class PostgresSignInStore implements SignInStore {
  private nextSweep = 0;

  constructor(
    private readonly sql: Sql,
    private readonly masterKey: () => string | undefined,
  ) {}

  /** The sealed box binds the row it was written for, so it opens on no other. */
  private async seal(row: string, value: unknown): Promise<string> {
    let written: { id: string; ciphertext: string } | undefined;
    const one: SecretRepository = {
      put: async (id, _binding, ciphertext) => {
        written = { id, ciphertext };
      },
      get: async () => null,
    };
    await new SealedSecretStore(one, this.masterKey).put(`signin:${row}`, JSON.stringify(value));
    if (!written) throw new Error('Sign-in unavailable');
    return JSON.stringify(written);
  }

  private async open<T>(row: string, payload: string): Promise<T | undefined> {
    let sealed: { id?: unknown; ciphertext?: unknown };
    try {
      sealed = JSON.parse(payload) as typeof sealed;
    } catch {
      return undefined;
    }
    const { id, ciphertext } = sealed;
    if (typeof id !== 'string' || typeof ciphertext !== 'string') return undefined;
    const one: SecretRepository = {
      put: async () => {},
      get: async (wanted) => (wanted === id ? ciphertext : null),
    };
    // A row that does not open is no sign-in: the person starts again.
    return new SealedSecretStore(one, this.masterKey)
      .withSecret(id, `signin:${row}`, async (value) => JSON.parse(value) as T)
      .catch(() => undefined);
  }

  private sweep(now: number) {
    if (now < this.nextSweep) return;
    this.nextSweep = now + 60_000;
    void this.sql`delete from signin_pending where expires_at <= ${new Date(now)}`.catch(() => {});
  }

  async put<T>(kind: string, key: string, value: T, expiresAt: number, subject?: string) {
    const row = signInKey(kind, key);
    const payload = await this.seal(row, value);
    await this
      .sql`insert into signin_pending (state_hash, kind, subject, sealed_payload, expires_at)
      values (${row}, ${kind}, ${subject ?? null}, ${payload}, ${new Date(expiresAt)})
      on conflict (state_hash) do update set subject = excluded.subject,
        sealed_payload = excluded.sealed_payload, expires_at = excluded.expires_at`;
  }

  async get<T>(kind: string, key: string, now: number) {
    this.sweep(now);
    const row = signInKey(kind, key);
    const [found] = await this.sql<{ sealed_payload: string }[]>`
      select sealed_payload from signin_pending
      where state_hash = ${row} and expires_at > ${new Date(now)}`;
    return found ? this.open<T>(row, found.sealed_payload) : undefined;
  }

  async take<T>(kind: string, key: string, now: number) {
    const row = signInKey(kind, key);
    const [found] = await this.sql<{ sealed_payload: string; expires_at: Date }[]>`
      delete from signin_pending where state_hash = ${row}
      returning sealed_payload, expires_at`;
    if (!found || found.expires_at.getTime() <= now) return undefined;
    return this.open<T>(row, found.sealed_payload);
  }

  async delete(kind: string, key: string) {
    await this.sql`delete from signin_pending where state_hash = ${signInKey(kind, key)}`;
  }

  async deleteSubject(kind: string, subject: string) {
    await this.sql`delete from signin_pending where kind = ${kind} and subject = ${subject}`;
  }

  async hasSubject(kind: string, subject: string, now: number) {
    const [found] = await this.sql`select 1 from signin_pending
      where kind = ${kind} and subject = ${subject} and expires_at > ${new Date(now)} limit 1`;
    return Boolean(found);
  }
}

/** Shared through Postgres when there is a master key to seal with, else this process's own. */
export function signInStore(sql: Sql | undefined, masterKey: string | undefined): SignInStore {
  return sql && masterKey ? new PostgresSignInStore(sql, () => masterKey) : new MemorySignInStore();
}
