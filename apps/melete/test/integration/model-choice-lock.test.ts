/**
 * An attempt's model is chosen inside the claim's transaction, which holds the
 * event order lock, from the model settings read through that transaction.
 * Scheduled work may run on the owner's secondary model, and a secondary
 * reached by signing in (ChatGPT) is used only while that sign-in holds, so
 * the sign-in must be read through the transaction too, never on the pool.
 * Real Postgres, with the lock guard refusing any statement sent to the pool
 * while the lock is held.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { loadEnv } from '../../src/env.ts';
import { PostgresCredentialRepository, ProviderSignIn } from '../../src/gateway/credentials.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import { chatgptIssuer } from '../../src/gateway/oauth.ts';
import { NO_ROUTING } from '../../src/gateway/routing.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const suite = fixture ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const SECONDARY = { provider: 'chatgpt', model: 'gpt-5.5' };

suite("an attempt's model choice and the event order lock", () => {
  const guard = process.env.MELETE_EVENT_LOCK_GUARD;
  let ownerId = '';
  let spaceId = '';

  beforeAll(async () => {
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
    if (!fixture) return;
    ownerId = `owner-${randomUUID()}`;
    spaceId = `space-${randomUUID()}`;
    await fixture.sql`insert into owner (id, email) values (${ownerId}, 'owner@example.test')`;
    await fixture.sql`insert into principal (id, email) values (${ownerId}, 'owner@example.test')`;
    await fixture.sql`insert into space (id, name, git_path, owner_principal_id)
      values (${spaceId}, 'Home', ${`spaces/${spaceId}`}, ${ownerId})`;
    // Scheduled work in the owner's spaces moves to their ChatGPT secondary.
    await fixture.sql`insert into model_secondary (principal_id, provider, model, scheduled)
      values (${ownerId}, ${SECONDARY.provider}, ${SECONDARY.model}, 'secondary')`;
  });

  beforeEach(async () => {
    if (fixture) await fixture.sql`delete from provider_credential`;
  });

  afterAll(async () => {
    if (guard === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
    else process.env.MELETE_EVENT_LOCK_GUARD = guard;
    await fixture?.close();
  });

  function settings() {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: masterKey });
    const signIn = new ProviderSignIn({
      repository: new PostgresCredentialRepository(fixture.sql),
      issuers: { chatgpt: chatgptIssuer({ issuer: 'https://auth.example.test' }) },
      masterKey: () => masterKey,
      log: () => {},
    });
    return { env, service: new ModelSettingsService({ db: fixture.db, env, signIn }) };
  }

  async function signedIn(status: 'active' | 'sign_in_required') {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    await fixture.sql`insert into provider_credential (provider, owner_id, status)
      values (${SECONDARY.provider}, ${ownerId}, ${status})`;
  }

  /** The model scheduled work would start on, chosen as the runner's claim chooses it. */
  async function scheduledChoice() {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { service } = settings();
    return serviceTransaction(fixture.db, (tx) =>
      service.routedChoice(NO_ROUTING, tx, { spaceId, usageClass: 'background' }),
    );
  }

  test('scheduled work moves to a signed-in secondary without leaving the transaction', async () => {
    await signedIn('active');
    expect(await scheduledChoice()).toMatchObject(SECONDARY);
  });

  test('a secondary whose sign-in lapsed, or never happened, leaves the work on the primary', async () => {
    const { env } = settings();
    const primary = { provider: env.MELETE_DEFAULT_PROVIDER, model: env.MELETE_DEFAULT_MODEL };
    expect(await scheduledChoice()).toMatchObject(primary);
    await signedIn('sign_in_required');
    expect(await scheduledChoice()).toMatchObject(primary);
  });
});
