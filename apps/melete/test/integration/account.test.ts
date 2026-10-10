/**
 * Taking everything along, and deleting an account, against Postgres and real
 * folders.
 *
 * - The export is a zip a person can read without Melete: chats as Markdown
 *   and JSON, the original files, every record of their spaces, and nothing
 *   secret.
 * - Deleting an account stops it working at once, removes every space it
 *   owns with the same sweep and recount as removing one space, and then
 *   takes its row; the account that set Melete up is kept, and manages the
 *   others.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { accountList, accountRemoval, accountRemovalPreview } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { AccountRemovalService, removedEmail } from '../../src/account/removal.ts';
import { zipEntries } from '../../src/attachments/extract.ts';
import { recordId } from '../../src/broker/records.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { SpaceRemovalService } from '../../src/spaces/removal.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';
import { seedFiles, seedSpace } from './space-removal-fixture.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-account-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
afterAll(async () => {
  await handle?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = handle ? describe : describe.skip;
const password = 'a-long-test-password';

const there = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Every entry of an archive, by name. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Buffer>();
  for (const [name, entry] of zipEntries(bytes)) {
    const start =
      entry.offset +
      30 +
      view.readUInt16LE(entry.offset + 26) +
      view.readUInt16LE(entry.offset + 28);
    const data = view.subarray(start, start + entry.compressed);
    out.set(name, entry.method === 8 ? inflateRawSync(data) : Buffer.from(data));
  }
  return out;
}

/** What the account deletion said it could not do yet. */
const logged: string[] = [];

async function harness() {
  if (!handle) throw new Error('Postgres unavailable');
  const { db, sql } = handle;
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
  const accounts = new AccountRemovalService({
    sql,
    spaces: removals,
    principals: new PrincipalService(db, spacesRoot, jobs),
    log: (line) => logged.push(line),
  });
  const app = createApp({
    db,
    sql,
    env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: spacesRoot, MELETE_WORK_DIR: workRoot }),
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
  const cookieOf = (response: Response) => {
    const value = response.headers.get('set-cookie')?.split(';')[0];
    if (!value) throw new Error(`no session (${response.status})`);
    return value;
  };
  const owner = cookieOf(
    await call('', '/setup', 'POST', { email: 'owner@example.test', password }),
  );
  const [ownerRow] = await sql<{ id: string }[]>`select id from owner limit 1`;
  if (!ownerRow) throw new Error('no setup owner');
  /** An account the owner makes, signed in, with its own space. */
  const person = async (email: string) => {
    const made = await call(owner, '/principals', 'POST', { email, password });
    expect(made.status).toBe(201);
    const { principal } = (await made.json()) as { principal: { id: string } };
    const cookie = cookieOf(await call('', '/login', 'POST', { email, password }));
    const [space] = await sql<{ id: string }[]>`select id from space
      where owner_principal_id = ${principal.id} and kind = 'personal'`;
    if (!space) throw new Error('no personal space');
    return { id: principal.id, cookie, spaceId: space.id };
  };
  /** Wait for every space removal this account started, then let the account finish. */
  const settle = async (principalId: string) => {
    for (;;) {
      const live = await sql<{ id: string }[]>`select id from space_removal
        where requested_by = ${principalId} and state <> 'complete'`;
      if (!live.length) break;
      for (const row of live) await removals.run(row.id);
      const stuck = await sql`select id, state, blocked_reason from space_removal
        where requested_by = ${principalId} and state = 'blocked'`;
      if (stuck.length) throw new Error(`removal blocked: ${JSON.stringify(stuck)}`);
    }
    await accounts.resume();
  };
  return { app, call, cookieOf, sql, owner, ownerId: ownerRow.id, person, settle, accounts };
}

const h = handle ? await harness() : null;

/** A chat in a space, with what was said and answered. */
async function chat(
  spaceId: string,
  principalId: string,
  title: string,
  said: string,
  answer: string,
) {
  if (!h) throw new Error('Postgres unavailable');
  const agentId = newId('agent');
  await h.sql`insert into agent
    (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
    values (${agentId}, ${spaceId}, 'Aide', 'assistant', 'blue', 'matte', 'grey', 'plain', 'Help.')`;
  const jobId = newId('job');
  await h.sql`insert into job (id, space_id, title, principal_id, objective, agent_id, state, kind)
    values (${jobId}, ${spaceId}, ${title}, ${principalId}, ${said}, ${agentId}, 'completed', 'chat')`;
  await h.sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, answer, status,
      author_principal_id)
    values (${newId('turn')}, ${jobId}, ${agentId}, ${recordId('sub')}, ${said}, ${answer}, 'done',
      ${principalId})`;
  return jobId;
}

withDb('taking everything along', () => {
  test('the export holds chats, files and records, and nothing secret', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const dana = await h.person('dana@example.test');
    const jobId = await chat(
      dana.spaceId,
      dana.id,
      'Dentist',
      'Book the dentist for Tuesday',
      'Booked for Tuesday at 10:00.',
    );
    const folder = join(spacesRoot, dana.spaceId);
    await mkdir(join(folder, 'artifacts'), { recursive: true });
    await mkdir(join(folder, 'knowledge'), { recursive: true });
    await mkdir(join(folder, '.git'), { recursive: true });
    await mkdir(join(folder, 'browser', 'chromium'), { recursive: true });
    const picture = crypto.getRandomValues(new Uint8Array(5_000));
    await writeFile(join(folder, 'artifacts', 'scan.png'), picture);
    await writeFile(join(folder, 'knowledge', 'dentist.md'), 'Dr. Lee, Tuesdays.');
    await writeFile(join(folder, '.git', 'config'), '[core]');
    await writeFile(join(folder, 'browser', 'chromium', 'Cookies'), 'signed-in-cookie');
    const secretId = newId('sec');
    await h.sql`insert into secret (id, space_id, ciphertext)
      values (${secretId}, ${dana.spaceId}, 'sealed-box-v1:TOP-SECRET-TOKEN')`;
    await h.sql`insert into connection (id, space_id, provider, label, secret_ref, scopes)
      values (${newId('conn')}, ${dana.spaceId}, 'email', 'Dana’s mailbox', ${secretId}, '[]'::jsonb)`;
    // Someone else's space is not in it.
    const [ownerSpace] = await h.sql<{ id: string }[]>`select id from space
      where kind = 'personal' and coalesce(owner_principal_id, ${h.ownerId}) = ${h.ownerId}`;
    if (ownerSpace) await chat(ownerSpace.id, h.ownerId, 'Owner only', 'Private plan', 'Noted.');

    const response = await h.call(dana.cookie, '/account/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="melete-export-/,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const files = unzip(bytes);
    const names = [...files.keys()];
    const space = names.find((name) => name.endsWith('/space.json'))?.replace('/space.json', '');
    if (!space) throw new Error(`no space folder in ${names.join(', ')}`);
    expect(space).toBe(`spaces/personal-${dana.spaceId}`);
    expect(files.get('README.md')?.toString()).toContain('Your Melete export');
    const account = JSON.parse(files.get('account.json')?.toString() ?? '{}');
    expect(account.account.email).toBe('dana@example.test');
    const markdown = names.find(
      (name) => name.startsWith(`${space}/chats/`) && name.endsWith('.md'),
    );
    expect(files.get(markdown ?? '')?.toString()).toContain('Book the dentist for Tuesday');
    expect(files.get(markdown ?? '')?.toString()).toContain('Booked for Tuesday at 10:00.');
    const chatJson = JSON.parse(
      files.get(markdown?.replace(/\.md$/, '.json') ?? '')?.toString() ?? '{}',
    );
    expect(chatJson.id).toBe(jobId);
    expect(chatJson.messages[0].answer).toBe('Booked for Tuesday at 10:00.');
    // The original files, byte for byte; the repository's own folder and the browser profile are not files.
    expect(files.get(`${space}/files/artifacts/scan.png`)?.equals(Buffer.from(picture))).toBe(true);
    expect(files.get(`${space}/files/knowledge/dentist.md`)?.toString()).toBe('Dr. Lee, Tuesdays.');
    expect(names.some((name) => name.includes('.git/') || name.includes('Cookies'))).toBe(false);
    // Every record of the space, one file per kind, with secrets left out.
    const jobs = JSON.parse(files.get(`${space}/records/job.json`)?.toString() ?? '[]');
    expect(jobs.map((row: { id: string }) => row.id)).toContain(jobId);
    const connections = JSON.parse(
      files.get(`${space}/records/connection.json`)?.toString() ?? '[]',
    );
    expect(connections[0].label).toBe('Dana’s mailbox');
    expect(connections[0]).not.toHaveProperty('secret_ref');
    expect(names.some((name) => name.endsWith('/records/secret.json'))).toBe(false);
    const everything = Buffer.concat([...files.values()]).toString();
    expect(everything).not.toContain('TOP-SECRET-TOKEN');
    expect(everything).not.toContain('signed-in-cookie');
    expect(everything).not.toContain('Private plan');
    expect(everything).not.toMatch(/argon2/);
    // Any unzip reads it, checksums included.
    const unzipTool = Bun.which('unzip');
    if (unzipTool) {
      const path = join(root, 'dana.zip');
      await writeFile(path, bytes);
      expect(Bun.spawnSync([unzipTool, '-t', '-q', path]).exitCode).toBe(0);
    }
  }, 60_000);
});

withDb('exporting a room one owns', () => {
  test('carries the room’s work and one’s own, never a member’s private chats or files', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const room = await seedSpace(h.sql, { kind: 'shared', name: 'Studio', spacesRoot, workRoot });
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    await h.sql`update principal set password_hash = ${hash}, email = lower(email)
      where id = ${room.principalId}`;
    const [{ email } = { email: '' }] = await h.sql<{ email: string }[]>`select email
      from principal where id = ${room.principalId}`;
    const cookie = h.cookieOf(await h.call('', '/login', 'POST', { email, password }));
    const sql = h.sql;
    /** A chat in the room by one person, with one file it saved to the room's Files. */
    const work = async (
      who: string,
      audience: 'room' | 'principal',
      said: string,
      file: string,
    ) => {
      const jobId = await chat(room.spaceId, who, said, said, 'Done.');
      await sql`update job set audience = ${audience} where id = ${jobId}`;
      await mkdir(join(spacesRoot, room.spaceId, 'artifacts'), { recursive: true });
      await writeFile(join(spacesRoot, room.spaceId, 'artifacts', file), `${file} contents`);
      await sql`insert into artifact (id, space_id, job_id, source_job_id, area, path,
          content_hash, mime, size)
        values (${newId('art')}, ${room.spaceId}, ${jobId}, ${jobId}, 'artifacts', ${file},
          ${'a'.repeat(64)}, 'text/plain', 10)`;
    };
    await work(room.memberId, 'principal', 'Member private draft', 'member-private.txt');
    await work(room.memberId, 'room', 'Shared agenda', 'room-agenda.txt');
    await work(room.principalId, 'principal', 'Owner own notes', 'owner-notes.txt');
    // A file with no record at all, as a member's computer might leave, is not taken either.
    await writeFile(join(spacesRoot, room.spaceId, 'artifacts', 'unlisted.txt'), 'unlisted');

    const response = await h.call(cookie, '/account/export');
    expect(response.status).toBe(200);
    const files = unzip(new Uint8Array(await response.arrayBuffer()));
    const names = [...files.keys()];
    const folder = `spaces/studio-${room.spaceId}`;
    expect(names).toContain(`${folder}/files/artifacts/room-agenda.txt`);
    expect(names).toContain(`${folder}/files/artifacts/owner-notes.txt`);
    expect(names).not.toContain(`${folder}/files/artifacts/member-private.txt`);
    expect(names).not.toContain(`${folder}/files/artifacts/unlisted.txt`);
    expect(names.some((name) => name.startsWith(`${folder}/files/knowledge/`))).toBe(false);
    expect(names.some((name) => name.startsWith(`${folder}/records/`))).toBe(false);
    const everything = Buffer.concat([...files.values()]).toString();
    expect(everything).toContain('Shared agenda');
    expect(everything).toContain('Owner own notes');
    expect(everything).not.toContain('Member private draft');
    expect(everything).not.toContain('member-private.txt contents');
  }, 60_000);
});

withDb('deleting an account', () => {
  test('the account that set Melete up is kept, and says what it can do instead', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const preview = accountRemovalPreview.parse(
      ((await (await h.call(h.owner, '/account/removal/preview')).json()) as { preview: unknown })
        .preview,
    );
    expect(preview.account.setup_owner).toBe(true);
    expect(preview.blocked_reason).toContain('erase everything');
    const refused = await h.call(h.owner, '/account', 'DELETE', {
      confirm_email: 'owner@example.test',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('setup_owner');
    // Nobody else may delete it either.
    const erin = await h.person('erin@example.test');
    const other = await h.call(erin.cookie, `/principals/${h.ownerId}`, 'DELETE', {
      confirm_email: 'owner@example.test',
    });
    expect(other.status).toBe(404);
    expect((await h.call(h.owner, '/account/removal/preview')).status).toBe(200);
  });

  test('deleting one’s own account ends it at once and removes every space it owns', async () => {
    if (!h) throw new Error('Postgres unavailable');
    // A room full of everything, owned by the account, with another member in it.
    const room = await seedSpace(h.sql, {
      kind: 'shared',
      name: 'The Ledger',
      spacesRoot,
      workRoot,
    });
    await seedFiles(spacesRoot, workRoot, room.spaceId, room.jobId);
    const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    await h.sql`update principal set password_hash = ${hash}, email = lower(email)
      where id = ${room.principalId}`;
    const [{ email } = { email: '' }] = await h.sql<{ email: string }[]>`select email
      from principal where id = ${room.principalId}`;
    const cookie = h.cookieOf(await h.call('', '/login', 'POST', { email, password }));

    const preview = accountRemovalPreview.parse(
      ((await (await h.call(cookie, '/account/removal/preview')).json()) as { preview: unknown })
        .preview,
    );
    expect(preview.blocked_reason).toBeNull();
    expect(preview.confirm).toBe(email);
    expect(preview.spaces.map((space) => [space.name, space.kind])).toContainEqual([
      'The Ledger',
      'room',
    ]);
    // The wrong email deletes nothing.
    expect(
      (await h.call(cookie, '/account', 'DELETE', { confirm_email: 'nope@example.test' })).status,
    ).toBe(400);
    expect((await h.call(cookie, '/account/removal/preview')).status).toBe(200);

    const deleted = await h.call(cookie, '/account', 'DELETE', {
      confirm_email: email.toUpperCase(),
    });
    expect(deleted.status).toBe(202);
    expect(deleted.headers.get('set-cookie')).toContain('melete_session=;');
    const removal = accountRemoval.parse(((await deleted.json()) as { removal: unknown }).removal);
    expect(removal.spaces.map((space) => space.space_id)).toContain(room.spaceId);
    // At once: no session, no sign-in, and the email is free again.
    expect((await h.call(cookie, '/account/removal/preview')).status).toBe(401);
    expect((await h.call('', '/login', 'POST', { email, password })).status).toBe(401);
    const [wiped] = await h.sql`select email, password_hash, passkey from principal
      where id = ${room.principalId}`;
    expect(wiped?.email).toBe(removedEmail(room.principalId));
    expect(wiped?.password_hash).toBeNull();
    expect(
      await h.sql`select 1 from session where principal_id = ${room.principalId}`,
    ).toHaveLength(0);

    await h.settle(room.principalId);
    // Every space it owned is gone, folders and all, and so is its row.
    expect(await h.sql`select 1 from space where id = ${room.spaceId}`).toHaveLength(0);
    expect(await h.sql`select 1 from secret where id = ${room.secretId}`).toHaveLength(0);
    expect(await there(join(spacesRoot, room.spaceId))).toBe(false);
    expect(await h.sql`select 1 from principal where id = ${room.principalId}`).toHaveLength(0);
    // The address can make a new account.
    expect((await h.call(h.owner, '/principals', 'POST', { email, password })).status).toBe(201);
  }, 120_000);

  test('the setup owner lists the accounts and deletes one it made; nobody else may', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const fran = await h.person('fran@example.test');
    const gil = await h.person('gil@example.test');
    await chat(fran.spaceId, fran.id, 'Groceries', 'Order oat milk', 'Ordered.');
    await mkdir(join(spacesRoot, fran.spaceId, 'artifacts'), { recursive: true });
    await writeFile(join(spacesRoot, fran.spaceId, 'artifacts', 'list.txt'), 'oat milk');
    expect((await h.call(gil.cookie, '/principals')).status).toBe(403);
    expect(
      (
        await h.call(gil.cookie, `/principals/${fran.id}`, 'DELETE', {
          confirm_email: 'fran@example.test',
        })
      ).status,
    ).toBe(404);
    const listed = accountList.parse(await (await h.call(h.owner, '/principals')).json());
    const entry = listed.accounts.find((account) => account.id === fran.id);
    expect(entry).toMatchObject({
      email: 'fran@example.test',
      state: 'active',
      setup_owner: false,
    });
    expect(listed.accounts.find((account) => account.id === h.ownerId)?.setup_owner).toBe(true);

    const preview = accountRemovalPreview.parse(
      (
        (await (await h.call(h.owner, `/principals/${fran.id}/removal/preview`)).json()) as {
          preview: unknown;
        }
      ).preview,
    );
    expect(preview.spaces).toEqual([
      expect.objectContaining({ id: fran.spaceId, kind: 'personal', chats: 1 }),
    ]);
    const started = await h.call(h.owner, `/principals/${fran.id}`, 'DELETE', {
      confirm_email: 'fran@example.test',
    });
    expect(started.status).toBe(202);
    // The owner keeps its own session.
    expect(started.headers.get('set-cookie')).toBeNull();
    expect((await h.call(fran.cookie, '/account/removal/preview')).status).toBe(401);
    const during = accountList.parse(await (await h.call(h.owner, '/principals')).json());
    expect(during.accounts.find((account) => account.id === fran.id)?.state).toBe('removing');

    await h.settle(fran.id);
    expect(logged).toEqual([]);
    const after = await h.call(h.owner, `/principals/${fran.id}/removal`);
    expect(accountRemoval.parse(((await after.json()) as { removal: unknown }).removal).state).toBe(
      'removed',
    );
    expect(await there(join(spacesRoot, fran.spaceId))).toBe(false);
    expect(await h.sql`select 1 from job where space_id = ${fran.spaceId}`).toHaveLength(0);
    expect(await h.sql`select 1 from principal where id = ${fran.id}`).toHaveLength(0);
    const finally_ = accountList.parse(await (await h.call(h.owner, '/principals')).json());
    expect(finally_.accounts.some((account) => account.id === fran.id)).toBe(false);
    // Gil, who was not asked about, is untouched.
    expect((await h.call(gil.cookie, '/account/removal/preview')).status).toBe(200);
  }, 120_000);

  test('an account leaves rooms others own; what it wrote there keeps an empty row to name', async () => {
    if (!h) throw new Error('Postgres unavailable');
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
    const [{ email } = { email: '' }] = await h.sql<{ email: string }[]>`select email
      from principal where id = ${room.memberId}`;
    const started = await h.call(h.owner, `/principals/${room.memberId}`, 'DELETE', {
      confirm_email: email,
    });
    expect(started.status).toBe(202);
    await h.settle(room.memberId);
    // The room and its owner are untouched; the member is no longer in it.
    expect(await h.sql`select 1 from space where id = ${room.spaceId}`).toHaveLength(1);
    const [membership] = await h.sql`select revoked_at from space_membership
      where space_id = ${room.spaceId} and principal_id = ${room.memberId}`;
    expect(membership?.revoked_at ?? 'gone').not.toBeNull();
    // Its row stays only to name what it wrote there, with nothing of the person in it.
    const [left] = await h.sql`select email, password_hash, passkey, display_name from principal
      where id = ${room.memberId}`;
    expect(left).toEqual({
      email: removedEmail(room.memberId),
      password_hash: null,
      passkey: null,
      display_name: null,
    });
    expect(await h.sql`select 1 from mcp_token where principal_id = ${room.memberId}`).toHaveLength(
      0,
    );
    expect(await h.sql`select 1 from session where principal_id = ${room.memberId}`).toHaveLength(
      0,
    );
    const listed = accountList.parse(await (await h.call(h.owner, '/principals')).json());
    expect(listed.accounts.some((account) => account.id === room.memberId)).toBe(false);
  }, 120_000);
});
