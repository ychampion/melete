/**
 * Saved sign-ins against a real database: sealed at rest under the installation's key, listed
 * with the password masked, kept to their own person and space, refused when the key or the
 * sealed record is wrong, gone for good on delete and account removal, and never carried by a
 * route, a row, a receipt, a tool result, an error or a line of chat.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Action, HandOffReason, JsonObject } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import {
  OWN_WORK_ONLY,
  prepareSignIn,
  runSignIn,
  signInAsksFirst,
  validateSignIn,
} from '../../src/connectors/browser-sign-in.ts';
import { sweepUnreferencedSecrets } from '../../src/connectors/revocation.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import {
  exportSavedSignIns,
  forgetSavedSignIns,
  SignInVault,
  VaultFault,
} from '../../src/connectors/sign-in-vault.ts';
import { currentCode, parseTotpInput } from '../../src/connectors/totp.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { stepAsk } from '../../src/experience/projectors.ts';
import { actionCall, actionPhrase } from '../../src/experience/tools.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import type { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import { BrowserFault } from '../../src/workers/browser/sessions.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const KEY = randomBytes(32).toString('hex');
const NEW_KEY = randomBytes(32).toString('hex');
const LOGIN = 'a-long-enough-password';
const USERNAME = 'jo.rivera@example.com';
const PASSWORD = 'Planted-pässword-7f3a91';
const CODE_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODE_LINK = `otpauth://totp/Example:jo?secret=${CODE_SECRET}&issuer=Example&digits=6&period=30`;
const TOTP = parseTotpInput(CODE_SECRET);
/** Everything that must never leave the vault, the username included where it is masked. */
const SECRETS = [PASSWORD, CODE_SECRET, CODE_SECRET.toLowerCase()];

function handle() {
  if (!database) throw new Error('Postgres unavailable');
  return database;
}

const vaultUnder = (key: string | undefined) =>
  new SignInVault(
    handle().sql,
    new SealedSecretStore(new PostgresSecretRepository(handle().sql), () => key),
  );

/** Neither a planted secret nor the code it makes now is anywhere in `value`. */
function holdsNoSecret(value: unknown, extra: string[] = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [...SECRETS, currentCode(TOTP).code, ...extra])
    expect([secret, text.includes(secret)]).toEqual([secret, false]);
}

/** The words a promise was refused with. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

async function refusal(promise: Promise<unknown>): Promise<VaultFault> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultFault) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const suite = database ? describe : describe.skip;

suite('saved sign-ins', () => {
  let app: ReturnType<typeof createApp>;
  let cookie = '';
  let memberCookie = '';
  let ownerId = '';
  let memberId = '';
  let spaceId = '';
  let otherSpaceId = '';
  let jobId = '';
  let connectionId = '';

  const sessionCookie = (response: Response) => {
    const value = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session='));
    if (!value) throw new Error(`expected a session cookie (${response.status})`);
    return value;
  };
  const call = async (
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {},
  ) => {
    const response = await app.request(path, {
      method: options.method ?? 'GET',
      headers: {
        Cookie: options.cookie ?? cookie,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  const save = (body: Record<string, unknown>, as = cookie) =>
    call('/sign-ins', { method: 'POST', body, cookie: as });
  const secretRow = async (ref: string) =>
    (await handle().sql`select ciphertext from secret where id = ${ref}`)[0]?.ciphertext as
      | string
      | undefined;
  const rowOf = async (id: string) =>
    (await handle().sql`select * from saved_sign_in where id = ${id}`)[0] as
      | Record<string, unknown>
      | undefined;

  beforeAll(async () => {
    const { sql, db } = handle();
    app = createApp({
      db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: KEY }),
      sql,
      checkDatabase: async () => 'ok',
    });
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: LOGIN }),
    });
    expect(setup.status).toBe(201);
    cookie = sessionCookie(setup);
    ownerId = (await call('/me')).body.owner.id;
    expect(
      (
        await call('/principals', {
          method: 'POST',
          body: { email: 'member@example.test', password: LOGIN },
        })
      ).status,
    ).toBe(201);
    const signedIn = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', password: LOGIN }),
    });
    memberCookie = sessionCookie(signedIn);
    memberId = (await call('/me', { cookie: memberCookie })).body.owner.id;

    // A space both people work in, owned by the first; its job is the owner's work.
    const seeded = await seedJob(sql, { provider: 'web', scopes: ['browser.sign_in'] });
    spaceId = seeded.claims.space_id;
    jobId = seeded.claims.job_id;
    connectionId = seeded.connectionId;
    await sql`update space set kind = 'shared', owner_principal_id = ${ownerId} where id = ${spaceId}`;
    await sql`update job set principal_id = ${ownerId} where id = ${jobId}`;
    await sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${ownerId}, ${spaceId}, 'owner', 1), (${memberId}, ${spaceId}, 'member', 1)`;
    for (const token of [cookie, memberCookie]) {
      const digest = createHash('sha256')
        .update(token.split('=')[1] ?? '')
        .digest('hex');
      await sql`update session set space_id = ${spaceId}, membership_generation = 1
        where token_hash = ${digest}`;
    }
    otherSpaceId = (await seedJob(sql, { provider: 'web' })).claims.space_id;
  }, 120_000);

  afterAll(async () => {
    await handle().close();
  }, 60_000);

  test('a saved sign-in is listed with its password masked and sealed at rest', async () => {
    const saved = await save({
      site: 'HTTPS://Example.com/login?next=/',
      username: USERNAME,
      password: PASSWORD,
      code_secret: CODE_LINK,
      label: 'Example',
    });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      origin: 'https://example.com',
      site: 'example.com',
      label: 'Example',
      username: USERNAME,
      password: '••••••••',
      has_code: true,
      policy: 'whenever_needed',
      last_used_at: null,
    });
    holdsNoSecret(saved.text);
    const listed = await call('/sign-ins');
    expect(listed.body.sign_ins.map((entry: { id: string }) => entry.id)).toEqual([saved.body.id]);
    holdsNoSecret(listed.text);

    const row = await rowOf(saved.body.id);
    holdsNoSecret(row);
    expect(String(row?.key_id)).toMatch(/^k1:[0-9a-f]{16}$/);
    const sealed = await secretRow(String(row?.secret_ref));
    expect(sealed).toStartWith('sealed-box-v1:');
    holdsNoSecret(sealed, [USERNAME]);
  });

  test('the current code is shown on request, and a check needs no visit to the site', async () => {
    const [entry] = (await call('/sign-ins')).body.sign_ins;
    const code = await call(`/sign-ins/${entry.id}/code`, { method: 'POST' });
    expect(code.status).toBe(200);
    expect(code.body.code).toMatch(/^\d{6}$/);
    expect([currentCode(TOTP).code, currentCode(TOTP, Date.now() - 30_000).code]).toContain(
      code.body.code,
    );
    expect(code.body.expires_in).toBeGreaterThan(0);
    expect(code.text).not.toContain(CODE_SECRET);
    const checked = await call(`/sign-ins/${entry.id}/check`, { method: 'POST' });
    expect(checked.body.ok).toBe(true);
    expect(checked.body.checks.map((item: { name: string }) => item.name)).toEqual([
      'site',
      'sealed',
      'password',
      'code',
    ]);
    holdsNoSecret(checked.text);
  });

  test('only exact https sites are saved, and a refused request never repeats what was sent', async () => {
    for (const site of [
      'http://example.org',
      'http://localhost:3000',
      'https://jo:pw@example.org',
      'ftp://example.org',
      'not a site',
    ]) {
      const refused = await save({ site, username: USERNAME, password: PASSWORD });
      expect([site, refused.status]).toEqual([site, 400]);
      holdsNoSecret(refused.text);
    }
    const unknown = await save({
      site: 'example.org',
      username: USERNAME,
      password: PASSWORD,
      note: PASSWORD,
    });
    expect(unknown.status).toBe(400);
    holdsNoSecret(unknown.text);
    const badCode = await save({
      site: 'example.org',
      username: USERNAME,
      password: PASSWORD,
      code_secret: `otpauth://hotp/x?secret=${CODE_SECRET}&counter=1`,
    });
    expect(badCode.status).toBe(400);
    holdsNoSecret(badCode.text);
    const twice = await save({ site: 'example.com', username: USERNAME, password: PASSWORD });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('duplicate');
  });

  test('another person in the same space neither sees nor touches a sign-in', async () => {
    const [entry] = (await call('/sign-ins')).body.sign_ins;
    expect((await call('/sign-ins', { cookie: memberCookie })).body).toEqual({ sign_ins: [] });
    for (const [method, path, body] of [
      ['PATCH', `/sign-ins/${entry.id}`, { label: 'Mine now' }],
      ['DELETE', `/sign-ins/${entry.id}`, undefined],
      ['POST', `/sign-ins/${entry.id}/code`, undefined],
      ['POST', `/sign-ins/${entry.id}/check`, undefined],
    ] as const) {
      const answer = await call(path, { method, body, cookie: memberCookie });
      expect([method, path, answer.status]).toEqual([method, path, 404]);
      holdsNoSecret(answer.text);
    }
    expect((await rowOf(entry.id))?.label).toBe('Example');
    // The member's own sign-in for the same site is theirs alone.
    const theirs = await save(
      { site: 'example.com', username: 'member@example.test', password: 'their-own-password' },
      memberCookie,
    );
    expect(theirs.status).toBe(201);
    expect((await call('/sign-ins')).body.sign_ins).toHaveLength(1);
    expect((await call('/sign-ins', { cookie: memberCookie })).body.sign_ins).toHaveLength(1);
  });

  test('a sign-in in one space is absent from every other', async () => {
    const vault = vaultUnder(KEY);
    const [entry] = await vault.list(spaceId, ownerId);
    expect((await refusal(vault.get(otherSpaceId, ownerId, entry?.id ?? ''))).code).toBe(
      'not_found',
    );
    expect(await vault.list(otherSpaceId, ownerId)).toEqual([]);
    expect((await refusal(vault.code(otherSpaceId, ownerId, entry?.id ?? ''))).code).toBe(
      'not_found',
    );
  });

  test('a new password reseals the sign-in and forgets the old sealed copy', async () => {
    const [entry] = (await call('/sign-ins')).body.sign_ins;
    const before = String((await rowOf(entry.id))?.secret_ref);
    const changed = await call(`/sign-ins/${entry.id}`, {
      method: 'PATCH',
      body: { password: `${PASSWORD}-2`, policy: 'ask_first' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ policy: 'ask_first', has_code: true });
    holdsNoSecret(changed.text, [`${PASSWORD}-2`]);
    const after = String((await rowOf(entry.id))?.secret_ref);
    expect(after).not.toBe(before);
    expect(await secretRow(before)).toBeUndefined();
    // The code secret came along unchanged.
    const code = await call(`/sign-ins/${entry.id}/code`, { method: 'POST' });
    expect([currentCode(TOTP).code, currentCode(TOTP, Date.now() - 30_000).code]).toContain(
      code.body.code,
    );
    const opened = await vaultUnder(KEY).withCredential(
      await vaultUnder(KEY).get(spaceId, ownerId, entry.id),
      async (credential) => credential.password,
    );
    expect(opened).toBe(`${PASSWORD}-2`);
    await call(`/sign-ins/${entry.id}`, { method: 'PATCH', body: { password: PASSWORD } });
  });

  test('a damaged or swapped sealed record is refused, and says nothing of what it held', async () => {
    const vault = vaultUnder(KEY);
    const a = await vault.create(spaceId, ownerId, {
      site: 'tamper.example',
      username: USERNAME,
      password: PASSWORD,
    });
    const b = await vault.create(spaceId, ownerId, {
      site: 'swap.example',
      username: USERNAME,
      password: PASSWORD,
    });
    const recordA = await vault.get(spaceId, ownerId, a.id);
    const recordB = await vault.get(spaceId, ownerId, b.id);
    const sealed = String(await secretRow(recordA.secretRef));
    const bytes = Buffer.from(sealed.slice('sealed-box-v1:'.length), 'base64');
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0x40;
    await handle().sql`update secret set ciphertext = ${`sealed-box-v1:${bytes.toString('base64')}`}
      where id = ${recordA.secretRef}`;
    const damaged = await refusal(vault.withCredential(recordA, async (c) => c.password));
    expect(damaged.code).toBe('unreadable');
    holdsNoSecret(damaged.message);
    const checked = await vault.check(spaceId, ownerId, a.id);
    expect(checked.ok).toBe(false);
    holdsNoSecret(checked);
    const answered = await call(`/sign-ins/${a.id}/check`, { method: 'POST' });
    expect(answered.body.ok).toBe(false);
    holdsNoSecret(answered.text);

    // B's row pointed at a sealed record of another sign-in opens to the wrong identity.
    await handle()
      .sql`update saved_sign_in set secret_ref = ${recordB.secretRef} where id = ${a.id}`;
    const swapped = await refusal(
      vault.withCredential(await vault.get(spaceId, ownerId, a.id), async (c) => c.password),
    );
    expect(swapped.code).toBe('unreadable');
    await handle()
      .sql`update saved_sign_in set secret_ref = ${recordA.secretRef} where id = ${a.id}`;
    await vault.delete(spaceId, ownerId, a.id);
    await vault.delete(spaceId, ownerId, b.id);
  });

  test('without a key, or under another key, nothing opens and the reason is plain', async () => {
    const [entry] = await vaultUnder(KEY).list(spaceId, ownerId);
    const id = entry?.id ?? '';
    const keyless = vaultUnder(undefined);
    expect(await keyless.list(spaceId, ownerId)).toHaveLength(1);
    const missing = await refusal(keyless.code(spaceId, ownerId, id));
    expect(missing.code).toBe('key_missing');
    expect(missing.message).toContain('MELETE_MASTER_KEY');
    const unsaved = await refusal(
      keyless.create(spaceId, ownerId, { site: 'nokey.example', username: 'x', password: 'y' }),
    );
    expect(unsaved.code).toBe('key_missing');
    expect(
      await handle().sql`select 1 from saved_sign_in where origin = 'https://nokey.example'`,
    ).toHaveLength(0);

    const rotated = vaultUnder(NEW_KEY);
    const changed = await refusal(rotated.code(spaceId, ownerId, id));
    expect(changed.code).toBe('key_changed');
    holdsNoSecret(changed.message);
    // A label alone needs no key; a new password and code under the new key saves it again.
    await rotated.update(spaceId, ownerId, id, { label: 'Example' });
    await rotated.update(spaceId, ownerId, id, { password: PASSWORD, code_secret: CODE_SECRET });
    expect((await rotated.code(spaceId, ownerId, id)).code).toMatch(/^\d{6}$/);
    expect((await refusal(vaultUnder(KEY).code(spaceId, ownerId, id))).code).toBe('key_changed');
    // Back under the installation's key for the rest of the suite.
    await vaultUnder(KEY).update(spaceId, ownerId, id, {
      password: PASSWORD,
      code_secret: CODE_SECRET,
    });
  });

  test('the daily sweep of unused sealed secrets keeps every saved sign-in', async () => {
    const swept = await sweepUnreferencedSecrets(handle().sql, Date.now() + 3 * 86_400_000);
    expect(swept).toBeGreaterThanOrEqual(0);
    const [entry] = await vaultUnder(KEY).list(spaceId, ownerId);
    expect((await vaultUnder(KEY).code(spaceId, ownerId, entry?.id ?? '')).code).toMatch(/^\d{6}$/);
  });

  test('the agent names a site and gets a masked account bound, never the sign-in', async () => {
    const vault = vaultUnder(KEY);
    const { sql } = handle();
    const ctx = { job_id: jobId, space_id: spaceId } as ConnectorContext;
    const prepared = await prepareSignIn(
      vault,
      { site: 'example.com', url: 'https://example.com/login', saved: { ask_first: false } },
      ctx,
      sql,
    );
    expect(prepared).toMatchObject({
      site: 'example.com',
      url: 'https://example.com/login',
      saved: {
        origin: 'https://example.com',
        label: 'Example',
        account: 'j***@…',
        ask_first: true,
        has_code: true,
      },
    });
    holdsNoSecret(prepared, [USERNAME]);
    const refuses = async (payload: JsonObject, words: string) => {
      let said = '';
      try {
        await prepareSignIn(vault, payload, ctx, sql);
      } catch (error) {
        said = error instanceof Error ? error.message : String(error);
      }
      expect(said).toContain(words);
      holdsNoSecret(said, [USERNAME]);
    };
    await refuses({ site: 'http://example.com' }, 'secure (https)');
    await refuses(
      { site: 'example.com', url: 'https://example.com.evil.test/login' },
      'must be on https://example.com itself',
    );
    await refuses({ site: 'examp1e.com' }, 'Saved sign-ins are for: example.com');
    await vault.create(spaceId, ownerId, {
      site: 'example.com',
      username: 'jordan@example.com',
      password: PASSWORD,
    });
    await refuses({ site: 'example.com' }, 'There are 2 saved sign-ins for example.com');
    const listed = await vault.forOrigin(spaceId, ownerId, 'https://example.com');
    const extra = listed.find((entry) => entry.username === 'jordan@example.com');
    await vault.delete(spaceId, ownerId, extra?.id ?? '');

    // "Ask me first" is asked; a sign-in switched to it after a proposal is refused at dispatch.
    const action = { kind: 'browser.sign_in', canonical_payload: prepared } as Action;
    expect(signInAsksFirst(action)).toBe(true);
    const [entry] = await vault.list(spaceId, ownerId);
    await vault.update(spaceId, ownerId, entry?.id ?? '', { policy: 'whenever_needed' });
    const quiet = await prepareSignIn(vault, { site: 'example.com' }, ctx, sql);
    const quietAction = { kind: 'browser.sign_in', canonical_payload: quiet } as Action;
    expect(signInAsksFirst(quietAction)).toBe(false);
    await validateSignIn(vault, quietAction, ctx, sql);
    await vault.update(spaceId, ownerId, entry?.id ?? '', { policy: 'ask_first' });
    expect(await failure(validateSignIn(vault, quietAction, ctx, sql))).toContain(
      'now wants to be asked',
    );
    await vault.update(spaceId, ownerId, entry?.id ?? '', { policy: 'whenever_needed' });
  });

  test('a job uses only its own person’s sign-ins, never the owner’s by default', async () => {
    const vault = vaultUnder(KEY);
    const { sql } = handle();
    const [owners] = await vault.list(spaceId, ownerId);
    if (!owners) throw new Error('expected the owner’s saved sign-in');
    // The owner's sign-in, bound at proposal by the owner's own job.
    const own = { job_id: jobId, space_id: spaceId } as ConnectorContext;
    const bound = await prepareSignIn(vault, { site: 'example.com' }, own, sql);
    const action = {
      id: 'act_owner_bound',
      kind: 'browser.sign_in',
      canonical_payload: bound,
    } as unknown as Action;
    await validateSignIn(vault, action, own, sql);

    /** Another job in the same space, of `principal` (or of nobody), of `kind`. */
    const jobOf = async (principal: string | null, kind = 'responsibility') => {
      const id = newId('job');
      await sql`insert into job (id, space_id, principal_id, kind, title, objective, state,
          lease_epoch, budget, constraints)
        select ${id}, space_id, ${principal}, ${kind}, title, objective, state, lease_epoch,
          budget, constraints
        from job where id = ${jobId}`;
      return { job_id: id, space_id: spaceId } as ConnectorContext;
    };
    let leased = 0;
    const dispatch = (ctx: ConnectorContext) =>
      runSignIn({
        vault,
        action,
        ctx,
        lease: async () => {
          leased += 1;
          throw new Error('the browser must not be reached');
        },
        handOff: async () => {},
      });
    /** Refused at proposal, at the approval's re-check and at dispatch, before any browser. */
    const refusedEverywhere = async (ctx: ConnectorContext, words: string) => {
      expect(await failure(prepareSignIn(vault, { site: 'example.com' }, ctx, sql))).toContain(
        words,
      );
      expect(await failure(validateSignIn(vault, action, ctx, sql))).toContain(
        words === OWN_WORK_ONLY ? OWN_WORK_ONLY : 'deleted or changed',
      );
      const result = await dispatch(ctx);
      expect(result.outcome).toBe('failed');
      expect(result.outcome === 'failed' ? result.reason : '').toContain(
        words === OWN_WORK_ONLY ? OWN_WORK_ONLY : 'has been deleted',
      );
      holdsNoSecret(result, [USERNAME]);
    };

    // A job with no person of its own, such as one a message or a schedule started
    // with nobody behind it, is nobody's: not the owner's.
    await refusedEverywhere(await jobOf(null), OWN_WORK_ONLY);

    // A guest's job in the shared space finds no sign-in of its own, and never the owner's.
    const guestId = newId('own');
    await sql`insert into principal (id, email, kind) values (${guestId}, ${`${guestId}@guest.test`}, 'guest')`;
    await sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${guestId}, ${spaceId}, 'guest', 1)`;
    await refusedEverywhere(await jobOf(guestId), 'There is no saved sign-in for example.com');

    // A member's job uses the member's own sign-in for the same site, never the owner's.
    const theirs = await vault.forOrigin(spaceId, memberId, 'https://example.com');
    if (!theirs.length)
      await vault.create(spaceId, memberId, {
        site: 'example.com',
        username: 'member@example.test',
        password: 'their-own-password',
      });
    const member = await jobOf(memberId);
    const asMember = await prepareSignIn(vault, { site: 'example.com' }, member, sql);
    expect(asMember.sign_in_id).not.toBe(owners.id);
    expect((asMember.saved as { account: string }).account).toBe('m***@…');
    expect(await failure(validateSignIn(vault, action, member, sql))).toContain(
      'deleted or changed',
    );
    expect((await dispatch(member)).outcome).toBe('failed');

    // A routine of the member's, proposed while their account was on, uses
    // nothing once the owner turns the account off: not at the approval's
    // re-check, and not at dispatch.
    const theirRoutine = await jobOf(memberId, 'routine');
    const proposed = await prepareSignIn(vault, { site: 'example.com' }, theirRoutine, sql);
    const theirAction = {
      id: 'act_member_routine',
      kind: 'browser.sign_in',
      canonical_payload: proposed,
    } as unknown as Action;
    await validateSignIn(vault, theirAction, theirRoutine, sql);
    await sql`update principal set disabled_at = now() where id = ${memberId}`;
    try {
      expect(await failure(validateSignIn(vault, theirAction, theirRoutine, sql))).toContain(
        OWN_WORK_ONLY,
      );
      const offResult = await runSignIn({
        vault,
        action: theirAction,
        ctx: theirRoutine,
        lease: async () => {
          leased += 1;
          throw new Error('the browser must not be reached');
        },
        handOff: async () => {},
      });
      expect(offResult.outcome).toBe('failed');
      expect(offResult.outcome === 'failed' ? offResult.reason : '').toContain(OWN_WORK_ONLY);
      expect(
        await failure(prepareSignIn(vault, { site: 'example.com' }, theirRoutine, sql)),
      ).toContain(OWN_WORK_ONLY);
    } finally {
      await sql`update principal set disabled_at = null where id = ${memberId}`;
    }
    await validateSignIn(vault, theirAction, theirRoutine, sql);

    // Once the member has left the space, their work there uses nothing, their own included.
    await sql`update space_membership set revoked_at = now()
      where space_id = ${spaceId} and principal_id = ${memberId}`;
    try {
      await refusedEverywhere(member, OWN_WORK_ONLY);
    } finally {
      await sql`update space_membership set revoked_at = null
        where space_id = ${spaceId} and principal_id = ${memberId}`;
    }

    // The owner's own routine still signs in with the owner's sign-in.
    const routine = await jobOf(ownerId, 'routine');
    const fromRoutine = await prepareSignIn(vault, { site: 'example.com' }, routine, sql);
    expect(fromRoutine.sign_in_id).toBe(owners.id);
    await validateSignIn(vault, action, routine, sql);
    expect(leased).toBe(0);
  });

  test('a use of a sign-in leaves its secrets out of every surface it touches', async () => {
    const vault = vaultUnder(KEY);
    const { sql } = handle();
    const ctx = {
      job_id: jobId,
      space_id: spaceId,
      idempotency_key: 'sign-in',
      constraints: { public_compartment: false, allowed_domains: ['example.com'] },
    } as unknown as ConnectorContext;
    const prepared = await prepareSignIn(vault, { site: 'example.com' }, ctx, sql);
    const action = {
      id: 'act_sign_in_leak',
      kind: 'browser.sign_in',
      connection_id: connectionId,
      canonical_payload: prepared,
    } as unknown as Action;
    const sent: unknown[] = [];
    const handOffs: unknown[] = [];
    const logged: string[] = [];
    const answers: Array<(operation: Record<string, unknown>) => unknown> = [];
    const worker = {
      request: async (_path: string, body: { operation: Record<string, unknown> }) => {
        sent.push(body);
        const next = answers.shift();
        if (!next) throw new Error('no answer');
        return next(body.operation);
      },
    } as unknown as BrowserWorkerClient;
    const step = (outcome: string) => () => ({
      session_id: 'bs_1',
      control_epoch: 2,
      result: { sign_in: outcome, at: 'https://example.com' },
    });
    const run = async () => {
      const originals = { log: console.log, warn: console.warn, error: console.error };
      const write = process.stderr.write;
      for (const name of ['log', 'warn', 'error'] as const)
        console[name] = (...args: unknown[]) => logged.push(args.map(String).join(' '));
      process.stderr.write = ((chunk: unknown) => {
        logged.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        return await runSignIn({
          vault,
          action,
          ctx,
          lease: async () => ({ session: { id: 'bs_1', control_epoch: 2 }, worker, opened: false }),
          handOff: async (...args) => {
            handOffs.push(args.slice(0, 4));
          },
        });
      } finally {
        Object.assign(console, originals);
        process.stderr.write = write;
      }
    };

    // Asked for a code, given the current one, signed in.
    answers.push(step('code_asked'), step('signed_in'));
    const signedIn = await run();
    expect(signedIn.outcome).toBe('succeeded');
    const detail = signedIn.outcome === 'succeeded' ? signedIn.receipt.detail : {};
    expect(detail).toMatchObject({
      account: 'j***@…',
      outcome: 'signed_in',
      note: 'Signed in as j***@… on example.com.',
      sign_in: { label: 'Example', site: 'example.com' },
    });
    // The worker, and only the worker, was handed the password and the code.
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toContain(PASSWORD);
    const code = (sent[1] as { operation: { code: string } }).operation.code;
    expect(code).toMatch(/^\d{6}$/);

    // A site that refuses the code, a browser fault and an error that names the password.
    answers.push(step('code_asked'), step('code_asked'));
    const refused = await run();
    answers.push(() => {
      throw new BrowserFault('session_busy');
    });
    const busy = await run();
    answers.push(() => {
      throw new Error(`worker said ${PASSWORD} ${code}`);
    });
    const broken = await run();
    expect(refused).toMatchObject({ outcome: 'failed' });
    expect(busy).toMatchObject({
      outcome: 'failed',
      reason:
        "Couldn't sign in to example.com: The browser is busy with other work. Try again in a moment.",
    });
    expect(broken).toMatchObject({
      outcome: 'failed',
      reason: "Couldn't sign in to example.com: The browser could not finish signing in.",
    });

    // A code the vault lacks hands the browser to the person, with the site and nothing else.
    const [entry] = await vault.list(spaceId, ownerId);
    await vault.update(spaceId, ownerId, entry?.id ?? '', { code_secret: null });
    const noCode = await prepareSignIn(vault, { site: 'example.com' }, ctx, sql);
    const noCodeAction = { ...action, id: 'act_sign_in_sms', canonical_payload: noCode };
    answers.push(step('code_asked'));
    const handed = await runSignIn({
      vault,
      action: noCodeAction as Action,
      ctx,
      lease: async () => ({ session: { id: 'bs_1', control_epoch: 2 }, worker, opened: false }),
      handOff: async (_ctx, session, reason: HandOffReason, url) => {
        handOffs.push([session, reason, url]);
      },
    });
    expect(handed).toMatchObject({
      outcome: 'succeeded',
      receipt: { detail: { outcome: 'needs_code', handed_to: 'person' } },
    });
    expect(handOffs.at(-1)).toEqual(['bs_1', 'two_factor', 'https://example.com']);
    await vault.update(spaceId, ownerId, entry?.id ?? '', {
      password: PASSWORD,
      code_secret: CODE_SECRET,
    });

    // Receipts say which sign-in, where, for which work and what came of it.
    const uses = await sql`select * from saved_sign_in_use where sign_in_id = ${entry?.id ?? ''}
      order by created_at, id`;
    expect(uses.map((use) => use.outcome)).toEqual([
      'signed_in',
      'not_accepted',
      'failed',
      'failed',
      'needs_code',
    ]);
    expect(uses[0]).toMatchObject({
      job_id: jobId,
      action_id: 'act_sign_in_leak',
      origin: 'https://example.com',
      principal_id: ownerId,
    });
    const listed = (await call('/sign-ins')).body.sign_ins[0];
    expect(listed.last_outcome).toBe('needs_code');

    // The chat's words for it.
    const row = (result: unknown, payload = prepared) => ({
      id: 'act_1',
      jobId,
      attemptId: null,
      connectionId,
      kind: 'browser.sign_in',
      canonicalPayload: payload,
      receipt:
        (result as { outcome?: string }).outcome === 'succeeded'
          ? (result as { receipt: unknown }).receipt
          : null,
      effectClass: 'write_reversible',
      status: (result as { outcome: string }).outcome,
      createdAt: new Date(),
      resolvedAt: new Date(),
    });
    const chatRow = (result: unknown) =>
      actionCall({
        action: row(result) as never,
        connection: { id: connectionId, label: 'Browser', provider: 'web' },
        raw: (result as { outcome: string }).outcome,
        at: new Date(),
      });
    const phrase = actionPhrase(row(signedIn) as never, 'Browser');
    expect(phrase.done).toBe('Signed in to example.com as j***@…');
    expect(actionPhrase(row(refused) as never, 'Browser').done).toBe(
      'Tried to sign in to example.com',
    );
    const ask = stepAsk('browser.sign_in', prepared);
    expect(ask).toContain('Sign in to example.com as j***@…');
    const chat = [signedIn, refused, busy, broken, handed].map(chatRow);
    expect(chat[0]?.title).toBe('Signed in to example.com as j***@…');

    const surfaces = {
      results: [signedIn, refused, busy, broken, handed],
      handOffs,
      logged,
      uses,
      rows: await sql`select * from saved_sign_in where space_id = ${spaceId}`,
      words: [phrase, ask, chat],
    };
    holdsNoSecret(surfaces, [code]);
    // The username, too, is only ever masked outside the list the person reads.
    expect(JSON.stringify({ ...surfaces, rows: [] })).not.toContain(USERNAME);
  });

  test('an export lists sites and usernames, never a secret', async () => {
    const exported = await exportSavedSignIns(handle().sql, ownerId);
    expect(exported.map((entry) => [entry.site, entry.username])).toEqual([
      ['example.com', USERNAME],
    ]);
    holdsNoSecret(exported);
  });

  test('a delete, and an account removal, take the sealed secrets with them', async () => {
    const [mine] = (await call('/sign-ins')).body.sign_ins;
    const ref = String((await rowOf(mine.id))?.secret_ref);
    expect(await secretRow(ref)).toBeDefined();
    const removed = await call(`/sign-ins/${mine.id}`, { method: 'DELETE' });
    expect(removed.body).toEqual({ id: mine.id, deleted: true });
    expect(await rowOf(mine.id)).toBeUndefined();
    expect(await secretRow(ref)).toBeUndefined();
    expect((await call(`/sign-ins/${mine.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(
      await handle().sql`select 1 from saved_sign_in_use where sign_in_id = ${mine.id}`,
    ).toHaveLength(0);

    const [theirs] = (await call('/sign-ins', { cookie: memberCookie })).body.sign_ins;
    const theirRef = String((await rowOf(theirs.id))?.secret_ref);
    expect(await forgetSavedSignIns(handle().sql, memberId)).toBe(1);
    expect(await rowOf(theirs.id)).toBeUndefined();
    expect(await secretRow(theirRef)).toBeUndefined();
  });

  test('under another key, a sign-in with a code asks for its password and code secret, and saves with both', async () => {
    const vault = vaultUnder(KEY);
    const rotated = vaultUnder(NEW_KEY);
    const coded = await vault.create(spaceId, ownerId, {
      site: 'rekey.example',
      username: USERNAME,
      password: PASSWORD,
      code_secret: CODE_SECRET,
    });
    // The password alone cannot save it again: the code secret is sealed with it.
    const alone = await refusal(rotated.update(spaceId, ownerId, coded.id, { password: PASSWORD }));
    expect(alone.code).toBe('key_changed');
    expect(alone.message).toContain('Enter its password and its code secret again');
    holdsNoSecret(alone.message);
    const checked = await rotated.check(spaceId, ownerId, coded.id);
    expect(checked.checks.find((item) => item.name === 'sealed')?.detail).toContain(
      'its password and its code secret',
    );
    // Given what it asked for, it is saved under the current key, code and all.
    await rotated.update(spaceId, ownerId, coded.id, {
      password: PASSWORD,
      code_secret: CODE_SECRET,
    });
    expect((await rotated.code(spaceId, ownerId, coded.id)).code).toMatch(/^\d{6}$/);

    // Without a code, the password is all there is to give again, and all it asks for.
    const plain = await vault.create(spaceId, ownerId, {
      site: 'rekey-plain.example',
      username: USERNAME,
      password: PASSWORD,
    });
    const asked = await refusal(
      rotated.withCredential(
        await rotated.get(spaceId, ownerId, plain.id),
        async (c) => c.password,
      ),
    );
    expect(asked.message).toContain('Enter its password again');
    await rotated.update(spaceId, ownerId, plain.id, { password: PASSWORD });
    expect(
      await rotated.withCredential(
        await rotated.get(spaceId, ownerId, plain.id),
        async (c) => c.password,
      ),
    ).toBe(PASSWORD);
    await vault.delete(spaceId, ownerId, coded.id);
    await vault.delete(spaceId, ownerId, plain.id);
  });

  test('a long site is named within the list’s limits, a cleared name is the site’s again, and an old long row still lists', async () => {
    // A real host can be long: each part up to 63 characters, the whole up to 253.
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
    const saved = await save({ site: host, username: USERNAME, password: PASSWORD });
    expect(saved.status).toBe(201);
    expect(saved.body.site).toBe(host);
    expect(saved.body.label.length).toBeLessThanOrEqual(120);
    expect(saved.body.label).toStartWith('a'.repeat(60));
    const listed = await call('/sign-ins');
    expect(listed.status).toBe(200);
    expect(listed.body.sign_ins.map((entry: { id: string }) => entry.id)).toEqual([saved.body.id]);

    // A name of one's own, and then none: the site's name again.
    const named = await call(`/sign-ins/${saved.body.id}`, {
      method: 'PATCH',
      body: { label: 'Work' },
    });
    expect(named.body.label).toBe('Work');
    const cleared = await call(`/sign-ins/${saved.body.id}`, {
      method: 'PATCH',
      body: { label: '  ' },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.label).toBe(saved.body.label);
    // Cleared alongside a new password too.
    await call(`/sign-ins/${saved.body.id}`, { method: 'PATCH', body: { label: 'Work' } });
    const both = await call(`/sign-ins/${saved.body.id}`, {
      method: 'PATCH',
      body: { label: '', password: PASSWORD },
    });
    expect(both.body.label).toBe(saved.body.label);

    // A host longer than any real one is not a site.
    const tooLong = await save({
      site: `${`${'d'.repeat(63)}.`.repeat(4)}example`,
      username: USERNAME,
      password: PASSWORD,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('invalid_site');

    // A row saved before names and sites were kept short still lists, and still goes.
    await handle().sql`update saved_sign_in set label = ${'x'.repeat(300)},
        origin = ${`https://${'e'.repeat(400)}.example`}
      where id = ${saved.body.id}`;
    const old = await call('/sign-ins');
    expect(old.status).toBe(200);
    expect(old.body.sign_ins[0].label.length).toBeLessThanOrEqual(120);
    expect(old.body.sign_ins[0].site.length).toBeLessThanOrEqual(255);
    expect(old.body.sign_ins[0].origin.length).toBeLessThanOrEqual(300);
    expect((await call(`/sign-ins/${saved.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/sign-ins')).body).toEqual({ sign_ins: [] });
  });

  test('a sign-in saved as its person leaves the room is never kept, nor its sealed password', async () => {
    const vault = vaultUnder(KEY);
    const { sql } = handle();
    const email = `leaver-${randomBytes(4).toString('hex')}@example.test`;
    expect(
      (await call('/principals', { method: 'POST', body: { email, password: LOGIN } })).status,
    ).toBe(201);
    const [{ id: leaver } = { id: '' }] = await sql<{ id: string }[]>`select id from principal
      where email = ${email}`;
    await sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${leaver}, ${spaceId}, 'member', 1)`;
    const secrets = async () =>
      Number((await sql`select count(*)::int as n from secret`)[0]?.n ?? 0);
    const kept = async () =>
      (
        await sql`select id from saved_sign_in where space_id = ${spaceId} and principal_id = ${leaver}`
      ).length;
    const before = await secrets();
    // The room's removal of them holds the room, as `endMembership` does, while their save runs.
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const leaving = sql.begin(async (tx) => {
      await tx`select id from space where id = ${spaceId} for update`;
      locked();
      await tx`update space_membership set revoked_at = now(), generation = generation + 1
        where space_id = ${spaceId} and principal_id = ${leaver}`;
      await tx`delete from saved_sign_in where space_id = ${spaceId} and principal_id = ${leaver}`;
      // The save is sealed and waits on the room meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    await holding;
    const saving = vault.create(spaceId, leaver, {
      site: 'race.example',
      username: 'leaver',
      password: 'a-password-saved-while-leaving',
    });
    const [left, saved] = await Promise.allSettled([leaving, saving]);
    expect(left.status).toBe('fulfilled');
    expect(saved.status).toBe('rejected');
    if (saved.status === 'rejected') expect(saved.reason).toBeInstanceOf(VaultFault);
    expect(await kept()).toBe(0);
    expect(await secrets()).toBe(before);
    // Once gone, a save is refused outright and leaves nothing sealed behind.
    expect(
      (
        await refusal(
          vault.create(spaceId, leaver, { site: 'later.example', username: 'x', password: 'y' }),
        )
      ).code,
    ).toBe('changed');
    expect(await kept()).toBe(0);
    expect(await secrets()).toBe(before);
  });

  test('someone who leaves a room takes the sign-ins they saved there, and only those', async () => {
    const vault = vaultUnder(KEY);
    const { db } = handle();
    const theirs = await vault.create(spaceId, memberId, {
      site: 'leaving.example',
      username: 'member@example.test',
      password: 'their-own-password',
    });
    // A space they are still in.
    await handle().sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${memberId}, ${otherSpaceId}, 'member', 1) on conflict do nothing`;
    const elsewhere = await vault.create(otherSpaceId, memberId, {
      site: 'leaving.example',
      username: 'member@example.test',
      password: 'their-own-password',
    });
    const owners = await vault.create(spaceId, ownerId, {
      site: 'leaving.example',
      username: USERNAME,
      password: PASSWORD,
    });
    const theirRef = String((await rowOf(theirs.id))?.secret_ref);
    // The room's work starts again behind the new roster; its queue is not under test.
    const queue = { send: async () => null } as unknown as PgBoss;
    const principals = new PrincipalService(db, tmpdir(), new JobService(db, queue));
    await principals.revoke(memberId, spaceId, memberId);
    expect(await rowOf(theirs.id)).toBeUndefined();
    expect(await secretRow(theirRef)).toBeUndefined();
    // What they keep in a space they are still in, and what others saved in the room, stay.
    expect(await rowOf(elsewhere.id)).toBeDefined();
    expect(await rowOf(owners.id)).toBeDefined();
    await vault.delete(otherSpaceId, memberId, elsewhere.id);
    await vault.delete(spaceId, ownerId, owners.id);
  });
});
