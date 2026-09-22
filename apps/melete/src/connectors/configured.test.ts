import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectionConfig } from './configured.ts';

const withFile = async (content: string, check: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'melete-connections-'));
  const path = join(directory, 'connections.json');
  try {
    await writeFile(path, content);
    await check(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe('the connection configuration file', () => {
  test('the shipped file reads as an empty list', async () => {
    expect(
      await readConnectionConfig(
        join(import.meta.dir, '../../../../deploy/config/connections.json'),
      ),
    ).toEqual([]);
  });

  test('an entry is read as written', async () => {
    await withFile('[{"kind":"ics","id":"con_feed","icsPath":"/data/feed.ics"}]', async (path) => {
      expect(await readConnectionConfig(path)).toEqual([
        { kind: 'ics', id: 'con_feed', icsPath: '/data/feed.ics' },
      ]);
    });
  });

  test('a file that is not JSON stops start-up naming the file and its setting', async () => {
    await withFile('[{"kind":"ics",}]', async (path) => {
      const error = await readConnectionConfig(path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toStartWith(
        `${path} (MELETE_CONNECTIONS_FILE) is not valid JSON`,
      );
    });
  });

  test('an entry of the wrong shape names the file and the entry', async () => {
    await withFile(
      '[{"kind":"email","id":"con_mail","username":"me","from":"me@example.net","imap":{"host":"imap.example.net","port":993,"secure":true}}]',
      async (path) => {
        const error = await readConnectionConfig(path).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toStartWith(
          `${path} (MELETE_CONNECTIONS_FILE) is not a list of connections`,
        );
        expect(message).toContain('0.smtp');
      },
    );
  });
});
