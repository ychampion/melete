/**
 * Conformance 17. An effect is done once across paths, or handed to the
 * person with its reason.
 *
 * One booking can go through a scripted app or the agent's browser, both
 * reaching the same site. The app takes the booking and its answer is lost
 * past the dispatch timeout; the browser is then tried, and so is the app
 * again. Separately, a browser submit lands on a page that says nothing about
 * whether it went through; the person is handed the browser and hands it
 * back. Nothing calls a model, and nothing leaves the test's own processes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../apps/melete/test/helpers/broker.ts';
import { deferred } from '../../apps/melete/test/helpers/conformance.ts';
import { createPathFixture, SERVICE } from '../../apps/melete/test/helpers/paths.ts';
import { scenario } from '../scenarios.ts';

const spec = scenario(17);
const paths = await createPathFixture();
const databaseTest = paths ? test : test.skip;
afterAll(async () => await paths?.close(), 20_000);

describe(`conformance 17: ${spec.title}`, () => {
  databaseTest(
    `${spec.assertions[0]}; ${spec.assertions[1]}`,
    async () => {
      if (!paths) throw new Error('Postgres fixture unavailable');
      const write = deferred();
      const release = deferred();
      const s = await paths.setup({
        dispatchTimeoutMs: 400,
        // The destination takes the booking, then its answer is held past the timeout.
        execute: async (action, ctx, app) => {
          const receipt = await app.execute(action, ctx);
          write.resolve();
          await release.promise;
          return receipt;
        },
      });
      try {
        const proposal = await s.viaApp({ body: 'Dinner for six on the 6th at 7 pm' });
        const sent = await s.approve(proposal);
        await write.promise;
        expect(sent.status).toBe('unknown');
        // The ladder stops: not the browser, and not the app with other words.
        expect(await rejectionOf(s.submit())).toMatchObject({ code: 'outcome_unconfirmed' });
        expect(await rejectionOf(s.viaApp({ body: 'Dinner for six, 7 pm' }))).toMatchObject({
          code: 'outcome_unconfirmed',
        });
        // The same request asked again is the one already made.
        const repeated = await s.viaApp({ body: 'Dinner for six on the 6th at 7 pm' });
        expect(repeated).toMatchObject({ action_id: proposal.action_id, status: 'unknown' });
        expect(s.submits()).toBe(0);
        // Reconciled by reading the destination.
        expect((await s.broker.verify(proposal.action_id)).status).toBe('succeeded');
        expect(await s.delivered()).toBe(1);
        expect(s.appCalls()).toBe(1);
        expect(await rejectionOf(s.submit())).toMatchObject({ code: 'path_refused' });
        expect(s.submits()).toBe(0);
      } finally {
        release.resolve();
      }
    },
    20_000,
  );

  databaseTest(
    `${spec.assertions[2]}; ${spec.assertions[3]}; ${spec.assertions[4]}`,
    async () => {
      if (!paths) throw new Error('Postgres fixture unavailable');
      const s = await paths.setup({ api: false });
      await s.browse('fill', { after_observation: 'obs_fill', label: 'Party', value: '6' });
      s.pages.submit = { tree: '- heading "Book a table"' };
      const sent = await s.approve(await s.submit());
      expect(sent.status).toBe('unknown');
      expect(sent.reconciliation?.evidence).toMatchObject({
        read_back: { verdict: 'unclear', looks: 2 },
      });
      const held = await s.job();
      expect(held?.state).toBe('waiting_for_input');
      expect(held?.wait.handoff).toMatchObject({
        reason: 'unclear',
        service: SERVICE,
        action_id: sent.id,
        take_over: { surface: 'browser', session_id: s.session.id },
      });
      expect(held?.wait.handoff.done).toEqual(['Filled "Party"']);
      expect(held?.wait.handoff.left).toContain('does not say whether it went through');
      // A fresh page's form is not sent while the first is unconfirmed.
      await s.nextAttempt();
      expect(await rejectionOf(s.submit(SERVICE, 'c'))).toMatchObject({
        code: 'outcome_unconfirmed',
      });
      expect(s.submits()).toBe(1);
      // The person takes over, then hands back on a page that shows the booking.
      await s.sessions.control(s.session.id, 'takeover');
      s.pages.looks.push({ tree: '- heading "Your table is booked"' });
      await s.sessions.control(s.session.id, 'handback');
      const [settled] = await s.sql`select status from action where id = ${sent.id}`;
      expect(settled?.status).toBe('succeeded');
      const resumed = await s.job();
      expect(resumed?.state).toBe('queued');
      expect(s.submits()).toBe(1);
    },
    20_000,
  );
});
