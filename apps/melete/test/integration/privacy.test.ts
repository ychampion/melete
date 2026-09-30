import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { AttemptBundle } from '@melete/contracts';
import type { GatewayPrincipal, GatewayProvider } from '../../src/gateway/types.ts';
import { KEEP_PRIVATE, PrivacyRouter, SEND_REDACTED } from '../../src/privacy/router.ts';
import { updateSettings } from '../../src/privacy/routes.ts';
import { PostgresPrivacyStore } from '../../src/privacy/store.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
afterAll(async () => {
  await handle?.close();
});

const KEY = randomBytes(32).toString('hex');
const SPACE = 'sp_01JPRIVACY0000000000000000';
const CONVERSATION = 'job_01JPRIVACY0000000000000000';
const CHILD = 'job_01JPRIVACYCH1D00000000000';
const ATTEMPT = 'att_01JPRIVACY0000000000000000';
const ACCOUNT = '000123456789';

const provider: GatewayProvider = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'k',
  protocols: ['chat/completions'],
};
const principal = (jobId: string): GatewayPrincipal => ({
  jobId,
  attemptId: ATTEMPT,
  epoch: 1,
  revision: 0,
  maxRequests: 5,
  maxTokens: 1000,
  allowedModels: [],
});
const ask = (content: string) => ({ model: 'm', messages: [{ role: 'user', content }] });

describe.if(handle !== null)('the privacy router over Postgres', () => {
  if (!handle) return;
  const { sql } = handle;
  const router = (masterKey: string | undefined = KEY) =>
    new PrivacyRouter({
      store: new PostgresPrivacyStore(sql, () => masterKey),
      resolve: async () => [{ address: '93.184.216.34' }],
    });

  beforeEach(async () => {
    await resetTestRows(sql);
    await sql`insert into space (id, name, git_path) values (${SPACE}, 'Personal', ${`/tmp/${SPACE}`})`;
    await sql`insert into job (id, space_id, title, objective, kind)
      values (${CONVERSATION}, ${SPACE}, 'Bills', 'Help with bills', 'chat')`;
    // A job a conversation started keeps the conversation's placeholders.
    await sql`insert into job (id, space_id, title, objective, experience_parent_id)
      values (${CHILD}, ${SPACE}, 'Pay', 'Pay the bill', ${CONVERSATION})`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id)
      values (${ATTEMPT}, ${CONVERSATION}, 1, 'test', 'fireworks', 'm', 'trn_1')`;
  });

  test('the vault is sealed at rest, bound to its conversation, and read back after a restart', async () => {
    const first = await router().prepare({
      principal: principal(CONVERSATION),
      provider,
      protocol: 'chat/completions',
      body: ask(`pay from account ${ACCOUNT}`),
    });
    expect((first.body.messages as { content: string }[])[0]?.content).toBe(
      'pay from account ⟦ACCOUNT_1⟧',
    );

    const [row] =
      await sql`select sealed, entries from privacy_vault where conversation_id = ${CONVERSATION}`;
    expect(row?.entries).toBe(1);
    expect(String(row?.sealed)).toContain('sealed-box-v1:');
    expect(String(row?.sealed)).not.toContain(ACCOUNT);

    // A restarted service, and a job the conversation started: the same placeholder.
    const second = await router().prepare({
      principal: principal(CHILD),
      provider,
      protocol: 'chat/completions',
      body: ask(`and again account ${ACCOUNT} plus sam@example.org`),
    });
    expect((second.body.messages as { content: string }[])[0]?.content).toBe(
      'and again account ⟦ACCOUNT_1⟧ plus ⟦EMAIL_1⟧',
    );

    // A sealed vault copied onto another conversation does not open there.
    await sql`insert into privacy_vault (conversation_id, space_id, sealed)
      select ${CHILD}, space_id, sealed from privacy_vault where conversation_id = ${CONVERSATION}`;
    expect(await new PostgresPrivacyStore(sql, () => KEY).loadVault(CHILD)).toBeNull();
    // Without the key nothing is read or written.
    const keyless = new PostgresPrivacyStore(sql, () => undefined);
    expect(keyless.sealing).toBe(false);
    expect(await keyless.loadVault(CONVERSATION)).toBeNull();
  });

  test('listed values are sealed; the audit trail keeps no values; answers reveal locally', async () => {
    const live = router();
    await updateSettings(live, SPACE, {
      add_known_values: [{ label: 'Sister', category: 'name', value: 'Priya Rivera' }],
    });
    const [settings] =
      await sql`select settings::text as plain, sealed from privacy_settings where space_id = ${SPACE}`;
    expect(`${settings?.plain}${settings?.sealed}`).not.toContain('Priya');

    await live.prepare({
      principal: principal(CONVERSATION),
      provider,
      protocol: 'chat/completions',
      body: ask(`Email Priya Rivera about account ${ACCOUNT}`),
    });
    const audit =
      await sql`select route, protected, categories, placeholders, turn_id, conversation_id
      from privacy_request where space_id = ${SPACE}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      route: 'cloud',
      protected: 2,
      categories: { name: 1, account: 1 },
      placeholders: ['⟦NAME_1⟧', '⟦ACCOUNT_1⟧'],
      turn_id: 'trn_1',
      conversation_id: CONVERSATION,
    });
    expect(JSON.stringify(audit)).not.toContain(ACCOUNT);
    expect(JSON.stringify(audit)).not.toContain('Priya');

    expect(await live.conversationTurns(CONVERSATION)).toEqual([
      {
        turn_id: 'trn_1',
        protected: 2,
        categories: [
          { category: 'name', count: 1 },
          { category: 'account', count: 1 },
        ],
        route: 'cloud',
      },
    ]);
    expect(await router().reveal(CONVERSATION, SPACE, 'trn_1')).toEqual({
      items: [
        { placeholder: '⟦NAME_1⟧', category: 'name', value: 'Priya Rivera' },
        { placeholder: '⟦ACCOUNT_1⟧', category: 'account', value: ACCOUNT },
      ],
    });
  });

  test('a private space asks once, and the recorded answer decides the next attempt', async () => {
    const live = router();
    await updateSettings(live, SPACE, { private_space: true });
    const bundle = (attempt: string, text: string) =>
      ({
        attempt: { id: attempt, job_id: CONVERSATION, epoch: 1, revision: 0, token: 't' },
        job: { objective: 'Help with bills' },
        inputs: {
          new_user_messages: [{ role: 'user', content: text, at: new Date().toISOString() }],
        },
      }) as unknown as AttemptBundle;
    const asked = await live.beforeAttempt(bundle(ATTEMPT, 'hello'), 'chat/completions');
    expect(asked.proceed).toBe(false);
    // The gateway refuses in the meantime.
    const refused = await live
      .prepare({
        principal: principal(CONVERSATION),
        provider,
        protocol: 'chat/completions',
        body: ask('hello'),
      })
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(refused).toBe('privacy_confirmation_required');

    await sql`insert into question (id, job_id, attempt_id, space_id, text, because, if_ignored, state, answer)
      values ('q_1', ${CONVERSATION}, ${ATTEMPT}, ${SPACE}, 'Send?', '["job:x"]'::jsonb, 'waits', 'answered', ${SEND_REDACTED})`;
    const next = 'att_01JPRIVACY0000000000000001';
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id)
      values (${next}, ${CONVERSATION}, 2, 'test', 'fireworks', 'm', 'trn_1')`;
    expect(await live.beforeAttempt(bundle(next, SEND_REDACTED), 'chat/completions')).toEqual({
      proceed: true,
    });
    const [state] =
      await sql`select consent from privacy_conversation where conversation_id = ${CONVERSATION}`;
    expect(state?.consent).toBe('allowed');
    const sent = await live.prepare({
      principal: principal(CONVERSATION),
      provider,
      protocol: 'chat/completions',
      body: ask(`account ${ACCOUNT}`),
    });
    expect((sent.body.messages as { content: string }[])[0]?.content).toBe('account ⟦ACCOUNT_1⟧');
    expect(KEEP_PRIVATE).not.toBe(SEND_REDACTED);
  });
});
