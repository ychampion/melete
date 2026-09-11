import { describe, expect, test } from 'bun:test';
import { ID_PREFIXES, type Secret, secret } from '@melete/contracts';
import { recordId } from '../broker/records.ts';
import { SealedSecretStore, type SecretRepository } from './secrets.ts';

class Repository implements SecretRepository {
  rows = new Map<string, Secret>();
  async put(id: string, spaceId: string, ciphertext: string): Promise<void> {
    this.rows.set(id, {
      id,
      space_id: spaceId,
      ciphertext,
      created_at: new Date().toISOString(),
      rotated_at: null,
    });
  }
  async get(id: string, spaceId: string): Promise<string | null> {
    const row = this.rows.get(id);
    return row?.space_id === spaceId ? row.ciphertext : null;
  }
}

describe('sealed connector secrets', () => {
  test('stores randomized sealed boxes and only decrypts in the owning space', async () => {
    const repository = new Repository();
    const store = new SealedSecretStore(repository, () => '01'.repeat(32));
    const spaceId = recordId(ID_PREFIXES.space);
    const first = await store.put(spaceId, 'a-private-app-password');
    const second = await store.put(spaceId, 'a-private-app-password');
    expect(secret.safeParse(repository.rows.get(first)).success).toBe(true);
    expect(secret.safeParse(repository.rows.get(second)).success).toBe(true);
    expect(repository.rows.get(first)?.ciphertext).not.toContain('a-private-app-password');
    expect(repository.rows.get(first)?.ciphertext).not.toBe(
      repository.rows.get(second)?.ciphertext,
    );
    expect(
      await store.withSecret(first, spaceId, async (value) => value === 'a-private-app-password'),
    ).toBe(true);
    await expect(store.withSecret(first, 'spc_other', async () => null)).rejects.toThrow(
      'Secret unavailable',
    );
  });

  test('rejects a wrong master key, changed ciphertext and cross-row swaps', async () => {
    const repository = new Repository();
    const store = new SealedSecretStore(repository, () => '02'.repeat(32));
    const first = await store.put('spc_test', 'secret-one');
    const second = await store.put('spc_test', 'secret-two');
    const wrong = new SealedSecretStore(repository, () => '03'.repeat(32));
    await expect(wrong.withSecret(first, 'spc_test', async () => null)).rejects.toThrow(
      'Secret unavailable',
    );
    const row = repository.rows.get(first);
    if (!row) throw new Error('Missing fixture');
    await repository.put(second, 'spc_test', row.ciphertext);
    await expect(store.withSecret(second, 'spc_test', async () => null)).rejects.toThrow(
      'Secret unavailable',
    );
    const bytes = Buffer.from(row.ciphertext.slice('sealed-box-v1:'.length), 'base64');
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    await repository.put(first, 'spc_test', `sealed-box-v1:${bytes.toString('base64')}`);
    await expect(store.withSecret(first, 'spc_test', async () => null)).rejects.toThrow(
      'Secret unavailable',
    );
  });

  test('fails closed without a valid 32-byte master key', async () => {
    for (const key of [undefined, 'password', 'abcd']) {
      const store = new SealedSecretStore(new Repository(), () => key);
      await expect(store.put('spc_test', 'secret')).rejects.toThrow('MELETE_MASTER_KEY');
    }
  });
});
