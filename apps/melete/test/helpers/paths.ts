/**
 * One job that reaches `book.example` two ways: a scripted app (the test
 * connector, told it reaches that service) and the agent's browser (a
 * scripted worker whose pages each test writes). Used by the path ladder's
 * integration tests and by conformance 17.
 */
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
import { seedJob } from './broker.ts';
import { testDatabase } from './database.ts';

export const SERVICE = 'book.example';
/**
 * A form that books a table and takes a deposit, so it spends; `TABLE` books
 * one with nothing to pay; `MESSAGE` sends a message, which the app has a tool for.
 */
export const BOOKING: Record<string, string> = { party: '6', amount: '50' };
export const TABLE: Record<string, string> = { party: '6' };
export const MESSAGE: Record<string, string> = {
  to: 'tables@book.example',
  message: 'A table for six at 7',
};
export const intentFor = (
  host = SERVICE,
  form = 'a',
  fields: Record<string, string> = BOOKING,
  path = '/reserve',
) => ({
  url: `https://${host}${path}`,
  method: 'POST',
  role: 'button',
  name: 'Book',
  form_hash: form.repeat(64),
  body_sha256: 'b'.repeat(64),
  fields,
});

type Page = { url?: string; tree?: string; challenge?: boolean };

/** The installation's owner, whose spaces and jobs these are. */
export const OWNER = 'own_pathladder';

/** A database, a queue and the owner; `setup` makes one job with both ways to the service. Null without Postgres. */
export async function createPathFixture() {
  const found = await testDatabase();
  if (!found) return null;
  const fixture = found;
  const boss = new PgBoss({ connectionString: fixture.url, max: 2 });
  boss.on('error', () => {});
  await initializeTestLedger(fixture.sql);
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
  await fixture.sql`insert into owner (id, email) values (${OWNER}, 'paths@example.test')`;
  await fixture.sql`insert into principal (id, email) values (${OWNER}, 'paths@example.test')`;
  const spaces = await mkdtemp(join(await realpath(tmpdir()), 'melete-path-ladder-'));
  const servers: ReturnType<typeof Bun.serve>[] = [];
  async function setup(
    options: {
      /** Whether an app reaches the service. */
      api?: boolean;
      /** The app's dispatch, around the scripted destination. */
      execute?: (action: Action, ctx: ConnectorContext, app: Connector) => Promise<DispatchResult>;
      dispatchTimeoutMs?: number;
      resolveStandingGrant?: StandingGrantResolver;
      /** Whether the conversation is for one intent the person stated, so all its effects share it. */
      intent?: boolean;
    } = {},
  ) {
    const sql = fixture.sql;
    const seed = await seedJob(sql, {
      provider: 'web',
      scopes: [...browserManifest.tools.map((tool) => tool.name), 'test.send'],
    });
    const appId = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${appId}, ${seed.claims.space_id}, 'test', 'Booking app', ${JSON.stringify(['test.send'])}::jsonb)`;
    if (options.intent) {
      const intentId = recordId('int');
      await sql`insert into intent (id, space_id, principal_id, source, source_key,
          conversation_id, title, kind, subject_key)
        values (${intentId}, ${seed.claims.space_id}, ${OWNER}, 'chat', 'message:1:a',
          ${seed.claims.job_id}, 'Dinner for six', 'booking', ${`intent:${intentId}`})`;
    }
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
          result: { submit_intents: [], ...(page.challenge ? { challenge: true } : {}) },
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
      broker.propose(claims, {
        kind: `browser.${kind}`,
        connection_id: seed.connectionId,
        payload,
      });
    /** A submit from the page as it is; `form` stands for a form read from a fresh page. */
    const submit = (
      host = SERVICE,
      form = 'a',
      fields: Record<string, string> = BOOKING,
      path = '/reserve',
    ) =>
      browse('submit', {
        session_id: session.id,
        control_epoch: session.control_epoch,
        intent: intentFor(host, form, fields, path),
      });
    const approve = async (proposal: { action_id: string; payload_hash: string }) => {
      await broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      await broker.admit(claims, proposal.action_id, proposal.payload_hash);
      return broker.dispatch(proposal.action_id);
    };
    /**
     * A live attempt beside the one a hand-off or a wait ended, as a step
     * working in parallel would hold. The job itself is left as it is.
     */
    const nextAttempt = async () => {
      const [job] =
        await sql`select lease_epoch, revision from job where id = ${seed.claims.job_id}`;
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

  return {
    setup,
    async close() {
      for (const server of servers) await server.stop(true);
      await boss.stop({ graceful: true });
      await fixture.close();
      await rm(spaces, { recursive: true, force: true });
    },
  };
}
export type PathFixture = NonNullable<Awaited<ReturnType<typeof createPathFixture>>>;
