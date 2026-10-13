/**
 * The operator console against Postgres: the installation's owner runs the
 * Melete from the web app as the operator's command does on the host.
 *
 * - Every `/operator` route answers the owner alone: 401 signed out, and to a
 *   disabled or deleted account; 403 to anyone else, guests included.
 * - An invite is the operator command's account and link, always handed back
 *   to copy, and mailed as well when account mail is set.
 * - A person's own caps stay inside the installation's, and the spending
 *   guard holds them to those caps.
 * - Disabling signs a person out of every session at once.
 * - Every change is recorded, with no link or code in the record.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  operatorAudit,
  operatorInviteResponse,
  operatorOverview,
  operatorPeople,
  operatorPersonResponse,
  operatorResetResponse,
} from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { createAccount } from '../../src/account/cli.ts';
import { AccountRemovalService } from '../../src/account/removal.ts';
import { loadEnv } from '../../src/env.ts';
import type { AccountMail, AccountMailer } from '../../src/experience/account-mail.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { spendingFromEnv } from '../../src/gateway/spending.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { backupNoteStatement } from '../../src/operator/backup-note.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { SpaceRemovalService } from '../../src/spaces/removal.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-operator-'));
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
const ownerEmail = 'owner@example.test';

function database() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

/** The installation's caps the tests edit within. */
const CAPS = {
  MELETE_SPEND_MONTHLY_USD: '100',
  MELETE_SPEND_DAILY_USD: '10',
  MELETE_SPEND_PERSON_MONTHLY_USD: '20',
  MELETE_SPEND_PERSON_DAILY_USD: '5',
  MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD: '8',
  MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD: '2',
};

type Options = {
  mailer?: AccountMailer;
  publicUrl?: string | null;
  multiplayer?: boolean;
};

async function harness(options: Options = {}) {
  const { db, sql } = database();
  const journal = new FileRestrictionJournal(
    join(root, `journal-${randomBytes(4).toString('hex')}.jsonl`),
  );
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
    log: () => {},
    removeChats: (ids) => removeJobs({ jobs, sql }, ids),
  });
  const env = loadEnv({
    NODE_ENV: 'test',
    MELETE_SPACES_DIR: spacesRoot,
    MELETE_WORK_DIR: workRoot,
    // The first visitor sets up the owner, as on a machine of one's own.
    MELETE_SETUP_OPEN: 'true',
    ...(options.publicUrl === null
      ? {}
      : { MELETE_PUBLIC_URL: options.publicUrl ?? 'https://melete.test' }),
    ...(options.multiplayer ? { MELETE_PREVIEW_MULTIPLAYER: 'true' } : {}),
    ...CAPS,
  });
  const spending = spendingFromEnv(sql, env);
  const app = createApp({
    db,
    sql,
    env,
    checkDatabase: async () => 'ok',
    jobs,
    removals,
    accountRemovals: accounts,
    spending,
    // No account mail unless a test gives one: the environment sets none.
    ...(options.mailer ? { accountMail: options.mailer } : {}),
  });
  const call = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const cookieOf = (response: Response) => {
    const value = response.headers.get('set-cookie')?.split(';')[0];
    if (!value) throw new Error(`no session (${response.status})`);
    return value;
  };
  const made = { app, call, cookieOf, sql, spending, accounts, removals, jobs };
  harnesses.push(made);
  return made;
}

/** Each test's harnesses, whose space removals finish before the next test resets the rows. */
const harnesses: { removals: SpaceRemovalService }[] = [];

type Harness = Awaited<ReturnType<typeof harness>>;

/** The owner, signed in. */
async function setUp(h: Harness) {
  const owner = h.cookieOf(await h.call('', '/setup', 'POST', { email: ownerEmail, password }));
  const [row] = await h.sql<{ id: string }[]>`select id from owner limit 1`;
  if (!row) throw new Error('no owner');
  return { owner, ownerId: row.id };
}

/** Someone the owner made, with a password, signed in. */
async function person(h: Harness, owner: string, email: string) {
  const made = await h.call(owner, '/principals', 'POST', { email, password });
  expect(made.status).toBe(201);
  const { principal } = (await made.json()) as { principal: { id: string } };
  const cookie = h.cookieOf(await h.call('', '/login', 'POST', { email, password }));
  return { id: principal.id, cookie };
}

/** A session for an account written straight to the table, as a guest's would be. */
async function sessionFor(h: Harness, principalId: string, ownerId: string) {
  const token = randomBytes(32).toString('base64url');
  await h.sql`insert into session (token_hash, principal_id, owner_id, expires_at)
    values (${createHash('sha256').update(token).digest('hex')}, ${principalId}, ${ownerId},
      now() + interval '1 day')`;
  return `melete_session=${token}`;
}

const errorCode = async (response: Response) =>
  ((await response.json()) as { error?: { code?: string } }).error?.code;

/** Every operator route the app serves, with an id filled in and a body where one is read. */
function operatorRoutes(h: Harness, id: string) {
  return h.app.routes
    .filter((route) => route.path.startsWith('/operator/') && route.method !== 'ALL')
    .map((route) => ({
      method: route.method,
      path: route.path.replace(':id', id),
      body: ['POST', 'PUT', 'DELETE'].includes(route.method)
        ? route.path.endsWith('/caps')
          ? { day_usd: null, month_usd: null, background_day_usd: null, background_month_usd: null }
          : route.method === 'DELETE'
            ? { confirm_email: 'nobody@example.test' }
            : route.path === '/operator/people'
              ? { email: 'never-made@example.test' }
              : {}
        : undefined,
    }));
}

withDb('the operator console', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
    // Spending is kept by person id, outside the rows a reset follows.
    await database().sql`delete from model_usage`;
  }, 15_000);
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((made) => made.removals.drain()));
  }, 30_000);

  test('every operator route is documented and answers only the owner', async () => {
    const h = await harness({ multiplayer: true });
    const { owner, ownerId } = await setUp(h);
    const member = await person(h, owner, 'member@example.test');
    const disabled = await person(h, owner, 'disabled@example.test');
    const removed = await person(h, owner, 'removed@example.test');
    // A guest, as a room invite makes one.
    const guestId = `own_${'0'.repeat(26)}`;
    await h.sql`insert into principal (id, email, kind) values (${guestId}, 'guest@example.test', 'guest')`;
    const guest = await sessionFor(h, guestId, ownerId);
    expect(
      (await h.call(owner, `/operator/people/${disabled.id}/disable`, 'POST', {})).status,
    ).toBe(200);
    const gone = await h.call(owner, `/operator/people/${removed.id}`, 'DELETE', {
      confirm_email: 'removed@example.test',
    });
    expect(gone.status).toBe(202);

    const routes = operatorRoutes(h, member.id);
    // Nine routes, each in the published document.
    expect(
      routes.map((route) => `${route.method} ${route.path.replace(member.id, '{id}')}`).sort(),
    ).toEqual([
      'DELETE /operator/people/{id}',
      'GET /operator/audit',
      'GET /operator/overview',
      'GET /operator/people',
      'GET /operator/people/{id}/removal/preview',
      'POST /operator/people',
      'POST /operator/people/{id}/disable',
      'POST /operator/people/{id}/enable',
      'POST /operator/people/{id}/password-reset',
      'PUT /operator/people/{id}/caps',
    ]);
    const before = await h.sql`select count(*)::int as n from event`;
    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      expect([label, (await h.call('', route.path, route.method, route.body)).status]).toEqual([
        label,
        401,
      ]);
      expect([
        label,
        (await h.call(disabled.cookie, route.path, route.method, route.body)).status,
      ]).toEqual([label, 401]);
      expect([
        label,
        (await h.call(removed.cookie, route.path, route.method, route.body)).status,
      ]).toEqual([label, 401]);
      const asMember = await h.call(member.cookie, route.path, route.method, route.body);
      expect([label, asMember.status, await errorCode(asMember)]).toEqual([
        label,
        403,
        'owner_required',
      ]);
      const asGuest = await h.call(guest, route.path, route.method, route.body);
      expect([label, asGuest.status, await errorCode(asGuest)]).toEqual([
        label,
        403,
        'guests_use_rooms',
      ]);
    }
    // Nothing anyone else tried changed anything or was recorded.
    expect((await h.sql`select count(*)::int as n from event`)[0]?.n).toBe(before[0]?.n);
    const [still] = await h.sql`select disabled_at from principal where id = ${member.id}`;
    expect(still?.disabled_at).toBeNull();
    expect(
      await h.sql`select 1 from principal where email = 'never-made@example.test'`,
    ).toHaveLength(0);

    // The owner reaches each one.
    expect((await h.call(owner, '/operator/overview')).status).toBe(200);
    expect((await h.call(owner, '/operator/people')).status).toBe(200);
    expect((await h.call(owner, '/operator/audit')).status).toBe(200);
    expect((await h.call(owner, `/operator/people/${member.id}/removal/preview`)).status).toBe(200);
  });

  test('without rooms switched on, a guest is signed out of the console as of everything', async () => {
    const h = await harness();
    const { owner, ownerId } = await setUp(h);
    const guestId = `own_${'1'.repeat(26)}`;
    await h.sql`insert into principal (id, email, kind) values (${guestId}, 'guest@example.test', 'guest')`;
    const guest = await sessionFor(h, guestId, ownerId);
    for (const route of operatorRoutes(h, guestId))
      expect((await h.call(guest, route.path, route.method, route.body)).status).toBe(401);
    expect((await h.call(owner, '/operator/people')).status).toBe(200);
  });

  test('an invite without account mail hands back a link to pass on, which opens as an invite', async () => {
    const h = await harness();
    const { owner } = await setUp(h);
    const answered = await h.call(owner, '/operator/people', 'POST', { email: 'New@Example.test' });
    expect(answered.status).toBe(201);
    const { person: made, invite } = operatorInviteResponse.parse(await answered.json());
    expect(made.email).toBe('new@example.test');
    expect(made.status).toBe('invited');
    expect(invite.purpose).toBe('invite');
    expect(invite.emailed).toBe(false);
    expect(invite.link).toStartWith('https://melete.test/#/reset?token=');
    expect(invite.link).toContain(invite.code);
    const days = (new Date(invite.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const check = await h.call('', '/password-reset/check', 'POST', { token: invite.code });
    expect(await check.json()).toEqual({ status: 'ok', purpose: 'invite' });
    // Choosing a password signs the new person straight in.
    const consumed = await h.call('', '/password-reset/consume', 'POST', {
      token: invite.code,
      new_password: 'their-own-password-1',
    });
    expect(((await consumed.json()) as { signed_in: boolean }).signed_in).toBe(true);
    const people = operatorPeople.parse(await (await h.call(owner, '/operator/people')).json());
    expect(people.can_email).toBe(false);
    expect(people.people.find((entry) => entry.id === made.id)?.status).toBe('active');

    // The same email twice, or no email at all, is refused and makes nothing.
    const again = await h.call(owner, '/operator/people', 'POST', { email: 'new@example.test' });
    expect([again.status, await errorCode(again)]).toEqual([409, 'account_exists']);
    expect(
      (await h.call(owner, '/operator/people', 'POST', { email: 'not an email' })).status,
    ).toBe(400);
    expect(await h.sql`select 1 from principal where email = 'not an email'`).toHaveLength(0);
  });

  test('with no web address the invite is a code for the sign-in page', async () => {
    const h = await harness({ publicUrl: null });
    const { owner } = await setUp(h);
    const answered = await h.call(owner, '/operator/people', 'POST', {
      email: 'code@example.test',
    });
    const { invite } = operatorInviteResponse.parse(await answered.json());
    expect(invite.link).toBeNull();
    expect(invite.emailed).toBe(false);
    expect(invite.mail_problem).toBeNull();
    expect(invite.code.length).toBeGreaterThan(20);
  });

  test('with account mail the invite is mailed, and the same link is handed back', async () => {
    const sent: AccountMail[] = [];
    const h = await harness({ mailer: { send: async (mail) => void sent.push(mail) } });
    const { owner } = await setUp(h);
    const answered = await h.call(owner, '/operator/people', 'POST', {
      email: 'mailed@example.test',
    });
    const { invite } = operatorInviteResponse.parse(await answered.json());
    expect(invite.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('mailed@example.test');
    expect(sent[0]?.subject).toBe('You’re invited to Melete');
    expect(sent[0]?.text).toContain(`${ownerEmail} made you a Melete account`);
    expect(sent[0]?.text).toContain(invite.link ?? 'no link');
    expect(sent[0]?.text).toContain('expires in 7 days');
    expect(
      operatorPeople.parse(await (await h.call(owner, '/operator/people')).json()).can_email,
    ).toBe(true);
  });

  test('when the mail does not go out, the link still works and the owner is told', async () => {
    const h = await harness({
      mailer: { send: async () => Promise.reject(new Error('451 try again later')) },
    });
    const { owner } = await setUp(h);
    const answered = await h.call(owner, '/operator/people', 'POST', {
      email: 'later@example.test',
    });
    expect(answered.status).toBe(201);
    const { invite } = operatorInviteResponse.parse(await answered.json());
    expect(invite.emailed).toBe(false);
    expect(invite.mail_problem).toContain('451 try again later');
    const check = await h.call('', '/password-reset/check', 'POST', { token: invite.code });
    expect(check.status).toBe(200);
  });

  test('a new link is the invite again until a password is chosen, then a reset', async () => {
    const sent: AccountMail[] = [];
    const h = await harness({ mailer: { send: async (mail) => void sent.push(mail) } });
    const { owner } = await setUp(h);
    const first = operatorInviteResponse.parse(
      await (
        await h.call(owner, '/operator/people', 'POST', { email: 'slow@example.test' })
      ).json(),
    );
    const resent = operatorResetResponse.parse(
      await (
        await h.call(owner, `/operator/people/${first.person.id}/password-reset`, 'POST', {})
      ).json(),
    );
    expect(resent.reset.purpose).toBe('invite');
    // Only the newest invite opens.
    expect(
      (await h.call('', '/password-reset/check', 'POST', { token: first.invite.code })).status,
    ).toBe(400);
    expect(
      await (
        await h.call('', '/password-reset/check', 'POST', { token: resent.reset.code })
      ).json(),
    ).toEqual({ status: 'ok', purpose: 'invite' });

    const active = await person(h, owner, 'active@example.test');
    const reset = operatorResetResponse.parse(
      await (
        await h.call(owner, `/operator/people/${active.id}/password-reset`, 'POST', {})
      ).json(),
    );
    expect(reset.reset.purpose).toBe('reset');
    expect(reset.reset.emailed).toBe(true);
    const minutes = (new Date(reset.reset.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);
    expect(sent.at(-1)?.subject).toBe('Reset your Melete password');
    expect(sent.at(-1)?.text).toContain(reset.reset.link ?? 'no link');
    // Their session lasts until the link is used.
    expect((await h.call(active.cookie, '/me')).status).toBe(200);

    expect((await h.call(owner, `/operator/people/${active.id}/disable`, 'POST', {})).status).toBe(
      200,
    );
    const refused = await h.call(owner, `/operator/people/${active.id}/password-reset`, 'POST', {});
    expect([refused.status, await errorCode(refused)]).toEqual([409, 'account_disabled']);
  });

  test('disabling signs a person out of every session at once, and enabling lets them back', async () => {
    const h = await harness();
    const { owner, ownerId } = await setUp(h);
    const someone = await person(h, owner, 'someone@example.test');
    const elsewhere = h.cookieOf(
      await h.call('', '/login', 'POST', { email: 'someone@example.test', password }),
    );
    expect((await h.call(someone.cookie, '/me')).status).toBe(200);
    expect((await h.call(elsewhere, '/me')).status).toBe(200);

    const done = await h.call(owner, `/operator/people/${someone.id}/disable`, 'POST', {});
    expect(done.status).toBe(200);
    const { person: off } = operatorPersonResponse.parse(await done.json());
    expect(off.status).toBe('disabled');
    expect(off.sessions).toBe(0);
    expect((await h.call(someone.cookie, '/me')).status).toBe(401);
    expect((await h.call(elsewhere, '/me')).status).toBe(401);
    expect(
      await h.sql`select 1 from session where coalesce(principal_id, owner_id) = ${someone.id}`,
    ).toHaveLength(0);
    expect(
      (await h.call('', '/login', 'POST', { email: 'someone@example.test', password })).status,
    ).toBe(401);

    const back = await h.call(owner, `/operator/people/${someone.id}/enable`, 'POST', {});
    expect(operatorPersonResponse.parse(await back.json()).person.status).toBe('active');
    expect(
      (await h.call('', '/login', 'POST', { email: 'someone@example.test', password })).status,
    ).toBe(200);

    // The owner's own account runs the installation, and stays on.
    const self = await h.call(owner, `/operator/people/${ownerId}/disable`, 'POST', {});
    expect([self.status, await errorCode(self)]).toEqual([409, 'owner_kept']);
    expect((await h.call(owner, '/me')).status).toBe(200);
  });

  test('own caps stay within the installation’s, and clearing one restores its cap', async () => {
    const h = await harness();
    const { owner } = await setUp(h);
    const someone = await person(h, owner, 'capped@example.test');
    const put = (caps: Record<string, number | null>) =>
      h.call(owner, `/operator/people/${someone.id}/caps`, 'PUT', {
        day_usd: null,
        month_usd: null,
        background_day_usd: null,
        background_month_usd: null,
        ...caps,
      });
    const refused = async (caps: Record<string, number | null>, words: string) => {
      const answer = await put(caps);
      const body = (await answer.json()) as { error: { code: string; message: string } };
      expect([JSON.stringify(caps), answer.status, body.error.code]).toEqual([
        JSON.stringify(caps),
        400,
        'caps_out_of_range',
      ]);
      expect(body.error.message).toContain(words);
    };
    // At the installation's own caps exactly: allowed.
    expect((await put({ month_usd: 100, day_usd: 10 })).status).toBe(200);
    // A cent past either is not.
    await refused({ month_usd: 100.01 }, "installation's monthly cap of $100.00");
    await refused({ day_usd: 10.01 }, "installation's daily cap of $10.00");
    await refused({ month_usd: 0 }, 'more than $0');
    await refused({ day_usd: -1 }, 'more than $0');
    await refused({ month_usd: 12.345 }, 'whole cents');
    // A day past the month that holds for them: theirs, or the installation's $20.
    await refused({ day_usd: 9, month_usd: 8 }, 'more than the monthly cap of $8.00');
    await refused({ day_usd: 6, background_day_usd: 7 }, 'more than the daily cap of $6.00');
    await refused({ background_month_usd: 25 }, 'more than the monthly cap of $20.00');
    await refused({ background_day_usd: 3, background_month_usd: 2.5 }, 'monthly background cap');

    const set = await put({ month_usd: 50, day_usd: 6.5, background_month_usd: 12.25 });
    expect(set.status).toBe(200);
    const { person: capped } = operatorPersonResponse.parse(await set.json());
    expect(capped.caps.own).toEqual({
      day_usd: 6.5,
      month_usd: 50,
      background_day_usd: null,
      background_month_usd: 12.25,
    });
    expect(capped.caps.effective).toEqual({
      day_usd: 6.5,
      month_usd: 50,
      background_day_usd: 2,
      background_month_usd: 12.25,
    });
    // The person's own usage page shows their caps too.
    const usage = (await (await h.call(someone.cookie, '/usage')).json()) as {
      limits: { person: { month: { usd: number } } };
    };
    expect(usage.limits.person.month.usd).toBe(50);

    const cleared = operatorPersonResponse.parse(await (await put({})).json());
    expect(cleared.person.caps.own).toEqual({
      day_usd: null,
      month_usd: null,
      background_day_usd: null,
      background_month_usd: null,
    });
    expect(cleared.person.caps.effective).toEqual({
      day_usd: 5,
      month_usd: 20,
      background_day_usd: 2,
      background_month_usd: 8,
    });
    expect(
      await h.sql`select 1 from person_spend_limit where principal_id = ${someone.id}`,
    ).toHaveLength(0);
  });

  test('the spending guard holds a person to the caps the owner gave them', async () => {
    const h = await harness();
    const { owner } = await setUp(h);
    const someone = await person(h, owner, 'spender@example.test');
    const other = await person(h, owner, 'other@example.test');
    await h.sql`insert into model_usage (id, principal_id, purpose, provider, model, status, cost_usd)
      values (${randomBytes(8).toString('hex')}, ${someone.id}, 'agent', 'anthropic', 'claude', 'ok', 3),
        (${randomBytes(8).toString('hex')}, ${other.id}, 'agent', 'anthropic', 'claude', 'ok', 3)`;
    // Under the installation's $5 a day, both may go on.
    expect(await h.spending.reached(someone.id)).toBeNull();
    const put = await h.call(owner, `/operator/people/${someone.id}/caps`, 'PUT', {
      day_usd: 2.5,
      month_usd: null,
      background_day_usd: null,
      background_month_usd: null,
    });
    expect(put.status).toBe(200);
    expect(await h.spending.reached(someone.id)).toContain("Today's limit is reached");
    expect(await h.spending.reached(other.id)).toBeNull();
    // The list shows what they spent against it.
    const people = operatorPeople.parse(await (await h.call(owner, '/operator/people')).json());
    const listed = people.people.find((entry) => entry.id === someone.id);
    expect(listed?.spend).toEqual({ day_usd: 3, month_usd: 3, background_month_usd: 0 });
    expect(listed?.caps.effective.day_usd).toBe(2.5);
    expect(people.installation).toEqual({ day_usd: 10, month_usd: 100 });
  });

  test('removing someone takes the email typed out, and is recorded', async () => {
    const h = await harness();
    const { owner } = await setUp(h);
    const leaving = await person(h, owner, 'leaving@example.test');
    const wrong = await h.call(owner, `/operator/people/${leaving.id}`, 'DELETE', {
      confirm_email: 'someone-else@example.test',
    });
    expect([wrong.status, await errorCode(wrong)]).toEqual([400, 'confirmation_mismatch']);
    expect((await h.call(leaving.cookie, '/me')).status).toBe(200);
    const done = await h.call(owner, `/operator/people/${leaving.id}`, 'DELETE', {
      confirm_email: 'LEAVING@example.test',
    });
    expect(done.status).toBe(202);
    expect((await h.call(leaving.cookie, '/me')).status).toBe(401);
    const people = operatorPeople.parse(await (await h.call(owner, '/operator/people')).json());
    const listed = people.people.find((entry) => entry.id === leaving.id);
    expect(listed === undefined || listed.status === 'removing').toBe(true);
    // Being deleted, it can't be changed any more.
    const late = await h.call(owner, `/operator/people/${leaving.id}/enable`, 'POST', {});
    expect(late.status).toBe(404);
  });

  test('every change is recorded with who did it, and never a link or code', async () => {
    const h = await harness({ mailer: { send: async () => {} } });
    const { owner, ownerId } = await setUp(h);
    const invited = operatorInviteResponse.parse(
      await (
        await h.call(owner, '/operator/people', 'POST', { email: 'audit@example.test' })
      ).json(),
    );
    const id = invited.person.id;
    const reset = operatorResetResponse.parse(
      await (await h.call(owner, `/operator/people/${id}/password-reset`, 'POST', {})).json(),
    );
    await h.call(owner, `/operator/people/${id}/caps`, 'PUT', {
      day_usd: 3,
      month_usd: null,
      background_day_usd: null,
      background_month_usd: null,
    });
    // Setting the same caps again changes nothing, and adds nothing.
    await h.call(owner, `/operator/people/${id}/caps`, 'PUT', {
      day_usd: 3,
      month_usd: null,
      background_day_usd: null,
      background_month_usd: null,
    });
    await h.call(owner, `/operator/people/${id}/disable`, 'POST', {});
    await h.call(owner, `/operator/people/${id}/disable`, 'POST', {});
    await h.call(owner, `/operator/people/${id}/enable`, 'POST', {});
    await h.call(owner, `/operator/people/${id}`, 'DELETE', {
      confirm_email: 'audit@example.test',
    });
    // The operator's command on the host is recorded too, as the command.
    const made = await createAccount(h.sql, 'host@example.test', 'https://melete.test');
    expect(made.ok).toBe(true);

    const { entries } = operatorAudit.parse(await (await h.call(owner, '/operator/audit')).json());
    expect(entries.map((entry) => entry.action)).toEqual([
      'invited',
      'removed',
      'enabled',
      'disabled',
      'caps_changed',
      'invite_resent',
      'invited',
    ]);
    const [host, ...web] = entries;
    expect(host?.actor).toEqual({ id: null, email: null });
    expect(host?.target.email).toBe('host@example.test');
    for (const entry of web) {
      expect(entry.actor).toEqual({ id: ownerId, email: ownerEmail });
      expect(entry.target).toEqual({ id, email: 'audit@example.test' });
      expect(Date.now() - new Date(entry.at).getTime()).toBeLessThan(60_000);
    }
    expect(web.find((entry) => entry.action === 'caps_changed')?.detail).toBe(
      'Daily cap: the installation’s → $3.00',
    );
    const stored = JSON.stringify(
      await h.sql`select payload from event where payload->>'kind' = 'operator_action'`,
    );
    for (const secret of [invited.invite.code, reset.reset.code, 'https://', '/reset?token='])
      expect(stored).not.toContain(secret);
    // The record is the owner's alone: no conversation shows it.
    expect(
      await h.sql`select 1 from event where payload->>'kind' = 'operator_action' and job_id is not null`,
    ).toHaveLength(0);
  });

  test('the overview reads the installation as it is now', async () => {
    const h = await harness();
    const { owner } = await setUp(h);
    const someone = await person(h, owner, 'busy@example.test');
    await h.call(owner, '/operator/people', 'POST', { email: 'pending@example.test' });
    const off = await person(h, owner, 'off@example.test');
    await h.call(owner, `/operator/people/${off.id}/disable`, 'POST', {});
    await h.sql`insert into model_usage (id, principal_id, purpose, provider, model, status, cost_usd, created_at)
      values (${randomBytes(8).toString('hex')}, ${someone.id}, 'agent', 'anthropic', 'claude', 'ok', 4.5, now())`;
    const empty = operatorOverview.parse(await (await h.call(owner, '/operator/overview')).json());
    expect(empty.backup.newest_at).toBeNull();
    expect(empty.backup.max_age_hours).toBe(26);
    // The backup command leaves its note where the service reads it.
    await h.sql.unsafe(
      backupNoteStatement('melete-20261002T100000Z', new Date('2026-10-02T10:00:00Z')),
    );
    const overview = operatorOverview.parse(
      await (await h.call(owner, '/operator/overview')).json(),
    );
    expect(overview.backup.newest_at).toBe('2026-10-02T10:00:00.000Z');
    expect(overview.spend.month_usd).toBe(4.5);
    expect(overview.spend.day_usd).toBe(4.5);
    expect(overview.spend.month_cap_usd).toBe(100);
    expect(overview.spend.day_cap_usd).toBe(10);
    expect(overview.people).toEqual({ total: 4, active: 2, invited: 1, disabled: 1 });
    expect(overview.runs).toEqual({ used: 0, limit: 4, per_person: null });
    expect(overview.computers).toEqual({ used: 0, limit: 4, per_person: null });
    expect(overview.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(overview.health.checks.find((check) => check.name === 'database')?.ok).toBe(true);
  });
});
