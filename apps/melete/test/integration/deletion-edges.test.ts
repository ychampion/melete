/**
 * Guards of deleting and disconnecting that no other test held:
 * - opening a space to erase views from its history leaves the person's own
 *   files under knowledge/ and their history alone;
 * - disconnecting withdraws a Google grant that only another account shares,
 *   reports a provider that refused or could not be asked, and deletes the
 *   sealed tokens either way;
 * - the sweep of sealed tokens keeps those of a connection that is paused;
 * - a read that took a reference a refresh just replaced reads again;
 * - the start-up sweep of captured pages touches only captures of deleted
 *   chats, never through a linked folder.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { googleIssuer } from '../../src/connectors/google.ts';
import { mcpCredentialAccess } from '../../src/connectors/mcp-credentials.ts';
import { connectionRevocation, sweepUnreferencedSecrets } from '../../src/connectors/revocation.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { signedInAccess } from '../../src/connectors/signed-in.ts';
import { removeOrphanedCaptures } from '../../src/experience/workspace-trash.ts';
import { newId } from '../../src/ids.ts';
import { MarkdownViews } from '../../src/memory/markdown.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { seedJob } from '../helpers/broker.ts';
import { createTestDatabase } from './postgres.ts';

const exec = promisify(execFile);
const db = await createTestDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-deletion-edges-'));
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = db ? describe : describe.skip;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const MASTER_KEY = 'ab'.repeat(32);
const twoHoursAgo = () => new Date(Date.now() - 2 * 3600_000);

withDb('opening a space erases only views from its history', () => {
  test("the person's own files under knowledge/ keep their history", async () => {
    if (!db) return;
    const spacesRoot = join(root, 'spaces-views');
    const spaceId = `sp_${'0'.repeat(25)}A`;
    const space = join(spacesRoot, spaceId);
    await mkdir(join(space, 'knowledge'), { recursive: true });
    const git = (...args: string[]) =>
      exec('git', ['-C', space, '-c', 'user.name=P', '-c', 'user.email=p@x', ...args]);
    await git('init', '-q', '-b', 'memory-view');
    const own = ['knowledge/my-notes.md', 'knowledge/k_notes.md'];
    for (const path of own) await writeFile(join(space, path), `kept ${path}`);
    const view = `knowledge/k_01${'H'.repeat(24)}.md`;
    await writeFile(join(space, view), 'Sister lives in July');
    await git('add', '-f', '--', ...own, view);
    await git('commit', '-q', '-m', 'mine and a view');

    await new MarkdownViews(db.sql, spacesRoot).cleanup(spaceId, []);

    const objects = (await exec('git', ['-C', space, 'cat-file', '--batch-all-objects', '--batch']))
      .stdout;
    expect(objects).not.toContain('Sister lives in July');
    for (const path of own) {
      expect((await git('show', `HEAD:${path}`)).stdout).toBe(`kept ${path}`);
      expect((await git('log', '--format=%s', '--', path)).stdout.trim()).toBe('mine and a view');
    }
  });
});

/** A Google connection with its own sealed tokens. */
async function googleConnection(
  sql: Sql,
  secrets: SealedSecretStore,
  spaceId: string,
  account: string,
  status = 'active',
) {
  const ref = await secrets.put(
    spaceId,
    JSON.stringify({
      access_token: `at-${account}`,
      refresh_token: `rt-${account}`,
      scope: 'x',
      account,
    }),
  );
  const id = newId('conn');
  await sql`insert into connection (id, space_id, provider, label, secret_ref, configuration, status)
    values (${id}, ${spaceId}, 'gmail', 'Mail', ${ref},
      ${JSON.stringify({ kind: 'gmail', account })}::jsonb, ${status})`;
  return {
    id,
    spaceId,
    provider: 'gmail',
    configuration: { kind: 'gmail', account },
    secretRef: ref,
  };
}

withDb('disconnecting a Google account', () => {
  const revokeCalls: string[] = [];
  const fetcherAnswering = (status: number) => async (request: Request) => {
    revokeCalls.push(new URLSearchParams(await request.text()).get('token') ?? '');
    return new Response(null, { status });
  };
  const client = { clientId: 'client', clientSecret: 'secret' };

  test("withdraws the grant when only a different account's connection is left", async () => {
    if (!db) return;
    const { claims } = await seedJob(db.sql);
    const secrets = new SealedSecretStore(new PostgresSecretRepository(db.sql), () => MASTER_KEY);
    const leaving = await googleConnection(
      db.sql,
      secrets,
      claims.space_id,
      'a-leaving@example.test',
    );
    await googleConnection(db.sql, secrets, claims.space_id, 'b-staying@example.test');
    revokeCalls.length = 0;
    const revoke = connectionRevocation({
      sql: db.sql,
      secrets,
      google: { client },
      fetcher: fetcherAnswering(200),
      log: () => {},
    });
    expect(await revoke(leaving)).toBe('withdrawn');
    expect(revokeCalls).toEqual(['rt-a-leaving@example.test']);
    expect(await db.sql`select id from secret where id = ${leaving.secretRef}`).toHaveLength(0);
  });

  test('says the provider did not confirm when it refuses, and deletes the tokens anyway', async () => {
    if (!db) return;
    const { claims } = await seedJob(db.sql);
    const secrets = new SealedSecretStore(new PostgresSecretRepository(db.sql), () => MASTER_KEY);
    const leaving = await googleConnection(
      db.sql,
      secrets,
      claims.space_id,
      'c-refused@example.test',
    );
    const revoke = connectionRevocation({
      sql: db.sql,
      secrets,
      google: { client },
      fetcher: fetcherAnswering(400),
      log: () => {},
    });
    expect(await revoke(leaving)).toBe('not_confirmed');
    expect(await db.sql`select id from secret where id = ${leaving.secretRef}`).toHaveLength(0);
  });

  test('says the provider did not confirm when the tokens cannot be read, and deletes them', async () => {
    if (!db) return;
    const { claims } = await seedJob(db.sql);
    const secrets = new SealedSecretStore(new PostgresSecretRepository(db.sql), () => MASTER_KEY);
    const leaving = await googleConnection(
      db.sql,
      secrets,
      claims.space_id,
      'd-unreadable@example.test',
    );
    await db.sql`update secret set ciphertext = 'sealed-box-v1:not-a-box' where id = ${leaving.secretRef}`;
    revokeCalls.length = 0;
    const revoke = connectionRevocation({
      sql: db.sql,
      secrets,
      google: { client },
      fetcher: fetcherAnswering(200),
      log: () => {},
    });
    expect(await revoke(leaving)).toBe('not_confirmed');
    expect(revokeCalls).toEqual([]);
    expect(await db.sql`select id from secret where id = ${leaving.secretRef}`).toHaveLength(0);
  });

  test('the sweep keeps the tokens of a paused connection, however old', async () => {
    if (!db) return;
    const { claims } = await seedJob(db.sql);
    const secrets = new SealedSecretStore(new PostgresSecretRepository(db.sql), () => MASTER_KEY);
    const paused = await googleConnection(
      db.sql,
      secrets,
      claims.space_id,
      'e-paused@example.test',
      'disabled',
    );
    await db.sql`update secret set created_at = now() - interval '30 days' where id = ${paused.secretRef}`;
    await sweepUnreferencedSecrets(db.sql);
    expect(await db.sql`select id from secret where id = ${paused.secretRef}`).toHaveLength(1);
  });
});

describe('a read that took a reference a refresh just replaced', () => {
  test('a signed-in connection reads again and finds the new tokens', async () => {
    const rows = [
      { secret_ref: 'old', status: 'active' },
      { secret_ref: 'new' },
      { secret_ref: 'new', status: 'active' },
    ];
    let reads = 0;
    const sql = (async () => [rows[Math.min(reads++, rows.length - 1)]]) as unknown as Sql;
    const secrets = {
      withSecret: async (id: string, _space: string, use: (value: string) => unknown) => {
        if (id !== 'new') throw new Error('Secret unavailable');
        return use(
          JSON.stringify({
            access_token: 'tok-new',
            expires_at: Date.now() + 3600_000,
            scope: 'x',
            account: 'p@example.test',
          }),
        );
      },
    } as unknown as SealedSecretStore;
    const access = signedInAccess({
      sql,
      secrets,
      connectionId: 'conn_1',
      spaceId: 'sp_1',
      issuer: googleIssuer({ clientId: 'c', clientSecret: 's' }, ''),
    });
    expect(await access.token()).toBe('tok-new');
  });

  test('an MCP connection reads again and finds the new tokens', async () => {
    const rows = [
      { secret_ref: 'old', generation: 1, scopes: [], status: 'active' },
      { secret_ref: 'new' },
      { secret_ref: 'new', generation: 1, scopes: [], status: 'active' },
    ];
    let reads = 0;
    const sql = (async () => [rows[Math.min(reads++, rows.length - 1)]]) as unknown as Sql;
    const store = {
      withSecret: async (id: string, _space: string, use: (value: string) => unknown) => {
        if (id !== 'new') throw new Error('Secret unavailable');
        return use(
          JSON.stringify({
            access_token: 'tok-new',
            refresh_token: 'r',
            token_url: 'https://auth.example.test/token',
          }),
        );
      },
    } as unknown as SealedSecretStore;
    const access = mcpCredentialAccess(sql, store, { connectionId: 'conn_1', spaceId: 'sp_1' });
    expect(await access.accessToken()).toBe('tok-new');
  });
});

withDb('the start-up sweep of captured pages', () => {
  async function row(spaceId: string, jobId: string | null, area: string, path: string) {
    const id = newId('art');
    if (!db) return id;
    await db.sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
      values (${id}, ${spaceId}, ${jobId}, null, ${area}, ${path}, ${'a'.repeat(64)}, 'text/plain', 4)`;
    return id;
  }
  async function file(path: string) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'kept');
    await utimes(path, twoHoursAgo(), twoHoursAgo());
  }

  test('keeps the old captures of a live chat, and files that only look like captures', async () => {
    if (!db) return;
    const spacesRoot = join(root, 'spaces-captures');
    const { claims } = await seedJob(db.sql);
    const space = claims.space_id;
    const artifacts = join(spacesRoot, space, 'artifacts');
    const live = await browserArtifactSink(db.sql, spacesRoot)(
      { space_id: space, job_id: claims.job_id },
      {
        id: 'obs_1',
        url: 'https://bank.example.test/',
        tree: 'Balance',
        screenshot: Buffer.from('p').toString('base64'),
        schema: {},
      },
    );
    const livePaths = ['tree', 'screenshot'].map((key) =>
      String((live[key] as { path: string }).path),
    );
    for (const path of livePaths) await utimes(join(artifacts, path), twoHoursAgo(), twoHoursAgo());
    const lookalikes = ['reports/browser/art_1.txt', 'browser/art_2.txt.bak'];
    const ids = [] as string[];
    for (const path of lookalikes) {
      await file(join(artifacts, path));
      ids.push(await row(space, null, 'work', path));
    }
    await file(join(artifacts, 'browser/art_3.png'));
    ids.push(await row(space, null, 'artifacts', 'browser/art_3.png'));

    await removeOrphanedCaptures(db.sql, spacesRoot);

    for (const path of [...livePaths, ...lookalikes, 'browser/art_3.png'])
      expect(await exists(join(artifacts, path))).toBe(true);
    expect(await db.sql`select id from artifact where id = any(${ids})`).toHaveLength(ids.length);
  });

  test('never deletes through a linked browser folder', async () => {
    if (!db) return;
    const spacesRoot = join(root, 'spaces-linked');
    const outside = join(root, 'outside');
    const { claims } = await seedJob(db.sql);
    const space = claims.space_id;
    await mkdir(join(spacesRoot, space, 'artifacts'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(spacesRoot, space, 'artifacts', 'browser'));
    await file(join(outside, 'art_4.png'));
    await file(join(outside, 'art_5.png'));
    await row(space, null, 'work', 'browser/art_4.png');

    await removeOrphanedCaptures(db.sql, spacesRoot);

    expect(await exists(join(outside, 'art_4.png'))).toBe(true);
    expect(await exists(join(outside, 'art_5.png'))).toBe(true);
  });
});
