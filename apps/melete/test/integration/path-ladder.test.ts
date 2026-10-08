/**
 * The path ladder at the broker: a connected app before the browser, nothing
 * on any path while an earlier effect on the same service is unsettled, the
 * browser never around a question the app would ask, a submit read back from
 * its page, and the person handed the browser when Melete is stuck.
 *
 * One job reaches `book.example` two ways: a scripted app (the test
 * connector, told it reaches that service) and the agent's browser (a
 * scripted worker whose pages each test writes).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, CapabilityClaims, DispatchResult, JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService, type StandingGrantResolver } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { browserManifest, createBrowserConnector } from '../../src/connectors/browser.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import type { Connector, ConnectorContext } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { deferred } from '../helpers/conformance.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const boss = fixture ? new PgBoss({ connectionString: fixture.url, max: 2 }) : null;
/** The installation's owner, whose spaces and jobs these are. */
const OWNER = 'own_pathladder';
if (fixture && boss) {
  boss.on('error', () => {});
  await initializeTestLedger(fixture.sql);
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
  await fixture.sql`insert into owner (id, email) values (${OWNER}, 'paths@example.test')`;
  await fixture.sql`insert into principal (id, email) values (${OWNER}, 'paths@example.test')`;
}
const spaces = await mkdtemp(join(await realpath(tmpdir()), 'melete-path-ladder-'));
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  await boss?.stop({ graceful: true });
  await fixture?.close();
  await rm(spaces, { recursive: true, force: true });
}, 20_000);

const SERVICE = 'book.example';
const intentFor = (host = SERVICE, form = 'a') => ({
  url: `https://${host}/reserve`,
  method: 'POST',
  role: 'button',
  name: 'Book',
  form_hash: form.repeat(64),
  body_sha256: 'b'.repeat(64),
  fields: { party: '6' },
});

type Page = { url?: string; tree?: string };

async function setup(
  options: {
    /** Whether an app reaches the service. */
    api?: boolean;
    /** The app's dispatch, around the scripted destination. */
    execute?: (action: Action, ctx: ConnectorContext, app: Connector) => Promise<DispatchResult>;
    dispatchTimeoutMs?: number;
    resolveStandingGrant?: StandingGrantResolver;
  } = {},
) {
  if (!fixture) throw new Error('Postgres unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    provider: 'web',
    scopes: [...browserManifest.tools.map((tool) => tool.name), 'test.send'],
  });
  const appId = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes)
    values (${appId}, ${seed.claims.space_id}, 'test', 'Booking app', ${JSON.stringify(['test.send'])}::jsonb)`;
  const session: BrowserSession = {
    id: `brws_${recordId('session')}`,
    space_id: seed.claims.space_id,
    job_id: seed.claims.job_id,
    control_epoch: 0,
    control: 'automation',
    profile_dir: '/never-return-this-path',
    warm_until: Date.now() + 300_000,
  };
  /** What the next submit lands on, and what each later look sees. */
  const pages: { submit: Page; looks: Page[] } = { submit: {}, looks: [] };
  let submits = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as JsonObject;
      const path = new URL(request.url).pathname;
      if (path === '/lease') return Response.json(session);
      if (path === '/takeover' || path === '/handback') {
        session.control_epoch++;
        session.control = path === '/takeover' ? 'human' : 'automation';
        return Response.json(session);
      }
      if (session.control !== 'automation')
        return Response.json({ error: 'human_control' }, { status: 409 });
      const kind = String((body.operation as JsonObject).kind);
      if (kind === 'submit') submits++;
      const page = kind === 'submit' ? pages.submit : (pages.looks.shift() ?? {});
      return Response.json({
        session_id: session.id,
        control_epoch: session.control_epoch,
        observation: {
          id: `obs_${recordId('o')}`,
          url: page.url ?? `https://${SERVICE}/after`,
          title: '',
          tree: page.tree ?? '- heading "Book a table"',
          screenshot: '',
          schema: [],
        },
        result: { submit_intents: [] },
      });
    },
  });
  servers.push(server);
  const client = new BrowserWorkerClient(server.url.href, 'x'.repeat(32));
  const sessions = new BrowserSessionService(sql, { get: async () => client });
  const browser = createBrowserConnector({
    sessions,
    artifacts: browserArtifactSink(sql, spaces),
    spaceId: seed.claims.space_id,
    secondLookMs: 1,
  });
  const destination = createTestConnector(sql);
  let appCalls = 0;
  // The app reaches the booking service, and has no second route to fall back on.
  const app: Connector = {
    ...destination,
    routes: undefined,
    service: options.api === false ? null : SERVICE,
    async execute(action, ctx) {
      appCalls++;
      return options.execute
        ? options.execute(action, ctx, destination)
        : destination.execute(action, ctx);
    },
  };
  const broker = new BrokerService({
    sql,
    boss: boss ?? undefined,
    connectors: {
      get: (id) => (id === seed.connectionId ? browser : id === appId ? app : undefined),
    },
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    resolveStandingGrant: options.resolveStandingGrant,
    // Every value here is the person's own, so a standing permission is all that decides.
    ...(options.resolveStandingGrant
      ? { resolveTrust: createTableTrustResolver({}, { fallback: 'owner' }) }
      : {}),
  });
  sessions.onHandedBack = async (scope, sessionId) => {
    await broker.handedBack(scope.job_id, sessionId);
  };
  broker.onHandToPerson = (scope, sessionId, input) => sessions.handOff(scope, sessionId, input);
  let claims: CapabilityClaims = seed.claims;
  const viaApp = (payload: JsonObject) =>
    broker.propose(claims, { kind: 'test.send', connection_id: appId, payload });
  const browse = (kind: string, payload: JsonObject) =>
    broker.propose(claims, { kind: `browser.${kind}`, connection_id: seed.connectionId, payload });
  /** A submit from the page as it is; `form` stands for a form read from a fresh page. */
  const submit = (host = SERVICE, form = 'a') =>
    browse('submit', {
      session_id: session.id,
      control_epoch: session.control_epoch,
      intent: intentFor(host, form),
    });
  const approve = async (proposal: { action_id: string; payload_hash: string }) => {
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(claims, proposal.action_id, proposal.payload_hash);
    return broker.dispatch(proposal.action_id);
  };
  /** The next attempt, once a hand-off or a wait has ended this one. */
  const nextAttempt = async () => {
    const [job] = await sql`update job set state = 'running' where id = ${seed.claims.job_id}
      returning lease_epoch, revision`;
    const attemptId = recordId('att');
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptId}, ${seed.claims.job_id}, ${job?.lease_epoch}, 'fake', 'fake', 'scripted')`;
    claims = {
      ...claims,
      attempt_id: attemptId,
      epoch: Number(job?.lease_epoch),
      revision: Number(job?.revision),
    };
  };
  await browse('observe', {});
  return {
    ...seed,
    sql,
    appId,
    broker,
    sessions,
    session,
    pages,
    viaApp,
    browse,
    submit,
    approve,
    nextAttempt,
    submits: () => submits,
    appCalls: () => appCalls,
    job: async () =>
      (await sql`select state, wait, next_wake_at from job where id = ${seed.claims.job_id}`)[0],
    delivered: async () =>
      Number(
        (
          await sql`select count(*)::int as n from test_destination_ledger d
            join action a on a.id = d.action_id where a.job_id = ${seed.claims.job_id}`
        )[0]?.n,
      ),
    record: async (path: string) =>
      (
        await sql`select attempts, successes, failures, unknowns, handed, streak from service_path
          where space_id = ${seed.claims.space_id} and service_key = ${SERVICE} and path = ${path}`
      )[0],
  };
}

describe('the path ladder', () => {
  databaseTest('the policy picks the API when one exists', async () => {
    const s = await setup();
    const refused = await rejectionOf(s.submit());
    expect(refused).toMatchObject({ code: 'path_refused' });
    expect(String((refused as Error).message)).toContain('use test.send');
    expect(s.submits()).toBe(0);
    // With no app for the site, the same submit is the browser's, and it asks first.
    const elsewhere = await s.submit('other.example');
    expect(elsewhere.status).toBe('needs_approval');
  });

  databaseTest(
    'a timeout after dispatch on the API path never leads to a browser retry until reconciled',
    async () => {
      const write = deferred();
      const release = deferred();
      const s = await setup({
        dispatchTimeoutMs: 400,
        // The booking lands, then its answer is lost past the dispatch timeout.
        execute: async (action, ctx, app) => {
          const receipt = await app.execute(action, ctx);
          write.resolve();
          await release.promise;
          return receipt;
        },
      });
      try {
        const proposal = await s.viaApp({ body: 'Table for six at 7' });
        const sent = await s.approve(proposal);
        await write.promise;
        expect(sent.status).toBe('unknown');
        // Not the browser, and not another request to the app either.
        expect(await rejectionOf(s.submit())).toMatchObject({ code: 'outcome_unconfirmed' });
        expect(await rejectionOf(s.viaApp({ body: 'Table for six at 7, again' }))).toMatchObject({
          code: 'outcome_unconfirmed',
        });
        expect(s.submits()).toBe(0);
        // Reconciled by reading the destination: the booking is there, once.
        const settled = await s.broker.verify(proposal.action_id);
        expect(settled.status).toBe('succeeded');
        expect(await s.delivered()).toBe(1);
        // Settled, the browser is still not a second way to book it.
        expect(await rejectionOf(s.submit())).toMatchObject({ code: 'path_refused' });
        expect(s.submits()).toBe(0);
        expect(await s.record('api')).toMatchObject({ attempts: 1, unknowns: 1, successes: 1 });
      } finally {
        release.resolve();
      }
    },
  );

  databaseTest(
    'an app that cannot do it lets the browser stand in, and it still asks',
    async () => {
      let grants = 0;
      const s = await setup({
        // A standing permission that would let any browser submit through.
        resolveStandingGrant: async (_tx, input) => {
          if (input.action.kind !== 'browser.submit') return false;
          grants++;
          return true;
        },
      });
      const refused = await s.viaApp({ body: 'Book it', fault: 'unsupported_route' });
      const failed = await s.approve(refused);
      expect(failed.status).toBe('failed');
      const standIn = await s.submit();
      expect(standIn.status).toBe('needs_approval');
      expect(s.submits()).toBe(0);
      // The same permission does let a submit through where no app reaches.
      s.pages.submit = { url: 'https://other.example/done', tree: '- heading "Request received"' };
      const elsewhere = await s.submit('other.example');
      expect(grants).toBeGreaterThan(0);
      expect(elsewhere.status).toBe('succeeded');
      expect(s.submits()).toBe(1);
    },
  );

  databaseTest(
    "the browser path can't be used to get around an approval the API path needs",
    async () => {
      const s = await setup();
      const asked = await s.viaApp({ body: 'Table for six at 7' });
      expect(asked.status).toBe('needs_approval');
      // While the app waits for the person's answer, the browser does not do it instead.
      expect(await rejectionOf(s.submit())).toMatchObject({ code: 'path_refused' });
      await s.broker.decide(asked.action_id, {
        decision: 'denied',
        payload_hash: asked.payload_hash,
      });
      // After the person's no, it does not do it instead either.
      const denied = await rejectionOf(s.submit());
      expect(denied).toMatchObject({ code: 'path_refused' });
      expect(String((denied as Error).message)).toContain('said no');
      expect(s.submits()).toBe(0);
      expect(s.appCalls()).toBe(0);
    },
  );

  databaseTest(
    "a browser submit whose page doesn't confirm is recorded unclear and is never resubmitted unasked",
    async () => {
      const s = await setup({ api: false });
      s.pages.submit = { tree: '- heading "Book a table"' };
      const proposal = await s.submit();
      const sent = await s.approve(proposal);
      expect(sent.status).toBe('unknown');
      expect(sent.reconciliation?.evidence).toMatchObject({
        read_back: { verdict: 'unclear', looks: 2 },
        handed_to: 'person',
      });
      const job = await s.job();
      expect(job?.state).toBe('waiting_for_input');
      expect(job?.wait.handoff).toMatchObject({
        reason: 'unclear',
        service: SERVICE,
        action_id: sent.id,
      });
      // The next attempt asks for the same submit: it is handed the one it made, still unknown.
      await s.nextAttempt();
      const same = await s.submit();
      expect(same).toMatchObject({ action_id: sent.id, status: 'unknown' });
      // From a fresh page, a new submit is refused while the first is unsettled.
      expect(await rejectionOf(s.submit(SERVICE, 'c'))).toMatchObject({
        code: 'outcome_unconfirmed',
      });
      expect(s.submits()).toBe(1);
      // Once the person says it did not go through, sending it again is asked first.
      const answered = await s.broker.resolveByOwner(OWNER, sent.id, { resolution: 'failed' });
      expect(answered.status).toBe('resolved');
      const again = await s.submit(SERVICE, 'c');
      expect(again.status).toBe('needs_approval');
      expect(s.submits()).toBe(1);
      expect(await s.record('browser')).toMatchObject({ attempts: 1, unknowns: 1 });
    },
  );

  databaseTest(
    'a captcha or 2FA hands to the person with a take-over link, and work resumes after hand-back',
    async () => {
      const s = await setup({ api: false });
      s.pages.looks.push({ tree: '- iframe "reCAPTCHA"' });
      const looked = await s.browse('observe', { after_observation: 'obs_again' });
      expect(looked.status).toBe('succeeded');
      const held = await s.job();
      expect(held?.state).toBe('waiting_for_input');
      expect(held?.wait.handoff).toMatchObject({
        reason: 'captcha',
        service: SERVICE,
        take_over: { surface: 'browser', session_id: s.session.id },
      });
      expect(held?.wait.handoff.take_over.link).toMatch(/^\/(chat|runs)\/job_/);
      expect(held?.wait.question).toContain('Over to you at book.example');
      // The person takes over: the card stays while they work.
      await s.sessions.control(s.session.id, 'takeover');
      expect((await s.job())?.wait.handoff?.reason).toBe('captcha');
      // Handed back, the work goes on, told to look at the page afresh.
      await s.sessions.control(s.session.id, 'handback');
      const resumed = await s.job();
      expect(resumed?.state).toBe('queued');
      expect(resumed?.next_wake_at).not.toBeNull();
      const [notice] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
        and type = 'notice' and payload->>'kind' = 'handed_back'`;
      expect(notice?.payload).toMatchObject({ session_id: s.session.id });
      expect(await s.record('browser')).toMatchObject({ handed: 1, streak: 1 });
    },
  );

  databaseTest(
    'a code asked for after a submit is handed over, and checked on hand-back',
    async () => {
      const s = await setup({ api: false });
      s.pages.submit = { tree: '- heading "Enter the code we sent to your phone"' };
      const sent = await s.approve(await s.submit());
      expect(sent.status).toBe('unknown');
      expect((await s.job())?.wait.handoff).toMatchObject({
        reason: 'two_factor',
        action_id: sent.id,
      });
      await s.sessions.control(s.session.id, 'takeover');
      // The page the person leaves shows the booking: reading it back settles the submit.
      s.pages.looks.push({ tree: '- heading "Your table is booked"' });
      await s.sessions.control(s.session.id, 'handback');
      const [settled] = await s.sql`select status from action where id = ${sent.id}`;
      expect(settled?.status).toBe('succeeded');
      expect((await s.job())?.state).toBe('queued');
      expect(s.submits()).toBe(1);
    },
  );

  databaseTest('a site where the browser keeps failing goes to the person', async () => {
    const s = await setup({ api: false });
    await s.sql`insert into service_path (space_id, service_key, task_kind, path, attempts,
        failures, streak, last_fault_at)
      values (${s.claims.space_id}, ${SERVICE}, 'other', 'browser', 3, 3, 3, now())`;
    expect(await rejectionOf(s.submit())).toMatchObject({ code: 'path_refused' });
    const job = await s.job();
    expect(job?.state).toBe('waiting_for_input');
    expect(job?.wait.handoff).toMatchObject({ reason: 'path', service: SERVICE });
    expect(s.submits()).toBe(0);
  });
});
