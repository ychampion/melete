import { ID_PREFIXES } from '@melete/contracts';
import sodium from 'libsodium-wrappers';
import type { Sql } from 'postgres';
import { recordId } from '../broker/records.ts';

export interface SecretRepository {
  put(id: string, spaceId: string, ciphertext: string): Promise<void>;
  get(id: string, spaceId: string): Promise<string | null>;
}

/** This repository is deliberately private to the trusted connector process. */
export class PostgresSecretRepository implements SecretRepository {
  constructor(private readonly sql: Sql) {}

  async put(id: string, spaceId: string, ciphertext: string): Promise<void> {
    await this.sql`insert into secret (id, space_id, ciphertext)
      values (${id}, ${spaceId}, ${ciphertext})`;
  }

  async get(id: string, spaceId: string): Promise<string | null> {
    const rows = await this.sql<{ ciphertext: string }[]>`
      select ciphertext from secret where id = ${id} and space_id = ${spaceId}`;
    return rows[0]?.ciphertext ?? null;
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
