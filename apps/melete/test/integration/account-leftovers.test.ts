/**
 * What is left once an account is deleted, disabled or signed out
 * everywhere, against Postgres:
 *
 * - the empty row a deleted account leaves behind is not an account: the
 *   operator cannot turn it back on, and it is not tried again every minute;
 * - an export holds no notification keys, and a partitioned table once;
 * - a disabled account's reset link and a setup code written by a service
 *   whose clock is behind the database's;
 * - signing out everywhere takes back the room invites nobody used yet.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roomDetail, roomInviteCreated } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { runAccount } from '../../src/account/cli.ts';
import { accountExport } from '../../src/account/export.ts';
import { AccountRemovalService, removedEmail } from '../../src/account/removal.ts';
import type { ZipEntry } from '../../src/account/zip.ts';
import { issueSetupCode, SETUP_CODE_HOURS, spendSetupCode } from '../../src/api/setup-code.ts';
import { recordId } from '../../src/broker/records.ts';
import { loadEnv } from '../../src/env.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { SpaceRemovalService } from '../../src/spaces/removal.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';
import { seedSpace } from './space-removal-fixture.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-account-leftovers-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
afterAll(async () => {
  await handle?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = handle ? describe : describe.skip;
const PUBLIC_URL = 'https://melete.example.test';
const password = 'a-long-test-password';

function database() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

async function harness() {
  const { db, sql } = database();
  const journal = new FileRestrictionJournal(join(root, 'journal.jsonl'));
  await journal.initializeNew();
  const jobs = new JobService(db, {} as PgBoss);
  const removals = new SpaceRemovalService({
    db,
    sql,
    jobs,
    journal,
    roots: { spacesRoot, workRoot },
    leaseMs: 5_000,
    blobs: new LocalBlobStore(join(root, 'blobs')),
  });
  const removalDeps = {
    sql,
    spaces: removals,
    principals: new PrincipalService(db, spacesRoot, jobs),
    log: () => {},
    removeChats: (ids: readonly string[]) => removeJobs({ jobs, sql }, ids),
  };
  const accounts = new AccountRemovalService(removalDeps);
  const app = createApp({
    db,
    sql,
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_PREVIEW_MULTIPLAYER: 'true',
      MELETE_PUBLIC_URL: PUBLIC_URL,
      MELETE_SETUP_OPEN: 'true',
      MELETE_SPACES_DIR: spacesRoot,
      MELETE_WORK_DIR: workRoot,
    }),
    checkDatabase: async () => 'ok',
    jobs,
    removals,
    accountRemovals: accounts,
  });
  const call = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const made = await call('', '/setup', 'POST', { email: 'owner@example.test', password });
  expect(made.status).toBe(201);
  const owner = made.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { sql, call, accounts, removalDeps, owner };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const codeOf = async (response: Response) =>
  ((await response.json()) as { error?: { code?: string } }).error?.code;

async function text(data: ZipEntry['data']): Promise<string> {
  if (typeof data === 'string') return data;
  let out = '';
  for await (const chunk of data as AsyncIterable<string | Uint8Array>)
    out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  return out;
}

/** Every records file of an account's export, by its path in the archive. */
async function exportedRecords(principalId: string) {
  const files = new Map<string, string>();
  for await (const entry of accountExport({ sql: database().sql, spacesRoot }, principalId))
    if (entry.name.includes('records/')) files.set(entry.name, await text(entry.data));
  return files;
}

withDb('a setup code issued by a service whose clock is behind', () => {
  test('lasts its full time by the database’s clock, so it can still be spent', async () => {
    const { sql } = database();
    try {
      // The service's clock is ten days behind the database's.
      setSystemTime(new Date(Date.now() - 10 * 24 * 3_600_000));
      let issued: Awaited<ReturnType<typeof issueSetupCode>>;
      try {
        issued = await issueSetupCode(sql);
      } finally {
        setSystemTime();
      }
      if (!issued) throw new Error('no code was issued');
      const [lasts] = await sql`select ${issued.expiresAt.toISOString()}::timestamptz
        > now() + make_interval(hours => ${SETUP_CODE_HOURS - 1}) as full_time`;
      expect(lasts?.full_time).toBe(true);
      expect(await sql.begin((tx) => spendSetupCode(tx, undefined, issued.code))).toBe(true);
    } finally {
      await sql`delete from setup_code`;
    }
  });
});

withDb('what an account leaves behind', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });

  /**
   * A member of someone else's room who wrote a message there and had
   * Melete open, then deleted their account, so its row has to stay.
   */
  async function tombstone() {
    const room = await seedSpace(h.sql, {
      kind: 'shared',
      name: 'Book club',
      spacesRoot,
      workRoot,
    });
    const [thread] = await h.sql<{ id: string }[]>`select id from room_thread
      where space_id = ${room.spaceId} limit 1`;
    await h.sql`insert into room_message (id, space_id, thread_id, author_principal_id, text, submission_id)
      values (${recordId('rmg')}, ${room.spaceId}, ${thread?.id ?? ''}, ${room.memberId},
        'I will bring the snacks.', ${recordId('rmg')})`;
    await h.sql`insert into client_focus (principal_id, focused_at) values (${room.memberId}, now())`;
    await h.accounts.remove(room.memberId, room.memberId, `${room.memberId}@example.test`);
    return room.memberId;
  }

  test('the operator cannot enable or disable what is left of a deleted account', async () => {
    const id = newId('own');
    await h.sql`insert into principal (id, email, disabled_at)
      values (${id}, ${removedEmail(id)}, now())`;
    const enabled = await runAccount(h.sql, ['enable', removedEmail(id)], PUBLIC_URL);
    expect(enabled.code).not.toBe(0);
    const disabled = await runAccount(h.sql, ['disable', removedEmail(id)], PUBLIC_URL);
    expect(disabled.code).not.toBe(0);
    const [row] = await h.sql`select disabled_at is not null as disabled from principal
      where id = ${id}`;
    expect(row?.disabled).toBe(true);
    await h.sql`delete from principal where id = ${id}`;
  });

  test('a deleted account whose row has to stay is finished once, not every pass', async () => {
    const id = await tombstone();
    const spy = spyOn(
      h.accounts as unknown as { finish: (principalId: string) => Promise<boolean> },
      'finish',
    );
    const finishes = () => spy.mock.calls.filter(([principalId]) => principalId === id).length;
    try {
      await h.accounts.resume();
      expect(finishes()).toBe(1);
      const [left] = await h.sql`select email from principal where id = ${id}`;
      expect(left?.email).toBe(removedEmail(id));
      await h.accounts.resume();
      await h.accounts.resume();
      expect(finishes()).toBe(1);
    } finally {
      spy.mockRestore();
    }
    // After a restart it is tried once more, in case what named it is gone.
    const restarted = new AccountRemovalService(h.removalDeps);
    const again = spyOn(
      restarted as unknown as { finish: (principalId: string) => Promise<boolean> },
      'finish',
    );
    await restarted.resume();
    await restarted.resume();
    expect(again.mock.calls.filter(([principalId]) => principalId === id)).toHaveLength(1);
  });

  test('the row a deleted account leaves keeps no record of when it last had Melete open', async () => {
    const id = await tombstone();
    await h.accounts.resume();
    expect(await h.sql`select 1 from principal where id = ${id}`).toHaveLength(1);
    expect(await h.sql`select 1 from client_focus where principal_id = ${id}`).toHaveLength(0);
  });

  test('an export holds no browser’s notification address or keys', async () => {
    const id = newId('own');
    await h.sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
    await h.sql`insert into push_setting (principal_id) values (${id})`;
    await h.sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth, device_label)
      values (${newId('psub')}, ${id}, ${`https://push.example.test/send/${id}`},
        'p256dh-key-material', 'auth-key-material', 'Phone')`;
    const files = await exportedRecords(id);
    // The account's own records are still there.
    expect([...files.keys()]).toContain('account/records/push_setting.json');
    const all = [...files.values()].join('\n');
    expect(all).not.toContain('push.example.test');
    expect(all).not.toContain('p256dh-key-material');
    expect(all).not.toContain('auth-key-material');
  });

  test('a partitioned table is exported once, through the table itself', async () => {
    const id = newId('own');
    await h.sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
    await h.sql.unsafe(`create table leftover_partitioned (id text primary key,
      principal_id text not null, note text) partition by hash (id)`);
    try {
      await h.sql.unsafe(`create table leftover_partitioned_a partition of leftover_partitioned
        for values with (modulus 2, remainder 0)`);
      await h.sql.unsafe(`create table leftover_partitioned_b partition of leftover_partitioned
        for values with (modulus 2, remainder 1)`);
      await h.sql`insert into leftover_partitioned (id, principal_id, note)
        values ('row-1', ${id}, 'kept-once-marker')`;
      const files = await exportedRecords(id);
      const copies = [...files.values()].join('\n').split('kept-once-marker').length - 1;
      expect(copies).toBe(1);
      expect([...files.keys()]).toContain('account/records/leftover_partitioned.json');
    } finally {
      await h.sql.unsafe('drop table leftover_partitioned');
    }
  });

  test('a disabled account’s reset link is refused when used, as it is when checked', async () => {
    const email = 'disabled-reset@example.test';
    const made = await runAccount(h.sql, ['create', email, '--json'], PUBLIC_URL);
    expect(made.code).toBe(0);
    const { code: token } = JSON.parse(made.out) as { code: string };
    // Turned off by some other way than the operator's command, which would end the link too.
    await h.sql`update principal set disabled_at = now() where email = ${email}`;
    const checked = await h.call('', '/password-reset/check', 'POST', { token });
    expect(checked.status).toBe(400);
    expect(await codeOf(checked)).toBe('invalid_reset_link');
    const used = await h.call('', '/password-reset/consume', 'POST', {
      token,
      new_password: 'a-new-long-password',
    });
    expect(used.status).toBe(400);
    expect(await codeOf(used)).toBe('invalid_reset_link');
    const [row] = await h.sql`select password_hash is null as unset from principal
      where email = ${email}`;
    expect(row?.unset).toBe(true);
  });

  test('signing out everywhere takes back the room invites nobody has used', async () => {
    const cookie = h.owner;
    const made = await h.call(cookie, '/rooms', 'POST', { name: 'Allotment' });
    expect(made.status).toBe(201);
    const { room } = roomDetail.parse(await made.json());
    const created = await h.call(cookie, `/rooms/${room.id}/invites`, 'POST', {
      email: 'guest@guest.example',
    });
    expect(created.status).toBe(201);
    const { path } = roomInviteCreated.parse(await created.json());
    const token = new URLSearchParams(path.split('?')[1] ?? '').get('token') ?? '';
    expect((await h.call('', '/invites/view', 'POST', { token })).status).toBe(200);

    const ended = await h.call(cookie, '/account/sessions/revoke-others', 'POST');
    expect(ended.status).toBe(200);

    const viewed = await h.call('', '/invites/view', 'POST', { token });
    expect(viewed.status).toBe(404);
    expect(await codeOf(viewed)).toBe('invite_unavailable');
    const accepted = await h.call('', '/invites/accept', 'POST', {
      token,
      password: 'a-guest-long-password',
    });
    expect(accepted.status).toBe(404);
    expect(await h.sql`select 1 from principal where email = 'guest@guest.example'`).toHaveLength(
      0,
    );
  });
});
