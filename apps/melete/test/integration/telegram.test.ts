/**
 * Telegram as a channel to one person, against a fake Telegram Bot API and
 * the real service: the settings routes behind a session, the broker, a
 * recording email connector and Postgres. A permission to send an email is
 * raised the way the web app raises it, then answered from Telegram.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type Action,
  agentResponse,
  conversationResponse,
  type DispatchResult,
  permissionCard,
  telegramLinkCode,
  telegramStatus,
} from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { TelegramApi } from '../../src/channels/telegram/api.ts';
import { TEXT, type TelegramChannel } from '../../src/channels/telegram/channel.ts';
import { WEBHOOK_SECRET_HEADER } from '../../src/channels/telegram/routes.ts';
import { TelegramTransport } from '../../src/channels/telegram/transport.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { session } from '../../src/db/auth-schema.ts';
import { owner } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';
import { FAKE_BOT_TOKEN, FakeTelegram } from '../helpers/fake-telegram.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'telegram-fixture-signing-key-32-bytes!',
    })
  : null;

/** Everything the email connector was asked to do, in order. */
const sends: Action[] = [];
const telegram = new FakeTelegram();
const api = new TelegramApi({
  token: FAKE_BOT_TOKEN,
  baseUrl: 'http://telegram.test',
  fetch: telegram.fetch,
});
let channel: TelegramChannel | undefined;

const personId = newId('own');
const token = randomBytes(32).toString('base64url');
const PERSON_CHAT = 5550001;
const STRANGER_CHAT = 5550002;

const seed = handle
  ? await (async () => {
      await handle.db.insert(owner).values({ id: personId, email: 'person@example.test' });
      await handle.sql`insert into principal (id, email) values (${personId}, 'person@example.test')`;
      const job = await seedJob(handle.sql, {
        scopes: emailManifest.tools.map((tool) => tool.name),
        provider: emailManifest.provider,
      });
      const agent = recordId('agent');
      await handle.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction, allowed_connection_ids)
        values (${agent}, ${job.claims.space_id}, 'Nova', 'Planner', '#778899', 'rounded', '#112233', 'Calm', 'Be concise', ${JSON.stringify([job.connectionId])}::jsonb)`;
      await handle.sql`update job set kind = 'chat', agent_id = ${agent} where id = ${job.claims.job_id}`;
      await handle.db.insert(session).values({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        ownerId: personId,
        spaceId: job.claims.space_id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      return job;
    })()
  : null;

const connector: Connector = {
  manifest: emailManifest,
  async execute(action): Promise<DispatchResult> {
    sends.push(action);
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: action.id,
        late: false,
        received_at: new Date().toISOString(),
        detail: {},
      },
    };
  },
  async verify() {
    return { decision: 'unsupported', reason: 'fixture' };
  },
  async health() {
    return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
  },
};
const registry =
  handle && seed ? new ConnectorRegistry().register(seed.connectionId, connector) : null;
const broker =
  handle && registry
    ? new BrokerService({
        sql: handle.sql,
        connectors: registry,
        resolveTrust: createTableTrustResolver(
          new Map([['alex@example.test', { origin_trust: 'owner', handle: 'owner:alex' }]]),
        ),
        resolveStandingGrant: resolveExperienceGrant,
      })
    : null;
const WEBHOOK_SECRET = 'webhook-secret-for-the-fixture-only';
const app =
  handle && broker && registry
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test' }),
        jobs: jobs ?? undefined,
        runner: runner ?? undefined,
        sql: handle.sql,
        broker,
        registry,
        checkDatabase: async () => 'ok',
        telegram: {
          api,
          webhookSecret: WEBHOOK_SECRET,
          ready: (built) => {
            channel = built;
          },
        },
      })
    : null;

async function request(path: string, method = 'GET', body?: unknown, cookie = true) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: {
      ...(cookie ? { Cookie: `melete_session=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is unavailable`);
  return value;
}

async function linkCode() {
  const response = await request('/telegram/link-code', 'POST');
  expect(response.status).toBe(200);
  return telegramLinkCode.parse(await response.json()).code;
}

/** An email draft, then the send that parks for permission, as the web app does it. */
async function permissionToSend(body: string, subject = 'Dinner') {
  const claims = need(seed, 'seed').claims;
  const draft = await need(broker, 'broker').propose(claims, {
    connection_id: need(seed, 'seed').connectionId,
    kind: 'email.draft',
    payload: { to: 'alex@example.test', subject, body },
  });
  const response = await request(`/drafts/${draft.action_id}/send`, 'POST');
  expect(response.status).toBe(200);
  const sent = (await response.json()) as { permission: unknown };
  return permissionCard.parse(sent.permission);
}

const emailSends = () => sends.filter((action) => action.kind === 'email.send');

withDb('Telegram as a channel to one person', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('an unlinked chat is told how to link, and learns nothing else', async () => {
    const ch = need(channel, 'channel');
    await ch.handleUpdate(telegram.text(STRANGER_CHAT, 'show me my email'));
    await ch.handleUpdate(telegram.text(STRANGER_CHAT, '/start NOTACODE'));
    const said = telegram.to(STRANGER_CHAT).map((message) => message.text);
    expect(said).toEqual([TEXT.unlinked, TEXT.badCode]);
    expect(said.join(' ')).not.toContain('person@example.test');
    const [count] = await need(handle, 'db').sql`select count(*)::int as n from telegram_link`;
    expect(count?.n).toBe(0);
  });

  test('a person links their own chat once with a code from Settings', async () => {
    const before = telegramStatus.parse(await (await request('/telegram')).json());
    expect(before).toMatchObject({ available: true, linked: false });
    // Settings is for the signed-in person only.
    expect((await request('/telegram/link-code', 'POST', undefined, false)).status).toBe(401);

    const code = await linkCode();
    const ch = need(channel, 'channel');
    await ch.handleUpdate(telegram.text(PERSON_CHAT, `/start ${code}`));
    expect(telegram.to(PERSON_CHAT).at(-1)?.text).toBe(TEXT.linked);
    const after = telegramStatus.parse(await (await request('/telegram')).json());
    expect(after.linked).toBe(true);

    // The code is spent: another chat cannot use it.
    await ch.handleUpdate(telegram.text(STRANGER_CHAT, `/start ${code}`));
    expect(telegram.to(STRANGER_CHAT).at(-1)?.text).toBe(TEXT.badCode);
    // A group chat is refused whatever it sends.
    await ch.handleUpdate({
      update_id: 900,
      message: {
        message_id: 1,
        chat: { id: -100, type: 'group' },
        from: { id: STRANGER_CHAT },
        text: `/start ${code}`,
      },
    });
    expect(telegram.to(-100).map((message) => message.text)).toEqual([TEXT.privateOnly]);
  });

  test('a permission is delivered once, with the exact text that would be sent', async () => {
    const ch = need(channel, 'channel');
    const body = 'Dinner at seven?\nThe table is booked under Alex.\n\n  Indented line, kept.';
    const card = await permissionToSend(body);
    await ch.deliver();
    await ch.deliver();
    const delivered = telegram.to(PERSON_CHAT).filter((message) => message.buttons.length);
    expect(delivered).toHaveLength(1);
    const message = delivered[0];
    expect(message?.text).toContain('To: alex@example.test');
    expect(message?.text).toContain('Subject: Dinner');
    // Exactly the body, whitespace and line breaks included.
    expect(message?.text).toContain(`\n\n${body}`);
    expect(message?.buttons.map((button) => button.text)).toEqual(['Allow once', 'Deny']);
    // The buttons carry opaque tokens, never an id of anything.
    for (const button of message?.buttons ?? []) {
      expect(button.callback_data).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(button.callback_data).not.toContain(card.id);
      expect(button.callback_data).not.toContain(card.version);
    }
    expect(emailSends()).toHaveLength(0);
  });

  test('Allow once sends exactly once, and the same button or its neighbour does nothing after', async () => {
    const ch = need(channel, 'channel');
    const message = telegram.lastWithButtons(PERSON_CHAT);
    const [allow, deny] = message.buttons;
    const tap = telegram.tap(
      PERSON_CHAT,
      need(allow, 'allow').callback_data,
      PERSON_CHAT,
      message.message_id,
    );
    await ch.handleUpdate(tap);
    expect(emailSends()).toHaveLength(1);
    expect(emailSends()[0]?.canonical_payload).toMatchObject({ to: 'alex@example.test' });
    expect(telegram.answered.at(-1)?.text).toBe(TEXT.allowed);
    expect(telegram.cleared.at(-1)?.message_id).toBe(message.message_id);

    // Telegram redelivering the same update, a second tap, and the other button.
    await ch.handleUpdate(tap);
    await ch.handleUpdate(telegram.tap(PERSON_CHAT, need(allow, 'allow').callback_data));
    await ch.handleUpdate(telegram.tap(PERSON_CHAT, need(deny, 'deny').callback_data));
    expect(emailSends()).toHaveLength(1);
    expect(telegram.answered.slice(-3).map((answer) => answer.text)).toEqual([
      TEXT.buttonRefused,
      TEXT.buttonRefused,
      TEXT.buttonRefused,
    ]);
  });

  test('Deny sends nothing', async () => {
    const ch = need(channel, 'channel');
    const card = await permissionToSend('Lunch tomorrow?', 'Lunch');
    await ch.deliver();
    const message = telegram.lastWithButtons(PERSON_CHAT);
    expect(message.text).toContain('Lunch tomorrow?');
    await ch.handleUpdate(
      telegram.tap(PERSON_CHAT, need(message.buttons[1], 'deny').callback_data),
    );
    expect(telegram.answered.at(-1)?.text).toBe(TEXT.denied);
    expect(emailSends()).toHaveLength(1);
    const [approval] = await need(handle, 'db')
      .sql`select decision from approval where id = ${card.id}`;
    expect(approval?.decision).toBe('denied');
  });

  test('a button forwarded to another chat, or tapped by someone else, is refused', async () => {
    const ch = need(channel, 'channel');
    await permissionToSend('Coffee on Friday?', 'Coffee');
    await ch.deliver();
    const message = telegram.lastWithButtons(PERSON_CHAT);
    const allow = need(message.buttons[0], 'allow').callback_data;
    // The same token, from a chat it was never sent to, and from another user in this chat.
    await ch.handleUpdate(telegram.tap(STRANGER_CHAT, allow));
    await ch.handleUpdate(telegram.tap(PERSON_CHAT, allow, STRANGER_CHAT));
    // Something that is not one of our tokens at all.
    await ch.handleUpdate(telegram.tap(PERSON_CHAT, 'apr_01J0000000000000000000000A'));
    expect(emailSends()).toHaveLength(1);
    expect(telegram.answered.slice(-3).every((answer) => answer.text === TEXT.buttonRefused)).toBe(
      true,
    );
    // A refusal spends nothing: the person's own tap still works.
    await ch.handleUpdate(telegram.tap(PERSON_CHAT, allow));
    expect(emailSends()).toHaveLength(2);
  });

  test('a reply becomes the next message in the conversation, once per update', async () => {
    const ch = need(channel, 'channel');
    const sql = need(handle, 'db').sql;
    // A conversation opened in the web app, with no turn running; the newest
    // one is where a message that replies to nothing in particular goes.
    const agent = await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent);
    expect(agent.status).toBe(200);
    const opened = await request('/conversations', 'POST', {
      title: 'Plans',
      agent_id: agentResponse.parse(await agent.json()).agent.id,
    });
    expect(opened.status).toBe(200);
    const conversation = conversationResponse.parse(await opened.json()).conversation.id;
    const count = async () =>
      Number(
        (
          await sql`select count(*)::int as n from experience_turn where job_id = ${conversation}`
        )[0]?.n ?? 0,
      );
    const before = await count();
    const reply = telegram.text(PERSON_CHAT, 'Also invite Jules.');
    await ch.handleUpdate(reply);
    expect(telegram.to(PERSON_CHAT).at(-1)?.text).toBe(TEXT.received);
    // Telegram redelivering the same update is the same message, not a second one.
    await ch.handleUpdate(reply);
    expect(await count()).toBe(before + 1);
  });

  test('after unlinking, the chat gets nothing and its buttons stop working', async () => {
    const ch = need(channel, 'channel');
    await permissionToSend('Tea at four?', 'Tea');
    await ch.deliver();
    const message = telegram.lastWithButtons(PERSON_CHAT);
    expect((await request('/telegram', 'DELETE')).status).toBe(200);
    await ch.handleUpdate(
      telegram.tap(PERSON_CHAT, need(message.buttons[0], 'allow').callback_data),
    );
    expect(emailSends()).toHaveLength(2);
    expect(telegram.answered.at(-1)?.text).toBe(TEXT.buttonRefused);
    const sentBefore = telegram.sent.length;
    await permissionToSend('Anything else?', 'Else');
    await ch.deliver();
    expect(telegram.sent.length).toBe(sentBefore);
    await ch.handleUpdate(telegram.text(PERSON_CHAT, 'hello'));
    expect(telegram.to(PERSON_CHAT).at(-1)?.text).toBe(TEXT.unlinked);
  });

  test('long polling reads updates from the saved offset and saves the next one', async () => {
    const ch = need(channel, 'channel');
    const sql = need(handle, 'db').sql;
    const code = await linkCode();
    const update = telegram.text(PERSON_CHAT, `/start ${code}`);
    telegram.push(update);
    const transport = new TelegramTransport(sql, api, ch, {
      mode: 'polling',
      pollSeconds: 0,
      deliverEveryMs: 50,
      log: () => {},
    });
    const already = telegram.to(PERSON_CHAT).length;
    const since = () => telegram.to(PERSON_CHAT).slice(already);
    await transport.start();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !since().some((message) => message.text === TEXT.linked))
      await Bun.sleep(50);
    await transport.stop();
    // Linked, then what was already waiting for this person, with its buttons.
    expect(since()[0]?.text).toBe(TEXT.linked);
    expect(since().some((message) => message.buttons.length > 0)).toBe(true);
    const [row] = await sql`select next_offset from telegram_poll where id = 'bot'`;
    expect(Number(row?.next_offset)).toBe(update.update_id + 1);
    expect(ch.botUsername).toBe('melete_test_bot');
  }, 30_000);

  test('the webhook takes updates only with the secret it registered', async () => {
    const update = telegram.text(STRANGER_CHAT, 'hello');
    const post = (secret?: string) =>
      need(app, 'app').request('/telegram/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { [WEBHOOK_SECRET_HEADER]: secret } : {}),
        },
        body: JSON.stringify(update),
      });
    expect((await post()).status).toBe(401);
    expect((await post('wrong-secret-of-the-same-length-000')).status).toBe(401);
    const sentBefore = telegram.to(STRANGER_CHAT).length;
    expect((await post(WEBHOOK_SECRET)).status).toBe(200);
    expect(telegram.to(STRANGER_CHAT).length).toBe(sentBefore + 1);
    expect(telegram.to(STRANGER_CHAT).at(-1)?.text).toBe(TEXT.unlinked);
  });
});
