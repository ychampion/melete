/**
 * A new person's first session, end to end, against the service as it starts:
 * a fresh database, the real service app, setup, an onboarding answer saved to
 * memory, an agent, a chat that drafts an email, and that draft sent only after
 * the person allows it. Each step is one a first-time user takes in the web app;
 * a break anywhere along it is a break a new user meets on their first visit.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AttemptBundle, JobConstraints, RuntimeAdapter } from '@melete/contracts';
import { EmailConnector, emailManifest } from '../../src/connectors/email.ts';
import type { MailTransport, OutgoingMail } from '../../src/connectors/mail-transport.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-new-user-'));
const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

/** The mailbox the person connects: every message it is asked to send, and nothing else. */
class FixtureMailbox implements MailTransport {
  readonly sent: OutgoingMail[] = [];
  async search() {
    return [];
  }
  async read() {
    return null;
  }
  async send(message: OutgoingMail) {
    this.sent.push(message);
    return { messageId: message.messageId, sentCopy: true, accepted: message.to, rejected: [] };
  }
  async findSent(messageId: string) {
    return this.sent.some((message) => message.messageId === messageId);
  }
  async health() {}
}

/** A free local port for the effect listener, which the runtime reaches over HTTP. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

const DRAFT = {
  to: ['alex@example.test'],
  subject: 'Dinner on Friday',
  body: 'Hi Alex, are you free for dinner on Friday at seven?',
};
const ANSWER = 'I drafted the email to Alex for you to review.';

(fixture ? test : test.skip)(
  'a new person sets up, saves an answer, chats, and sends a draft only once they allow it',
  async () => {
    if (!fixture) throw new Error('Postgres unavailable');
    const port = freePort();
    const brokerUrl = `http://127.0.0.1:${port}`;
    const mailbox = new FixtureMailbox();
    let mailboxId = '';
    // The scripted model for the chat: it drafts the email through the effect
    // listener with the attempt's capability, as the engine does, then answers.
    const stub = new StubRuntimeAdapter({
      onTool: async (_callId, args, bundle) => {
        const response = await fetch(`${brokerUrl}/actions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bundle.attempt.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ connection_id: mailboxId, kind: 'email.draft', payload: args }),
        });
        const action = (await response.json()) as Record<string, unknown>;
        if (response.status !== 201) throw new Error(`Draft refused: ${JSON.stringify(action)}`);
        return { action_id: String(action.id), status: String(action.status) };
      },
    });
    const script: StubStep[] = [
      { type: 'tool', tool: 'email.draft', call_id: 'call_draft', arguments: DRAFT },
      { type: 'text_delta', text: ANSWER },
      { type: 'outcome', outcome: { kind: 'completed', summary: ANSWER, evidence: [] } },
    ];
    const scripted: RuntimeAdapter = {
      capabilities: () => stub.capabilities(),
      start: (bundle: AttemptBundle, sink, signal) =>
        stub.start(
          {
            ...bundle,
            job: {
              ...bundle.job,
              constraints: { ...bundle.job.constraints, script } as unknown as JobConstraints,
            },
          },
          sink,
          signal,
        ),
    };
    const running = await bootstrap({
      workers: false,
      effects: true,
      runtime: scripted,
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: fixture.url,
        MELETE_CAPABILITY_KEY: 'new-user-journey-capability-key-32-chars',
        MELETE_APPROVAL_KEY: 'new-user-journey-approval-key-32-characters',
        MELETE_RUNTIME_ADAPTER: 'stub',
        MELETE_SPACES_DIR: join(root, 'spaces'),
        MELETE_WORK_DIR: join(root, 'work'),
        MELETE_BROKER_BIND: `127.0.0.1:${port}`,
        MELETE_BROKER_URL: brokerUrl,
      }),
    });
    try {
      const app = running.app;
      let cookie = '';
      const call = (path: string, method = 'GET', body?: unknown) =>
        app.request(path, {
          method,
          headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

      // The web app asks whether this installation still needs its first account.
      expect(await (await call('/setup')).json()).toEqual({ needed: true });
      const setup = await call('/setup', 'POST', {
        email: 'new@example.test',
        password: 'a-new-person-password',
      });
      expect(setup.status).toBe(201);
      cookie =
        setup.headers
          .getSetCookie()
          .map((value) => value.split(';')[0] ?? '')
          .find((value) => value.startsWith('melete_session=')) ?? '';
      expect(cookie).not.toBe('');
      expect(await (await call('/setup')).json()).toEqual({ needed: false });

      // The first onboarding question is answered into memory, on a space no job has touched.
      const saved = await call('/memory/items', 'POST', {
        key: 'pref.home.city',
        value: 'Lisbon',
        statement: 'Where are you based? Lisbon.',
      });
      const savedBody = (await saved.json()) as { item?: { value: string }; status?: string };
      expect([saved.status, savedBody.status, savedBody.item?.value]).toEqual([
        200,
        undefined,
        'Lisbon',
      ]);

      // The person connects their mailbox.
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space || !running.registry) throw new Error('Missing personal space or registry');
      mailboxId = newId('conn');
      await fixture.sql`insert into connection (id, space_id, provider, label, scopes, status)
        values (${mailboxId}, ${space.id}, ${emailManifest.provider}, 'Mail',
          ${JSON.stringify(emailManifest.tools.map((tool) => tool.name))}::jsonb, 'active')`;
      running.registry.register(
        mailboxId,
        new EmailConnector(
          {
            id: mailboxId,
            spaceId: String(space.id),
            secretRef: 'fixture',
            username: 'new@example.test',
            from: 'new@example.test',
            imap: { host: 'imap.example.test', port: 993, secure: true },
            smtp: { host: 'smtp.example.test', port: 465, secure: true },
          },
          { withSecret: async (_id, _space, use) => use('fixture-password') },
          () => mailbox,
        ),
      );

      // An agent taken straight from a template reaches every connection in the space.
      const { templates } = (await (await call('/agents/templates')).json()) as {
        templates: Array<{ agent: Record<string, unknown> }>;
      };
      const made = await call('/agents', 'POST', templates[0]?.agent);
      expect(made.status).toBe(200);
      const { agent } = (await made.json()) as {
        agent: { id: string; allowed_connection_ids: string[] | null };
      };
      expect(agent.allowed_connection_ids).toBeNull();

      // A chat asking for an email draft runs one turn to its end.
      const started = await call('/conversations', 'POST', {
        title: 'Dinner',
        agent_id: agent.id,
      });
      const { conversation } = (await started.json()) as { conversation: { id: string } };
      const asked = await call(`/conversations/${conversation.id}/messages`, 'POST', {
        text: 'Draft an email asking Alex to dinner on Friday',
      });
      expect(asked.status).toBeLessThan(300);
      const row = await running.jobs?.get(conversation.id);
      if (!row || !running.runner) throw new Error('Missing conversation job');
      await running.runner.handleWake({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      });
      const turns = (await (await call(`/conversations/${conversation.id}/messages`)).json()) as {
        turns: Array<{ status: string; answer: string }>;
      };
      expect(turns.turns.at(-1)).toMatchObject({ status: 'done', answer: ANSWER });
      const stream = (await (
        await call(`/conversations/${conversation.id}/events?limit=200`)
      ).json()) as { events: Array<{ item: { type: string; status?: string } }> };
      expect(
        stream.events.some((event) => event.item.type === 'status' && event.item.status === 'done'),
      ).toBe(true);

      // The draft's card offers to send it.
      const { cards } = (await (await call(`/conversations/${conversation.id}/cards`)).json()) as {
        cards: Array<{ primary_action: { kind: string; handle: string } | null }>;
      };
      const send = cards.find((card) => card.primary_action?.kind === 'send')?.primary_action;
      if (!send) throw new Error('The draft card offers no send action');
      const draftId = send.handle;

      type Permission = { id: string; version: string };
      const ask = async () => {
        const requested = await call(`/drafts/${draftId}/send`, 'POST');
        expect(requested.status).toBe(200);
        const body = (await requested.json()) as { permission: Permission | null };
        if (!body.permission) throw new Error('Sending asked for no permission');
        return body.permission;
      };
      const decide = async (permission: Permission, option: 'deny' | 'allow_once') =>
        (
          await call(`/permissions/${permission.id}`, 'POST', {
            option,
            version: permission.version,
          })
        ).status;
      const draftStatus = async () =>
        (
          (await (await call(`/conversations/${conversation.id}/drafts`)).json()) as {
            drafts: Array<{ id: string; status: string }>;
          }
        ).drafts.find((draft) => draft.id === draftId)?.status;

      // Sending asks first; a refusal sends nothing.
      const first = await ask();
      expect(mailbox.sent).toHaveLength(0);
      expect(await decide(first, 'deny')).toBe(200);
      expect(mailbox.sent).toHaveLength(0);
      expect(await draftStatus()).toBe('denied');

      // Asking again is a new request; allowing it once sends exactly one email.
      const second = await ask();
      expect(second.id).not.toBe(first.id);
      expect(await decide(second, 'allow_once')).toBe(200);
      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0]).toMatchObject({ to: DRAFT.to, subject: DRAFT.subject });
      expect(await draftStatus()).toBe('sent');
      const sends = await fixture.sql`select status, receipt from action
        where kind = 'email.send' and status = 'succeeded'`;
      expect(sends).toHaveLength(1);
      expect(sends[0]?.receipt).toBeTruthy();
    } finally {
      await running.close();
    }
  },
  180_000,
);
