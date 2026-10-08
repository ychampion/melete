import { afterEach, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { BrowserWorkerClient } from '../workers/browser/client.ts';
import type { BrowserSessionService } from '../workers/browser/routes.ts';
import type { BrowserSession } from '../workers/browser/sessions.ts';
import { createBrowserConnector } from './browser.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

const intent = {
  url: 'https://book.example/reserve',
  method: 'POST',
  role: 'button',
  name: 'Book',
  form_hash: 'a'.repeat(64),
  body_sha256: 'b'.repeat(64),
  fields: { party: '6' },
};

/** A worker whose pages are scripted: what a submit lands on, then what each later look sees. */
function worker(pages: { submit: JsonObject; looks?: JsonObject[] }) {
  const operations: string[] = [];
  const handOffs: Array<{ reason: string; service: string; action_id?: string | null }> = [];
  const parks: string[] = [];
  const session: BrowserSession = {
    id: 'brws_fixture',
    space_id: 'sp_01',
    profile_dir: 'private-to-worker',
    job_id: 'job_01',
    control_epoch: 4,
    control: 'automation',
    warm_until: Date.now() + 300_000,
  };
  const looks = [...(pages.looks ?? [])];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as JsonObject;
      const kind = String((body.operation as JsonObject).kind);
      operations.push(kind);
      const page = kind === 'submit' ? pages.submit : (looks.shift() ?? pages.submit);
      return Response.json({
        session_id: session.id,
        control_epoch: session.control_epoch,
        observation: {
          id: `obs_${operations.length}`,
          url: String(page.url ?? 'https://book.example/after'),
          title: String(page.title ?? ''),
          tree: String(page.tree ?? ''),
          screenshot: '',
          schema: (page.schema as JsonObject[] | undefined) ?? [],
        },
        result: {
          submit_intents: (page.forms as JsonObject[] | undefined) ?? [],
          ...(page.challenge === true ? { challenge: true } : {}),
        },
      });
    },
  });
  servers.push(server);
  const client = new BrowserWorkerClient(server.url.href, 'x'.repeat(32));
  const sessions: Pick<BrowserSessionService, 'lease' | 'park' | 'handOff'> = {
    lease: async () => ({ session, worker: client, opened: false }),
    park: async (_ctx, _id, reason) => {
      parks.push(reason);
    },
    handOff: async (_scope, _id, input) => {
      handOffs.push(input);
      return null;
    },
  };
  const connector = createBrowserConnector({
    sessions,
    artifacts: async (_ctx, observation) => ({ id: observation.id }),
    secondLookMs: 1,
  });
  return { connector, operations, handOffs, parks };
}

const submit = (fields: Record<string, string> = intent.fields) =>
  connectorAction('browser.submit', {
    session_id: 'brws_fixture',
    control_epoch: 4,
    intent: { ...intent, fields },
  });
/** Dispatched after the person answered for it: one of the risks only they let through. */
const asked = (action: ReturnType<typeof submit>) => ({ ...connectorContext(action), asked: true });

test('a submit the page confirms is done, and the receipt says what the page said', async () => {
  const w = worker({
    submit: { tree: '- heading "Your table is booked"\n- paragraph: Thank you' },
  });
  const action = submit();
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  if (result.outcome !== 'succeeded') return;
  expect(result.receipt.detail.read_back).toMatchObject({ verdict: 'done', looks: 1 });
  expect(w.operations).toEqual(['submit']);
});

test('a submit the page refuses is not done, with the reason, and is not handed over', async () => {
  const w = worker({ submit: { tree: '- alert: That time is no longer available' } });
  const action = submit();
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result).toMatchObject({ outcome: 'failed', retryable: false });
  if (result.outcome !== 'failed') return;
  expect(result.reason).toContain('no longer available');
  expect(result.evidence?.read_back).toMatchObject({ verdict: 'not_done' });
  expect(w.handOffs).toHaveLength(0);
});

test('a page that settles on a second look is decided by it', async () => {
  const w = worker({
    submit: { tree: '- heading "Book a table"' },
    looks: [{ tree: '- status: Reservation confirmed' }],
  });
  const action = submit();
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  expect(w.operations).toEqual(['submit', 'observe']);
});

test('after a submit the person answered for, a page unclear twice is unknown and goes to them', async () => {
  const w = worker({ submit: { tree: '- heading "Book a table"' } });
  const action = submit();
  const result = await w.connector.execute(action, asked(action));
  expect(result.outcome).toBe('unknown');
  if (result.outcome !== 'unknown') return;
  expect(result.evidence?.read_back).toMatchObject({ verdict: 'unclear', looks: 2 });
  expect(w.handOffs).toEqual([
    { reason: 'unclear', service: 'book.example', action_id: action.id },
  ]);
  expect(w.operations.filter((kind) => kind === 'submit')).toHaveLength(1);
});

test('a submit nobody had to answer for, on a page that does not say, is sent and unconfirmed', async () => {
  // A page in another language says nothing the read-back knows either.
  for (const tree of ['- heading "Book a table"', '- heading "Reserva recibida, gracias"']) {
    const w = worker({ submit: { tree } });
    const action = submit();
    const result = await w.connector.execute(action, connectorContext(action));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.receipt.detail).toMatchObject({
      unconfirmed: true,
      read_back: { verdict: 'unclear', looks: 2 },
    });
    expect(w.handOffs).toHaveLength(0);
  }
});

test('the receipt carries what the form sent, with secrets blanked', async () => {
  const w = worker({ submit: { tree: '- heading "Your table is booked"' } });
  const action = submit({ party: '6', name: 'Ada', notes: '', csrf_token: 'f00dfeed' });
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  if (result.outcome !== 'succeeded') return;
  expect(result.receipt.detail.submitted).toEqual({
    party: '6',
    name: 'Ada',
    csrf_token: '[redacted]',
  });
});

test('a page that shows back the form without a value it was sent is not done, naming it', async () => {
  const w = worker({
    submit: { tree: '- text: {"form": {"custname": "Ada Lovelace", "custtel": "555-0100"}}' },
  });
  const action = submit({ custname: 'Ada Lovelace', custtel: '555-0100', size: 'medium' });
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result).toMatchObject({ outcome: 'failed', retryable: false });
  if (result.outcome !== 'failed') return;
  expect(result.reason).toContain('except size');
});

test('a captcha after a submit goes straight to the person, and the submit stays unknown', async () => {
  const w = worker({ submit: { challenge: true } });
  const action = submit();
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('unknown');
  expect(w.handOffs[0]).toMatchObject({ reason: 'captcha', service: 'book.example' });
  expect(w.operations).toEqual(['submit']);
});

test('a check on a page the agent opens hands the work over, with no submit', async () => {
  const w = worker({ submit: {}, looks: [{ challenge: true }] });
  const action = connectorAction('browser.observe', {});
  const result = await w.connector.execute(action, connectorContext(action));
  expect(result.outcome).toBe('succeeded');
  expect(w.handOffs).toEqual([{ reason: 'captcha', service: 'book.example', action_id: null }]);
  // Words about a code or a card, with nothing on the page to type them into, hand nothing over.
  const words = worker({
    submit: {},
    looks: [
      {
        tree: ['- heading "Enter the code we sent to you"', '- paragraph: Card number'].join('\n'),
      },
    ],
  });
  const looked = connectorAction('browser.observe', {});
  await words.connector.execute(looked, connectorContext(looked));
  expect(words.handOffs).toHaveLength(0);
});

test('verify reads the page back: a confirmed page settles an unknown submit', async () => {
  const w = worker({ submit: {}, looks: [{ tree: '- heading "Booking confirmed"' }] });
  const action = submit();
  const verified = await w.connector.verify(action, connectorContext(action));
  expect(verified.decision).toBe('succeeded');
  const unclear = worker({ submit: {}, looks: [{ tree: '- heading "Book a table"' }] });
  expect((await unclear.connector.verify(action, connectorContext(action))).decision).toBe(
    'unsupported',
  );
});

test('verify settles a submit only from a page of the site it was sent to', async () => {
  // The browser has moved on to another site since: what that page says is not about this form.
  for (const tree of ['- heading "Booking confirmed"', '- alert: Payment failed']) {
    const elsewhere = worker({
      submit: {},
      looks: [{ url: 'https://news.example.org/story', tree }],
    });
    const action = submit();
    expect((await elsewhere.connector.verify(action, connectorContext(action))).decision).toBe(
      'unsupported',
    );
  }
});
