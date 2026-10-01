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
  privacy: { kind: 'job' },
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

  test('a topic once found stays found, whatever other writes land beside it', async () => {
    const store = new PostgresPrivacyStore(sql, () => KEY);
    await store.updateConversation(CONVERSATION, SPACE, { askedAttemptId: ATTEMPT });
    // The gate recording questions and answers while the router marks the topic.
    await Promise.all([
      store.updateConversation(CONVERSATION, SPACE, { sensitive: 'therapy' }),
      ...Array.from({ length: 20 }, (_, i) =>
        store.updateConversation(CONVERSATION, SPACE, {
          askedAttemptId: i % 2 ? null : ATTEMPT,
          consentTurnId: `trn_${i}`,
        }),
      ),
    ]);
    // A write that names the topic as empty does not clear it either.
    await store.updateConversation(CONVERSATION, SPACE, { sensitive: null, consent: 'declined' });
    const state = await store.conversation(CONVERSATION);
    expect(state.sensitive).toBe('therapy');
    expect(state.consent).toBe('declined');
    // Only the named fields change.
    await store.updateConversation(CONVERSATION, SPACE, { consent: 'allowed' });
    expect(await store.conversation(CONVERSATION)).toMatchObject({
      sensitive: 'therapy',
      consent: 'allowed',
    });
  });

  test('the person clears a topic, and the router cannot set it again', async () => {
    const store = new PostgresPrivacyStore(sql, () => KEY);
    await store.updateConversation(CONVERSATION, SPACE, {
      sensitive: 'therapy',
      consent: 'allowed',
      askedAttemptId: ATTEMPT,
    });
    await store.markConversation(CONVERSATION, SPACE, null);
    expect(await store.conversation(CONVERSATION)).toMatchObject({
      sensitive: null,
      cleared: true,
      consent: null,
      // An open question stays the conversation's, so its answer is still a decision.
      askedAttemptId: ATTEMPT,
    });
    await store.updateConversation(CONVERSATION, SPACE, { sensitive: 'therapy' });
    expect(await store.conversation(CONVERSATION)).toMatchObject({
      sensitive: null,
      cleared: true,
    });
    // The person's own marking does set it.
    await store.markConversation(CONVERSATION, SPACE, 'finance');
    expect(await store.conversation(CONVERSATION)).toMatchObject({
      sensitive: 'finance',
      cleared: false,
    });
  });

  test('marking the space or an agent private takes back an earlier "send a redacted version"', async () => {
    const live = router();
    const store = live.store;
    await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values ('agt_counsel', ${SPACE}, 'Counsel', 'listener', 'blue', 'soft', 'brown', 'warm', ''),
        ('agt_errands', ${SPACE}, 'Errands', 'helper', 'green', 'soft', 'brown', 'warm', '')`;
    const withAgent = 'job_01JPRIVACYAGENT0000000000';
    const otherAgent = 'job_01JPRIVACYOTHER0000000000';
    await sql`insert into job (id, space_id, title, objective, kind, agent_id)
      values (${withAgent}, ${SPACE}, 'Talk', 'Talk', 'chat', 'agt_counsel'),
        (${otherAgent}, ${SPACE}, 'Errands', 'Errands', 'chat', 'agt_errands')`;
    for (const id of [CONVERSATION, withAgent, otherAgent])
      await store.updateConversation(id, SPACE, { sensitive: 'finance', consent: 'allowed' });

    await updateSettings(live, SPACE, { private_agent_ids: ['agt_counsel'] });
    expect((await store.conversation(withAgent)).consent).toBeNull();
    expect((await store.conversation(otherAgent)).consent).toBe('allowed');
    expect((await store.conversation(CONVERSATION)).consent).toBe('allowed');
    const refused = await live
      .prepare({
        principal: principal(withAgent),
        provider,
        protocol: 'chat/completions',
        body: ask('hello'),
      })
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(refused).toBe('privacy_confirmation_required');

    await updateSettings(live, SPACE, { private_space: true });
    expect((await store.conversation(otherAgent)).consent).toBeNull();
    expect((await store.conversation(CONVERSATION)).consent).toBeNull();
    // The topic the answer was about is untouched.
    expect((await store.conversation(CONVERSATION)).sensitive).toBe('finance');
  });

  test('a memory call carries its conversation, so a sensitive conversation stays off the cloud model', async () => {
    const live = router();
    await live.store.updateConversation(CONVERSATION, SPACE, { sensitive: 'therapy' });
    const memoryCall = (sourceJobId: string | null, spaceId = SPACE): GatewayPrincipal => ({
      ...principal(`memory:${spaceId}`),
      attemptId: 'memory:work_1',
      privacy: { kind: 'service', purpose: 'memory', spaceId, sourceJobId },
    });
    // On its own this sentence names no topic, so only the conversation can keep it private.
    const body = ask('I cried at work again, same as with my dad.');
    const outcome = (caller: GatewayPrincipal) =>
      live.prepare({ principal: caller, provider, protocol: 'chat/completions', body }).then(
        (prepared) => prepared.route,
        (error: { code?: string }) => error.code,
      );
    expect(await outcome(memoryCall(CONVERSATION))).toBe('privacy_confirmation_required');
    // A job the conversation started is the same conversation.
    expect(await outcome(memoryCall(CHILD))).toBe('privacy_confirmation_required');
    // A call that carries no conversation is routed on its own words.
    expect(await outcome(memoryCall(null))).toBe('cloud');
    // A conversation from another space, or one that does not exist, is refused.
    expect(await outcome(memoryCall(CONVERSATION, 'sp_01JOTHERSPACE00000000000000'))).toBe(
      'privacy_scope_mismatch',
    );
    expect(await outcome(memoryCall('job_01JNOSUCHJOB000000000000000'))).toBe(
      'privacy_scope_unknown',
    );
    // What a memory call carries does not mark the conversation it names.
    const plain = 'job_01JPRIVACYPLAIN0000000000';
    await sql`insert into job (id, space_id, title, objective, kind)
      values (${plain}, ${SPACE}, 'Plain', 'Plain', 'chat')`;
    const carried = await live
      .prepare({
        principal: memoryCall(plain),
        provider,
        protocol: 'chat/completions',
        body: ask('Summarise my therapy session notes from Tuesday.'),
      })
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(carried).toBe('privacy_confirmation_required');
    expect((await live.store.conversation(plain)).sensitive).toBeNull();
    // Once the person agreed to a redacted version, memory may read it redacted too.
    await live.store.updateConversation(CONVERSATION, SPACE, { consent: 'allowed' });
    expect(await outcome(memoryCall(CONVERSATION))).toBe('cloud');
  });
});
