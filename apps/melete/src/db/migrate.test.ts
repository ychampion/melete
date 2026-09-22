import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { openDatabase } from './client.ts';
import { migrateDatabase } from './migrate.ts';

const closedPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });

describe('a database start-up cannot reach', () => {
  test('is named by server and setting, without the password', async () => {
    const port = await closedPort();
    const handle = openDatabase(`postgres://melete:hunter2-secret@127.0.0.1:${port}/melete`);
    try {
      const error = await migrateDatabase(handle).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toStartWith(`Cannot open the database at 127.0.0.1:${port} (DATABASE_URL): `);
      expect(message).toContain('ECONNREFUSED');
      expect(message).not.toContain('hunter2');
    } finally {
      await handle.close();
    }
  });
});
