/**
 * The path ladder at the broker: a connected app before the browser for what
 * the app has a tool for, nothing on any path while the same action is
 * unsettled, the browser never around a pending or refused app request, a
 * submit read back from its page, and the person handed the browser when
 * Melete is stuck.
 *
 * One job reaches `book.example` two ways: a scripted app (the test
 * connector, told it reaches that service) and the agent's browser (a
 * scripted worker whose pages each test writes).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { recordId } from '../../src/broker/records.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { deferred } from '../helpers/conformance.ts';
import { createPathFixture, MESSAGE, OWNER, SERVICE, TABLE } from '../helpers/paths.ts';

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
    // A message form, where the app has a send tool: the app is used.
    const refused = await rejectionOf(s.submit(SERVICE, 'a', MESSAGE));
    expect(refused).toMatchObject({ code: 'path_refused' });
    expect(String((refused as Error).message)).toContain('use test.send');
    expect(s.submits()).toBe(0);
    // With no app for the site, the same submit is the browser's, and it asks first.
    const elsewhere = await s.submit('other.example', 'a', MESSAGE);
    expect(elsewhere.status).toBe('needs_approval');
  });

  databaseTest(
    'where the app has no tool for the action, the browser does it without the app failing first',
    async () => {
      const s = await setup();
      // A booking form; the app here only sends messages.
      const booking = await s.submit();
      expect(booking.status).toBe('needs_approval');
      const [chosen] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
        and type = 'notice' and payload->>'phase' = 'path_chosen'
        and payload->>'action_id' = ${booking.action_id}`;
      expect(chosen?.payload).toMatchObject({ path: 'browser', service: SERVICE });
      expect(String(chosen?.payload.reason)).toContain('No connected app has a tool for this');
      expect(s.appCalls()).toBe(0);
    },
  );

  databaseTest(
    'a timeout after dispatch on the API path never leads to a browser retry until reconciled',
    async () => {
      const write = deferred();
      const release = deferred();
      const s = await setup({
        intent: true,
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
    'an app that cannot do it lets the browser stand in, on the usual approval rules, with the reason on the receipt',
    async () => {
      let grants = 0;
      const s = await setup({
        // A standing permission that lets browser submits through.
        resolveStandingGrant: async (_tx, input) => {
          if (input.action.kind !== 'browser.submit') return false;
          grants++;
          return true;
        },
      });
      const refused = await s.viaApp({ body: 'Book it', fault: 'unsupported_route' });
      const failed = await s.approve(refused);
      expect(failed.status).toBe('failed');
      s.pages.submit = { tree: '- heading "Your message was sent"' };
      const standIn = await s.submit(SERVICE, 'a', MESSAGE);
      expect(grants).toBeGreaterThan(0);
      expect(standIn.status).toBe('succeeded');
      expect(s.submits()).toBe(1);
      const [chosen] = await s.sql`select payload from event where job_id = ${s.claims.job_id}
        and type = 'notice' and payload->>'phase' = 'path_chosen'
        and payload->>'action_id' = ${standIn.action_id}`;
      expect(chosen?.payload).toMatchObject({ path: 'browser', stands_in_for: 'test.send' });
      expect(String(chosen?.payload.reason)).toContain('test.send could not do this');
    },
  );

  databaseTest(
    "the browser path can't be used to get around an approval the API path needs",
    async () => {
      const s = await setup();
      // The app could not do an earlier request, which alone would let the browser stand in.
      expect(
        (await s.approve(await s.viaApp({ body: 'Hold', fault: 'unsupported_route' }))).status,
      ).toBe('failed');
      const asked = await s.viaApp({ body: 'Table for six at 7' });
      expect(asked.status).toBe('needs_approval');
      // While the app waits for the person's answer, the browser does not do it instead.
      expect(await rejectionOf(s.submit(SERVICE, 'a', MESSAGE))).toMatchObject({
        code: 'path_refused',
      });
      await s.broker.decide(asked.action_id, {
        decision: 'denied',
        payload_hash: asked.payload_hash,
      });
      // After the person's no, it does not do it instead either.
      const denied = await rejectionOf(s.submit(SERVICE, 'a', MESSAGE));
      expect(denied).toMatchObject({ code: 'path_refused' });
      expect(String((denied as Error).message)).toContain('said no');
      expect(s.submits()).toBe(0);
      expect(s.appCalls()).toBe(1);
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
      // The work is a chat turn under way.
      const agentId = recordId('agent');
      const turnId = recordId('turn');
      await s.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
          standing_instruction)
        values (${agentId}, ${s.claims.space_id}, 'Agent', 'helper', 'blue', 'plain', 'black',
          'calm', 'help')`;
      await s.sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
        values (${turnId}, ${s.claims.job_id}, ${agentId}, ${recordId('sub')}, 'Book a table',
          'working')`;
      await s.sql`update job set current_turn_id = ${turnId} where id = ${s.claims.job_id}`;
      s.pages.looks.push({ challenge: true });
      const looked = await s.browse('observe', { after_observation: 'obs_again' });
      expect(looked.status).toBe('succeeded');
      const held = await s.job();
      expect(held?.state).toBe('waiting_for_input');
      // The chat waits on the person, as it reads after a reload and on Home.
      const [turn] = await s.sql`select status from experience_turn where id = ${turnId}`;
      expect(turn?.status).toBe('needs_you');
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

  databaseTest('a bot check after a submit is handed over, and checked on hand-back', async () => {
    const s = await setup({ api: false });
    s.pages.submit = { challenge: true };
    const sent = await s.approve(await s.submit());
    expect(sent.status).toBe('unknown');
    expect((await s.job())?.wait.handoff).toMatchObject({
      reason: 'captcha',
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
  });

  databaseTest('an action the browser keeps failing at goes to the person', async () => {
    const s = await setup({ api: false });
    await s.sql`insert into service_path (space_id, service_key, operation_key, task_kind, path,
        attempts, failures, streak, last_fault_at)
      values (${s.claims.space_id}, ${SERVICE}, 'form POST https://book.example/reserve', 'other',
        'browser', 3, 3, 3, now())`;
    // Another form at the same site is its own action, with its own record.
    const other = await s.submit(SERVICE, 'b', { email: 'ada@example.test' }, '/newsletter');
    expect(other.status).toBe('needs_approval');
    expect(await rejectionOf(s.submit())).toMatchObject({ code: 'path_refused' });
    const job = await s.job();
    expect(job?.state).toBe('waiting_for_input');
    expect(job?.wait.handoff).toMatchObject({ reason: 'path', service: SERVICE });
    expect(s.submits()).toBe(0);
  });

  databaseTest(
    'an unconfirmed submit holds back the same form only; other actions at the site go on',
    async () => {
      const s = await setup({ api: false });
      s.pages.submit = { tree: '- heading "Book a table"' };
      const sent = await s.approve(await s.submit());
      expect(sent.status).toBe('unknown');
      // The same form, read from a fresh page, waits.
      await s.nextAttempt();
      expect(await rejectionOf(s.submit(SERVICE, 'c'))).toMatchObject({
        code: 'outcome_unconfirmed',
      });
      // A different form at the same site is a different action.
      const other = await s.submit(SERVICE, 'd', { email: 'ada@example.test' }, '/newsletter');
      expect(other.status).toBe('needs_approval');
    },
  );

  databaseTest(
    'a submit nobody had to answer for, on a page that does not say, is recorded unconfirmed and the work goes on',
    async () => {
      const s = await setup({ api: false, resolveStandingGrant: async () => true });
      // A page in another language: the read-back knows none of its words.
      s.pages.submit = { tree: '- heading "Reserva recibida"' };
      const sent = await s.submit(SERVICE, 'a', TABLE);
      expect(sent.status).toBe('succeeded');
      const [row] = await s.sql`select receipt from action where id = ${sent.action_id}`;
      expect(row?.receipt.detail).toMatchObject({
        unconfirmed: true,
        read_back: { verdict: 'unclear' },
        submitted: { party: '6' },
      });
      const job = await s.job();
      expect(job?.state).not.toBe('waiting_for_input');
      expect(job?.wait?.handoff).toBeUndefined();
    },
  );

  databaseTest(
    'a submit that pays, let through by a standing permission, on a page that does not say, stays unknown and asks',
    async () => {
      const s = await setup({ api: false, resolveStandingGrant: async () => true });
      s.pages.submit = { tree: '- heading "Reserva recibida"' };
      // A booking that takes a deposit: a payment, whoever let it through.
      const sent = await s.submit();
      expect(sent.status).toBe('unknown');
      const [row] = await s.sql`select reconciliation from action where id = ${sent.action_id}`;
      expect(row?.reconciliation.evidence).toMatchObject({
        read_back: { verdict: 'unclear', looks: 2 },
        handed_to: 'person',
      });
      const job = await s.job();
      expect(job?.state).toBe('waiting_for_input');
      expect(job?.wait.handoff).toMatchObject({ reason: 'unclear', action_id: sent.action_id });
      // And the same form is not sent again while it is unconfirmed.
      await s.nextAttempt();
      expect(await rejectionOf(s.submit(SERVICE, 'c'))).toMatchObject({
        code: 'outcome_unconfirmed',
      });
      expect(s.submits()).toBe(1);
    },
  );

  databaseTest(
    'a person who takes the browser over mid-task and hands it back has the work go on without typing',
    async () => {
      const s = await setup({ api: false });
      // No card: the person simply took the browser while the agent worked.
      await s.sessions.control(s.session.id, 'takeover');
      const parked = await s.job();
      expect(parked?.state).toBe('waiting_for_input');
      expect(parked?.wait.question).toStartWith('Browser control:');
      await s.sessions.control(s.session.id, 'handback');
      const resumed = await s.job();
      expect(resumed?.state).toBe('queued');
      expect(resumed?.next_wake_at).not.toBeNull();
      // A wait that is about something else is the person's to answer, and stays.
      await s.sql`update job set state = 'waiting_for_input',
        wait = ${JSON.stringify({ kind: 'user_input', question: 'Which date works?' })}::jsonb
        where id = ${s.claims.job_id}`;
      expect(await s.broker.resumeAfterControl(s.claims.job_id, 'Browser control:')).toBe(false);
      expect((await s.job())?.state).toBe('waiting_for_input');
    },
  );
});
