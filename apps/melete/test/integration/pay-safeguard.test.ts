/**
 * The agent's own computer pays only with the person's own step-up.
 *
 * Its computer goes ahead on its own with everything else. Typing a card's
 * number, typing into a field named as a card's, or pressing a clear pay
 * button on a page with a price is held on the money card, read from the
 * steps before it and the screen text their receipts kept, and goes ahead
 * only with a fresh step-up made for that one step.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  type ApprovalDecisionRequest,
  type ConnectorManifest,
  DEFAULT_APPROVAL_SETTINGS,
  type JsonObject,
  type JsonValue,
} from '@melete/contracts';
import { saveApprovalSettings } from '../../src/broker/auto-review.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { issueStepUp, STEP_UP_NEEDED } from '../../src/broker/step-up.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const VISA = '4111111111111111';
const PASSWORD = 'correct horse battery staple';

const tool = (name: string, effect: 'read' | 'write_reversible', properties: JsonObject) => ({
  name,
  description: name,
  input_schema: { type: 'object', properties } as JsonObject,
  effect_class: effect,
  required_scopes: [name],
  requires_approval: false,
  verify: false,
});
const manifest: ConnectorManifest = {
  name: 'Computer',
  provider: 'sandbox',
  version: '0.1.0',
  description: 'The agent’s own computer',
  credentials: [],
  health: true,
  tools: [
    tool('computer.screenshot', 'read', {}),
    tool('computer.click', 'write_reversible', { x: { type: 'number' }, y: { type: 'number' } }),
    tool('computer.type', 'write_reversible', { text: { type: 'string' } }),
    tool('computer.key', 'write_reversible', { keys: { type: 'array' } }),
    tool('terminal.run', 'write_reversible', { command: { type: 'string' } }),
  ],
};

/** The checkout's screen text, as the computer's receipt keeps it. */
const checkout = (focused: 'number' | 'email' | null): JsonValue => ({
  source: 'accessibility',
  url: 'https://shop.example.com/checkout',
  title: 'Checkout',
  lines: [
    'n1 heading "Checkout" box=0,0,800,40',
    'n2 text "Order total $24.99" box=0,50,300,20',
    `n3 textbox "Email"${focused === 'email' ? ' [focused]' : ''} box=0,100,300,30`,
    `n4 textbox "Card number"${focused === 'number' ? ' [focused]' : ''} box=0,150,300,30`,
    'n5 textbox "Expiry (MM/YY)" box=0,200,140,30',
    'n7 button "Pay $24.99" box=0,260,300,40',
  ].join('\n'),
});

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((each) => each.name),
    provider: 'sandbox',
  });
  const personId = recordId('prn');
  const hash = await Bun.password.hash(PASSWORD);
  await sql`insert into principal (id, email, password_hash)
    values (${personId}, ${`${personId}@example.test`}, ${hash})`;
  await sql`update job set principal_id = ${personId} where id = ${seed.claims.job_id}`;
  // The agent's computer goes ahead on its own.
  await saveApprovalSettings(sql, seed.claims.space_id, {
    mode: 'auto_review',
    classes: { ...DEFAULT_APPROVAL_SETTINGS.classes, sandbox: true },
  });
  const dispatched: string[] = [];
  /** What the screen shows after the next step runs, and the computer session it runs in. */
  let screen: JsonValue = checkout(null);
  const computer = { session: 'ses_1', sandbox: 'sbx_1' };
  const connector: Connector = {
    manifest,
    async execute(action) {
      dispatched.push(action.kind);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          received_at: new Date().toISOString(),
          late: false,
          detail: {
            session_id: computer.session,
            sandbox_id: computer.sandbox,
            screen_text: screen,
          },
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
  const connectors = { get: (id: string) => (id === seed.connectionId ? connector : undefined) };
  const broker = new BrokerService({ sql, connectors });
  const step = (kind: string, payload: JsonObject, after: JsonValue = screen) => {
    screen = after;
    return broker.propose(seed.claims, { connection_id: seed.connectionId, kind, payload });
  };
  const approval = async (actionId: string) => {
    const [row] = await sql`select * from approval where action_id = ${actionId}`;
    if (!row) throw new Error('no approval');
    return row;
  };
  const stepUp = async (actionId: string) => {
    const row = await approval(actionId);
    return (
      await sql.begin((tx) =>
        issueStepUp(tx, {
          principalId: personId,
          approvalId: String(row.id),
          actionId,
          payloadHash: String(row.payload_hash),
          method: 'password',
        }),
      )
    ).token;
  };
  const allow = (proposal: { action_id: string; payload_hash: string }, token?: string) => {
    const request: ApprovalDecisionRequest = {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
      ...(token ? { step_up_token: token } : {}),
    };
    return broker.decide(proposal.action_id, request);
  };
  const permissions = new ExperiencePermissions(
    sql,
    broker,
    new ExperienceEffects(sql, broker, connectors as never),
  );
  const card = async (actionId: string) => {
    const approvalId = String((await approval(actionId)).id);
    return principalContext.run(personId, () => permissions.card(seed.claims.space_id, approvalId));
  };
  return { ...seed, sql, broker, step, approval, stepUp, allow, card, dispatched, computer };
}

describe('the agent’s own computer', () => {
  databaseTest(
    'goes ahead with everything but paying, a number that is no card included',
    async () => {
      const s = await setup();
      expect((await s.step('computer.screenshot', {}, checkout(null))).status).toBe('succeeded');
      expect((await s.step('computer.click', { x: 10, y: 110 }, checkout('email'))).status).toBe(
        'succeeded',
      );
      expect((await s.step('computer.type', { text: '+1 415 555 0134' })).status).toBe('succeeded');
      expect((await s.step('computer.type', { text: '4111111111111112' })).status).toBe(
        'succeeded',
      );
      expect(s.dispatched).toEqual([
        'computer.screenshot',
        'computer.click',
        'computer.type',
        'computer.type',
      ]);
    },
  );

  databaseTest('typing a card number is held for a step-up, saying where it pays', async () => {
    const s = await setup();
    await s.step('computer.click', { x: 10, y: 110 }, checkout('email'));
    const typed = await s.step('computer.type', { text: VISA });
    expect(typed.status).toBe('needs_approval');
    expect(await s.approval(typed.action_id)).toMatchObject({ step_up_required: true });
    expect(s.dispatched).toEqual(['computer.click']);
    const shown = await s.card(typed.action_id);
    expect(shown.what).toBe('Your agent is about to pay on shop.example.com. The page says $24.99');
    expect(shown.options).toEqual(['allow_once', 'deny']);
    expect(shown.why[0]).toContain('moves money');
    // An Allow without the step-up moves nothing.
    expect(String(((await rejectionOf(s.allow(typed))) as Error).message)).toContain(
      STEP_UP_NEEDED,
    );
  });

  databaseTest('typing into a field named as a card’s is held, digits in pieces too', async () => {
    const s = await setup();
    await s.step('computer.click', { x: 10, y: 160 }, checkout('number'));
    const typed = await s.step('computer.type', { text: '41' });
    expect(typed.status).toBe('needs_approval');
    expect(await s.approval(typed.action_id)).toMatchObject({ step_up_required: true });
  });

  /** Click into the card field, type the card, and allow it with a fresh step-up. */
  const enterCard = async (s: Awaited<ReturnType<typeof setup>>) => {
    await s.step('computer.click', { x: 10, y: 160 }, checkout('number'));
    const typed = await s.step('computer.type', { text: VISA });
    expect(typed.status).toBe('needs_approval');
    const token = await s.stepUp(typed.action_id);
    await s.allow(typed, token);
    expect((await s.broker.resume(s.claims, typed.action_id)).status).toBe('succeeded');
    return { typed, token };
  };
  const covers = async (s: Awaited<ReturnType<typeof setup>>) =>
    s.sql`select payload from event where payload->>'phase' = 'checkout_cover'
      and job_id = ${s.claims.job_id} order by seq`;

  databaseTest(
    'one checkout takes one step-up: entering the card covers paying for it',
    async () => {
      const s = await setup();
      const { typed, token } = await enterCard(s);
      // The rest of the card's details on the same page go on under it.
      await s.step('computer.click', { x: 10, y: 210 }, checkout(null));
      expect((await s.step('computer.type', { text: '12/27' })).status).toBe('succeeded');
      // Pressing Pay on that page goes too, once.
      const pay = await s.step('computer.click', { x: 10, y: 270 });
      expect(pay.status).toBe('succeeded');
      expect(s.dispatched).toEqual([
        'computer.click',
        'computer.type',
        'computer.click',
        'computer.type',
        'computer.click',
      ]);
      const stepUp = String((await s.approval(typed.action_id)).step_up_id);
      expect((await covers(s)).map((row) => row.payload)).toEqual([
        expect.objectContaining({ step_up_id: stepUp, covers: 'entry' }),
        expect.objectContaining({ action_id: pay.action_id, step_up_id: stepUp, covers: 'submit' }),
      ]);
      // A second purchase on the same page asks again, and the spent step-up
      // does not count for it.
      // (Another point on the button: the same step again would be the same action.)
      const again = await s.step('computer.click', { x: 12, y: 270 });
      expect(again.status).toBe('needs_approval');
      expect(await s.approval(again.action_id)).toMatchObject({ step_up_required: true });
      await rejectionOf(s.allow(again, token));
      expect(await s.approval(again.action_id)).toMatchObject({ decision: null });
      // Typing a card again is a new purchase too.
      expect((await s.step('computer.type', { text: '4111 1111 1111 1111' })).status).toBe(
        'needs_approval',
      );
    },
  );

  databaseTest(
    'the step-up covers no other site, no other computer, and not after five minutes',
    async () => {
      const elsewhere: JsonValue = {
        source: 'accessibility',
        url: 'https://other.example.net/checkout',
        lines: [
          'n2 text "Order total $90.00" box=0,50,300,20',
          'n7 button "Pay $90.00" box=0,260,300,40',
        ].join('\n'),
      };
      // Another site's Pay button, right after the card went in on this one.
      const site = await setup();
      await enterCard(site);
      await site.step('computer.screenshot', {}, elsewhere);
      expect((await site.step('computer.click', { x: 10, y: 270 })).status).toBe('needs_approval');
      expect(await covers(site)).toHaveLength(0);
      // The same page in another computer session.
      const other = await setup();
      await enterCard(other);
      other.computer.session = 'ses_2';
      await other.step('computer.screenshot', {}, checkout(null));
      expect((await other.step('computer.click', { x: 10, y: 270 })).status).toBe('needs_approval');
      // Five minutes after the step-up was spent.
      const late = await setup();
      const { typed } = await enterCard(late);
      await late.sql`update step_up set used_at = used_at - interval '5 minutes 1 second'
      where action_id = ${typed.action_id}`;
      expect((await late.step('computer.click', { x: 10, y: 270 })).status).toBe('needs_approval');
      // Another card's whole number typed on the same page, before paying.
      const swap = await setup();
      await enterCard(swap);
      await swap.step('computer.click', { x: 10, y: 160 }, checkout('number'));
      expect((await swap.step('computer.type', { text: '5555555555554444' })).status).toBe(
        'needs_approval',
      );
    },
  );

  databaseTest('a step that was allowed without entering a card covers nothing', async () => {
    const s = await setup();
    // Pay pressed with a saved card, allowed with a step-up: the next Pay is a new purchase.
    await s.step('computer.screenshot', {}, checkout(null));
    const pay = await s.step('computer.click', { x: 10, y: 270 });
    await s.allow(pay, await s.stepUp(pay.action_id));
    expect((await s.broker.resume(s.claims, pay.action_id)).status).toBe('succeeded');
    expect((await s.step('computer.click', { x: 12, y: 270 })).status).toBe('needs_approval');
  });

  databaseTest('a command that carries a card number is held for a step-up', async () => {
    const s = await setup();
    const typed = await s.step('terminal.run', { command: `xdotool type ${VISA}` });
    expect(typed.status).toBe('needs_approval');
    expect(await s.approval(typed.action_id)).toMatchObject({ step_up_required: true });
    expect((await s.step('terminal.run', { command: 'ls -la' })).status).toBe('succeeded');
  });

  databaseTest(
    'the card never shows the card’s number, nor anything else typed into it',
    async () => {
      const s = await setup();
      await s.step('computer.click', { x: 10, y: 160 }, checkout('number'));
      const typed = await s.step('computer.type', { text: `${VISA} 12/27 737` });
      const shown = JSON.stringify(await s.card(typed.action_id));
      expect(shown).not.toContain('4111');
      expect(shown).not.toContain('737');
      expect(shown).toContain('[card ending 1111]');
      // Nor the events of the work.
      const events = await s.sql`select payload::text as text from event
      where job_id = ${s.claims.job_id}`;
      for (const row of events) expect(String(row.text)).not.toContain(VISA);
    },
  );

  databaseTest('a pay button on a page with a price is held, as a saved card pays', async () => {
    const s = await setup();
    await s.step('computer.screenshot', {}, checkout(null));
    const pay = await s.step('computer.click', { x: 10, y: 270 });
    expect(pay.status).toBe('needs_approval');
    expect(await s.approval(pay.action_id)).toMatchObject({ step_up_required: true });
    expect((await s.card(pay.action_id)).what).toBe(
      'Your agent is about to pay on shop.example.com. The page says $24.99',
    );
    expect(s.dispatched).toEqual(['computer.screenshot']);
  });
});
