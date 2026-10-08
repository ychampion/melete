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
import { rejectionOf } from '../helpers/broker.ts';
import { deferred } from '../helpers/conformance.ts';
import { createPathFixture, OWNER, SERVICE } from '../helpers/paths.ts';

const paths = await createPathFixture();
const databaseTest = paths ? test : test.skip;
afterAll(async () => await paths?.close(), 20_000);
const setup = (options: Parameters<NonNullable<typeof paths>['setup']>[0] = {}) => {
  if (!paths) throw new Error('Postgres unavailable');
  return paths.setup(options);
};

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
