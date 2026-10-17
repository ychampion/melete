import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { loadEnv } from '../env.ts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import { connectorOptionsFromEnv, readConnectionConfig } from './configured.ts';

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

  // Root reads any file, so the refusal only happens as another user; and on Windows a
  // mode of 000 only sets the read-only attribute, which still lets the file be read.
  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a file the service may not read names the cause, not a bare EACCES',
    async () => {
      await withFile('[]', async (path) => {
        await chmod(path, 0o000);
        const error = await readConnectionConfig(path).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toStartWith(`${path} (MELETE_CONNECTIONS_FILE) cannot be read`);
        expect(message).toContain('umask');
        expect(message).toContain('chmod 644 deploy/config/*.json');
      });
    },
  );

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

describe('the provider settings connectors open with', () => {
  // The default Speech and Transcription rows are created from the full
  // environment; their connectors open from these options. A key missing here
  // left both rows installed with nothing running behind them.
  test('an ElevenLabs key reaches the speech and transcription connectors', () => {
    const env = loadEnv({ ELEVENLABS_API_KEY: 'el-test-key' });
    const options = connectorOptionsFromEnv(null as unknown as Sql, env);
    const configured = capabilitiesFromEnv(options.env);
    expect(configured.provider).toBe('elevenlabs');
    expect(configured.speech).not.toBeNull();
    expect(configured.transcription).not.toBeNull();
  });
});
