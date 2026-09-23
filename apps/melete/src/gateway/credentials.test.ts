import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  type CredentialRepository,
  type CredentialRow,
  ProviderSignIn,
  type SignInStatus,
} from './credentials.ts';
import { type FakeIssuer, startFakeIssuer } from './fixtures/fake-oauth.ts';
import { chatgptIssuer, exchangeCode, OAuthFailure, pkcePair } from './oauth.ts';
import { GatewayError } from './types.ts';

/**
 * One map and one lock per provider, shared by every service built on it, as
 * Postgres would be. Writes are staged and kept only when the work returns: a
 * throw discards them, as a rolled-back transaction does.
 */
class MemoryRepository implements CredentialRepository {
  rows = new Map<string, CredentialRow>();
  lockCount = 0;
  private tails = new Map<string, Promise<unknown>>();

  async read(provider: string) {
    const row = this.rows.get(provider);
    return row ? { ...row } : null;
  }

  locked<T>(
    provider: string,
    work: (
      row: CredentialRow | null,
      write: (next: CredentialRow | null) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    this.lockCount++;
    const run = (this.tails.get(provider) ?? Promise.resolve()).then(async () => {
      const current = this.rows.get(provider);
      let staged: { next: CredentialRow | null } | undefined;
      const result = await work(current ? { ...current } : null, async (next) => {
        staged = { next: next ? { ...next } : null };
      });
      if (staged) {
        if (staged.next) this.rows.set(provider, staged.next);
        else this.rows.delete(provider);
      }
      return result;
    });
    this.tails.set(
      provider,
      run.catch(() => {}),
    );
    return run;
  }
}

const masterKey = randomBytes(32).toString('hex');
let issuer: FakeIssuer;
let repository: MemoryRepository;
let logs: string[];
let clock: number;
const stderr = spyOn(process.stderr, 'write');
const stdout = spyOn(process.stdout, 'write');

function service() {
  return new ProviderSignIn({
    repository,
    issuers: { chatgpt: chatgptIssuer({ issuer: issuer.url }) },
    labels: { chatgpt: 'ChatGPT' },
    masterKey: () => masterKey,
    now: () => clock,
    log: (line) => logs.push(line),
  });
}

/** Stands in for the browser: opens the authorize address and returns where it was sent back. */
async function approveInBrowser(authorizeUrl: string): Promise<string> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error('the issuer did not redirect');
  return location;
}

async function signIn(signin = service()): Promise<SignInStatus> {
  const started = await signin.start('chatgpt', 'own_1', 'browser');
  if (started.method !== 'browser') throw new Error('expected a browser sign-in');
  const result = await signin.complete('chatgpt', 'own_1', {
    sign_in_id: started.sign_in_id,
    callback_url: await approveInBrowser(started.authorize_url),
  });
  if (result.state !== 'signed_in') throw new Error('sign-in did not finish');
  return result as SignInStatus;
}

beforeEach(async () => {
  issuer = await startFakeIssuer();
  repository = new MemoryRepository();
  logs = [];
  clock = Date.now();
  stderr.mockClear();
  stdout.mockClear();
});

afterEach(async () => {
  // No token the issuer handed out may appear in any log line, row or process output.
  const written = [
    ...logs,
    ...stderr.mock.calls.map((call) => String(call[0])),
    ...stdout.mock.calls.map((call) => String(call[0])),
    ...[...repository.rows.values()].map((row) => JSON.stringify(row)),
  ].join('\n');
  for (const token of issuer.issued) expect(written).not.toContain(token);
  await issuer.stop();
});

afterAll(() => {
  stderr.mockRestore();
  stdout.mockRestore();
});

describe('signing in with a browser', () => {
  test('exchanges the code with its PKCE verifier and keeps only a sealed record', async () => {
    const status = await signIn();
    expect(status).toMatchObject({
      provider: 'chatgpt',
      state: 'signed_in',
      account: 'owner@example.test',
      reason: null,
    });
    expect(issuer.exchanges).toBe(1);
    const row = repository.rows.get('chatgpt');
    expect(row?.ciphertext).toStartWith('sealed-box-v1:');
    expect(JSON.stringify(status)).not.toContain('refresh-');
  });

  test('a code sent without the verifier that made its challenge is refused', async () => {
    const chatgpt = chatgptIssuer({ issuer: issuer.url });
    const { challenge } = pkcePair();
    const url = new URL(`${issuer.url}/oauth/authorize`);
    url.searchParams.set('redirect_uri', chatgpt.redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('client_id', chatgpt.clientId);
    const code = new URL(await approveInBrowser(url.href)).searchParams.get('code') ?? '';
    const other = pkcePair();
    const refused = await exchangeCode(
      chatgpt,
      { code, verifier: other.verifier, redirectUri: chatgpt.redirectUri },
      fetch,
    ).catch((error) => error);
    expect(refused).toBeInstanceOf(OAuthFailure);
    expect((refused as OAuthFailure).code).toBe('code_exchange_refused');
  });

  test('a returned address with another state, or another path, finishes nothing', async () => {
    const signin = service();
    const started = await signin.start('chatgpt', 'own_1', 'browser');
    if (started.method !== 'browser') throw new Error('expected a browser sign-in');
    const callback = new URL(await approveInBrowser(started.authorize_url));
    const forged = new URL(callback);
    forged.searchParams.set('state', 'attacker-chosen-state');
    const wrongPath = new URL(callback);
    wrongPath.pathname = '/elsewhere';
    for (const [address, code] of [
      [forged.href, 'state_mismatch'],
      [wrongPath.href, 'callback_invalid'],
      ['not an address', 'callback_invalid'],
    ] as const) {
      const refused = await signin
        .complete('chatgpt', 'own_1', { sign_in_id: started.sign_in_id, callback_url: address })
        .catch((error) => error);
      expect((refused as OAuthFailure).code).toBe(code);
    }
    expect(issuer.exchanges).toBe(0);
    expect(repository.rows.size).toBe(0);
    // Another account's session cannot finish the owner's sign-in either.
    const other = await signin
      .complete('chatgpt', 'prn_other', {
        sign_in_id: started.sign_in_id,
        callback_url: callback.href,
      })
      .catch((error) => error);
    expect((other as OAuthFailure).code).toBe('sign_in_not_found');
    // The genuine address still works, once.
    await signin.complete('chatgpt', 'own_1', {
      sign_in_id: started.sign_in_id,
      callback_url: callback.href,
    });
    const replay = await signin
      .complete('chatgpt', 'own_1', { sign_in_id: started.sign_in_id, callback_url: callback.href })
      .catch((error) => error);
    expect((replay as OAuthFailure).code).toBe('sign_in_not_found');
    expect(issuer.exchanges).toBe(1);
  });

  test('an expired sign-in cannot be finished', async () => {
    const signin = service();
    const started = await signin.start('chatgpt', 'own_1', 'browser');
    if (started.method !== 'browser') throw new Error('expected a browser sign-in');
    const callback = await approveInBrowser(started.authorize_url);
    clock += 16 * 60_000;
    const refused = await signin
      .complete('chatgpt', 'own_1', { sign_in_id: started.sign_in_id, callback_url: callback })
      .catch((error) => error);
    expect((refused as OAuthFailure).code).toBe('sign_in_not_found');
  });
});

describe('signing in with a device code', () => {
  test('stays pending until the code is entered, and polls no faster than asked', async () => {
    const signin = service();
    const started = await signin.start('chatgpt', 'own_1');
    expect(started).toMatchObject({
      method: 'device',
      user_code: 'ABCD-1234',
      verification_url: `${issuer.url}/codex/device`,
      interval: 1,
    });
    const complete = () => signin.complete('chatgpt', 'own_1', { sign_in_id: started.sign_in_id });
    expect(await complete()).toEqual({ state: 'pending', interval: 1 });
    expect(await complete()).toEqual({ state: 'pending', interval: 1 });
    expect(issuer.devicePolls).toBe(1);
    expect((await signin.status('chatgpt')).state).toBe('pending');
    issuer.approveDevice();
    clock += 1000;
    expect(await complete()).toMatchObject({ state: 'signed_in', account: 'owner@example.test' });
    expect(issuer.exchanges).toBe(1);
  });
});

describe('the gateway credential', () => {
  test('gives the current token and the account header', async () => {
    await signIn();
    const current = await service().credential('chatgpt').current();
    expect(current.headers).toEqual({ 'chatgpt-account-id': 'account-fixture' });
    expect(issuer.issued).toContain(current.token);
    expect(issuer.refreshCount).toBe(0);
  });

  test('refreshes before expiry, and rotates the stored refresh token', async () => {
    issuer.lifetime = 60;
    await signIn();
    clock += 45_000;
    const before = repository.rows.get('chatgpt');
    const current = await service().credential('chatgpt').current();
    expect(issuer.refreshCount).toBe(1);
    const after = repository.rows.get('chatgpt');
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
    expect(current.generation).toBe(after?.generation ?? -1);
    expect(after?.ciphertext).not.toBe(before?.ciphertext);
  });

  test('concurrent requests in two processes refresh once and never reuse a refresh token', async () => {
    issuer.lifetime = 60;
    issuer.refreshDelayMs = 50;
    await signIn();
    clock += 45_000;
    const first = service().credential('chatgpt');
    const second = service().credential('chatgpt');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).current()),
    );
    expect(issuer.refreshCount).toBe(1);
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    expect(repository.rows.get('chatgpt')?.status).toBe('active');
  });

  test('concurrent requests in one process share one refresh and take the lock once', async () => {
    issuer.lifetime = 60;
    issuer.refreshDelayMs = 50;
    await signIn();
    clock += 45_000;
    const locksBefore = repository.lockCount;
    const credential = service().credential('chatgpt');
    await Promise.all(Array.from({ length: 5 }, () => credential.current()));
    expect(issuer.refreshCount).toBe(1);
    expect(repository.lockCount - locksBefore).toBe(1);
  });

  test('a refused token is refreshed on its next use', async () => {
    await signIn();
    const credential = service().credential('chatgpt');
    const first = await credential.current();
    credential.rejected(first.generation);
    const second = await credential.current();
    expect(issuer.refreshCount).toBe(1);
    expect(second.token).not.toBe(first.token);
  });

  test('a revoked refresh token asks for a new sign-in and keeps no tokens', async () => {
    issuer.lifetime = 60;
    await signIn();
    clock += 45_000;
    issuer.revokeAll();
    const refused = await service()
      .credential('chatgpt')
      .current()
      .catch((error) => error);
    expect(refused).toBeInstanceOf(GatewayError);
    expect((refused as GatewayError).code).toBe('provider_sign_in_required');
    const row = repository.rows.get('chatgpt');
    expect(row).toMatchObject({ status: 'sign_in_required', ciphertext: null, secretId: null });
    expect(await service().status('chatgpt')).toMatchObject({
      state: 'sign_in_required',
      reason: 'refresh_revoked',
      message:
        'ChatGPT ended this sign-in, for example after a sign-out or a password change there. Sign in again to keep using it.',
    });
    expect(logs.at(-1)).toBe('provider sign-in: chatgpt needs a new sign-in (refresh_revoked)');
  });

  test('an issuer that is away leaves a live token serving, and an expired one unavailable', async () => {
    issuer.lifetime = 120;
    await signIn();
    issuer.refreshFailure = { status: 503, body: { error: 'temporarily_unavailable' } };
    const credential = service().credential('chatgpt');
    clock += 90_000;
    expect((await credential.current()).token).toBeString();
    expect(issuer.refreshCount).toBe(1);
    expect(repository.rows.get('chatgpt')?.status).toBe('active');
    clock += 60_000;
    const unavailable = await credential.current().catch((error) => error);
    expect((unavailable as GatewayError).code).toBe('provider_credential_unavailable');
    expect(repository.rows.get('chatgpt')?.status).toBe('active');
  });

  test('a sealed record copied onto another provider does not open', async () => {
    await signIn();
    const row = repository.rows.get('chatgpt');
    if (!row) throw new Error('no row');
    repository.rows.set('openai-compatible', { ...row, provider: 'openai-compatible' });
    const other = new ProviderSignIn({
      repository,
      issuers: {
        'openai-compatible': {
          ...chatgptIssuer({ issuer: issuer.url }),
          provider: 'openai-compatible',
        },
      },
      masterKey: () => masterKey,
      log: (line) => logs.push(line),
    });
    const refused = await other
      .credential('openai-compatible')
      .current()
      .catch((error) => error);
    expect((refused as GatewayError).code).toBe('provider_credential_unavailable');
  });
});

describe('signing out', () => {
  test('removes the credential and revokes its refresh token at the issuer', async () => {
    await signIn();
    const signin = service();
    const status = await signin.signOut('chatgpt');
    expect(status.state).toBe('signed_out');
    expect(repository.rows.size).toBe(0);
    expect(issuer.revoked).toHaveLength(1);
    expect(issuer.revoked[0]?.hint).toBe('refresh_token');
    expect(issuer.issued).toContain(issuer.revoked[0]?.token ?? 'missing');
    const refused = await signin
      .credential('chatgpt')
      .current()
      .catch((error) => error);
    expect((refused as GatewayError).code).toBe('provider_sign_in_required');
  });

  test('an issuer whose metadata cannot be read still leaves the owner signed out', async () => {
    await signIn();
    const unreadable = new ProviderSignIn({
      repository,
      issuers: {
        chatgpt: async () => {
          throw new OAuthFailure('issuer_discovery_failed', false);
        },
      },
      masterKey: () => masterKey,
      now: () => clock,
      log: (line) => logs.push(line),
    });
    const refused = await unreadable
      .credential('chatgpt')
      .current()
      .catch((error) => error);
    expect(refused).toBeInstanceOf(GatewayError);
    expect((refused as GatewayError).code).toBe('provider_credential_unavailable');
    expect((await unreadable.signOut('chatgpt')).state).toBe('signed_out');
    expect(repository.rows.size).toBe(0);
    expect(issuer.revoked).toHaveLength(0);
    expect(logs).toContain('provider sign-in: chatgpt revocation was not confirmed');
  });

  test('signing in again retires the earlier grant', async () => {
    await signIn();
    await signIn();
    expect(issuer.revoked).toHaveLength(1);
    expect(repository.rows.get('chatgpt')?.generation).toBe(2);
  });
});
