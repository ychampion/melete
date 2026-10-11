import { ID_PREFIXES } from '@melete/contracts';
import sodium from 'libsodium-wrappers';
import type { Sql } from 'postgres';
import { recordId } from '../broker/records.ts';

export interface SecretRepository {
  put(id: string, spaceId: string, ciphertext: string): Promise<void>;
  get(id: string, spaceId: string): Promise<string | null>;
  /** Removes one sealed secret. A repository without it keeps nothing worth removing. */
  forget?(id: string, spaceId: string): Promise<void>;
}

/**
 * The pool of the effects database role, when the service runs with separate
 * roles (MELETE_EFFECTS_DATABASE_URL, db/roles.ts). The service's own role
 * cannot read `secret`, so every statement on that table runs here instead.
 */
let effectsPool: Sql | undefined;

/** Set once at start-up by the service that opened the effects role's pool; undefined clears it. */
export function useEffectsPool(sql: Sql | undefined): void {
  effectsPool = sql;
}

/**
 * The only code that reads, writes or deletes rows of `secret`. It runs on the
 * effects role's pool when there is one, and on the pool it was given otherwise.
 */
export class PostgresSecretRepository implements SecretRepository {
  constructor(private readonly fallback: Sql) {}

  private get sql(): Sql {
    return effectsPool ?? this.fallback;
  }

  async put(id: string, spaceId: string, ciphertext: string): Promise<void> {
    await this.sql`insert into secret (id, space_id, ciphertext)
      values (${id}, ${spaceId}, ${ciphertext})`;
  }

  async get(id: string, spaceId: string): Promise<string | null> {
    const rows = await this.sql<{ ciphertext: string }[]>`
      select ciphertext from secret where id = ${id} and space_id = ${spaceId}`;
    return rows[0]?.ciphertext ?? null;
  }

  /** Removes one sealed secret of a space. */
  async forget(id: string, spaceId: string): Promise<void> {
    await this.sql`delete from secret where id = ${id} and space_id = ${spaceId}`;
  }

  /** Removes every sealed secret of a space, and says how many went. */
  async forgetSpace(spaceId: string): Promise<number> {
    const rows = await this.sql`delete from secret where space_id = ${spaceId}`;
    return rows.count;
  }

  /**
   * Removes sealed secrets nothing has pointed at since before `before`: copies
   * an earlier version left behind on every token refresh and disconnection.
   * The effects role cannot read `connection`, so the caller says which ids are
   * still in use. Answers how many went.
   */
  async forgetUnreferenced(inUse: readonly string[], before: Date): Promise<number> {
    const rows = await this.sql`delete from secret
      where created_at < ${before.toISOString()}::timestamptz and not (id = any(${[...inUse]}))`;
    return rows.count;
  }

  /** How many sealed secrets a space still has, for a removal's verification. */
  async countSpace(spaceId: string): Promise<number> {
    const [row] = await this.sql<{ count: number }[]>`select count(*)::int as count
      from secret where space_id = ${spaceId}`;
    return Number(row?.count ?? 0);
  }
}

export interface SecretAccess {
  withSecret<T>(id: string, spaceId: string, use: (value: string) => Promise<T>): Promise<T>;
}

/**
 * MELETE_MASTER_KEY is a random 32-byte seed encoded as hex or base64. Sealed
 * boxes randomize every ciphertext; row identity is sealed too to reject swaps.
 * No secret reader is registered as a broker tool or exposed to the runtime.
 */
export class SealedSecretStore implements SecretAccess {
  constructor(
    private readonly repository: SecretRepository,
    private readonly masterKey: () => string | undefined = () => process.env.MELETE_MASTER_KEY,
  ) {}

  private async keys() {
    await sodium.ready;
    const encoded = this.masterKey();
    if (!encoded) throw new Error('MELETE_MASTER_KEY is required');
    const seed = /^[0-9a-f]{64}$/i.test(encoded)
      ? Buffer.from(encoded, 'hex')
      : /^[A-Za-z0-9+/]{43}=$/.test(encoded)
        ? Buffer.from(encoded, 'base64')
        : Buffer.alloc(0);
    if (seed.length !== sodium.crypto_box_SEEDBYTES) {
      throw new Error('MELETE_MASTER_KEY must encode exactly 32 random bytes');
    }
    try {
      return sodium.crypto_box_seed_keypair(seed);
    } finally {
      sodium.memzero(seed);
    }
  }

  async put(spaceId: string, value: string): Promise<string> {
    if (!spaceId || !value) throw new Error('A space and nonempty secret are required');
    const keys = await this.keys();
    const id = recordId(ID_PREFIXES.secret);
    const plaintext = new TextEncoder().encode(JSON.stringify({ id, spaceId, value, v: 1 }));
    try {
      const box = sodium.crypto_box_seal(plaintext, keys.publicKey);
      await this.repository.put(
        id,
        spaceId,
        `sealed-box-v1:${Buffer.from(box).toString('base64')}`,
      );
      return id;
    } finally {
      sodium.memzero(plaintext);
      sodium.memzero(keys.privateKey);
    }
  }

  /**
   * Seals a value that belongs to the installation rather than to a space,
   * bound to what it is for and to its row: opening it under another purpose
   * or another id fails, so a sealed value cannot be moved to a second use.
   */
  async sealForPurpose(purpose: string, id: string, value: string): Promise<string> {
    if (!purpose || !id || !value) throw new Error('A purpose, an id and a value are required');
    const keys = await this.keys();
    const plaintext = new TextEncoder().encode(JSON.stringify({ id, purpose, value, v: 1 }));
    try {
      const box = sodium.crypto_box_seal(plaintext, keys.publicKey);
      return `sealed-box-v1:${Buffer.from(box).toString('base64')}`;
    } finally {
      sodium.memzero(plaintext);
      sodium.memzero(keys.privateKey);
    }
  }

  /** Opens what `sealForPurpose` sealed, for the same purpose and id only. */
  async openForPurpose(purpose: string, id: string, sealed: string): Promise<string> {
    if (!sealed.startsWith('sealed-box-v1:')) throw new Error('Secret unavailable');
    const keys = await this.keys();
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = sodium.crypto_box_seal_open(
        Buffer.from(sealed.slice('sealed-box-v1:'.length), 'base64'),
        keys.publicKey,
        keys.privateKey,
      );
      const record = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      if (
        record?.id !== id ||
        record.purpose !== purpose ||
        record.v !== 1 ||
        typeof record.value !== 'string'
      )
        throw new Error('Invalid sealed record');
      return record.value;
    } catch {
      throw new Error('Secret unavailable');
    } finally {
      if (plaintext) sodium.memzero(plaintext);
      sodium.memzero(keys.privateKey);
    }
  }

  /** Removes a sealed secret for good, once nothing points at it. */
  async forget(id: string, spaceId: string): Promise<void> {
    await this.repository.forget?.(id, spaceId);
  }

  async withSecret<T>(id: string, spaceId: string, use: (value: string) => Promise<T>): Promise<T> {
    const ciphertext = await this.repository.get(id, spaceId);
    if (!ciphertext?.startsWith('sealed-box-v1:')) throw new Error('Secret unavailable');
    const keys = await this.keys();
    let plaintext: Uint8Array | undefined;
    let value: string;
    try {
      plaintext = sodium.crypto_box_seal_open(
        Buffer.from(ciphertext.slice('sealed-box-v1:'.length), 'base64'),
        keys.publicKey,
        keys.privateKey,
      );
      const record: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (
        !record ||
        typeof record !== 'object' ||
        !('id' in record) ||
        record.id !== id ||
        !('spaceId' in record) ||
        record.spaceId !== spaceId ||
        !('v' in record) ||
        record.v !== 1 ||
        !('value' in record) ||
        typeof record.value !== 'string'
      )
        throw new Error('Invalid sealed record');
      value = record.value;
    } catch {
      throw new Error('Secret unavailable');
    } finally {
      if (plaintext) sodium.memzero(plaintext);
      sodium.memzero(keys.privateKey);
    }
    // JS strings cannot be reliably erased. Keep their lifetime limited to the
    // trusted transport callback and never include transport errors in receipts.
    return use(value);
  }
}
