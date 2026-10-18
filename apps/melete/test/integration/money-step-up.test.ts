/**
 * Money moves need the person's own confirmation.
 *
 * A payment, a purchase, a transfer or a booking that charges is never made
 * on the agent's own say: it waits on a card, and the Allow counts only with
 * a step-up the signed-in person made for that card and those bytes, fresh
 * and spent once. No standing rule, reviewer, typed yes or other answer path
 * stands in for it, and a tool the classification cannot rule out as moving
 * money is held the same way.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  type ApprovalDecisionRequest,
  type ConnectorManifest,
  DEFAULT_APPROVAL_SETTINGS,
  type JsonObject,
} from '@melete/contracts';
import { saveApprovalSettings } from '../../src/broker/auto-review.ts';
import { recordId } from '../../src/broker/records.ts';
import type { Reviewer } from '../../src/broker/reviewer.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { issueStepUp, STEP_UP_NEEDED } from '../../src/broker/step-up.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import {
  ExperiencePermissions,
  STEP_UP_FAILURES_PER_HOUR,
} from '../../src/experience/permissions.ts';
import { limitKey } from '../../src/ops/limiter.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const object = (properties: Record<string, JsonObject>): JsonObject => ({
  type: 'object',
  properties,
});
const manifest: ConnectorManifest = {
  name: 'Shop',
  provider: 'mcp',
  version: '0.1.0',
  description: 'Money fixture',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'payments.pay',
      description: 'Pay a bill',
      input_schema: object({ amount: { type: 'number' } }),
      effect_class: 'spend',
      required_scopes: ['payments.pay'],
      requires_approval: true,
      verify: false,
    },
    {
      // An app's server called it a change anyone can undo; its arguments
      // say it is an order that is paid for.
      name: 'shop.place_order',
      description: 'Place an order',
      input_schema: object({
        sku: { type: 'string' },
        total: { type: 'number' },
        currency: { type: 'string' },
      }),
      effect_class: 'write_reversible',
      required_scopes: ['shop.place_order'],
      requires_approval: false,
      verify: false,
    },
    {
      // A name that says nothing, declared a read, taking a card.
      name: 'shop.go',
      description: 'Do the thing',
      input_schema: object({ details: object({ card_number: { type: 'string' } }) }),
      effect_class: 'read',
      required_scopes: ['shop.go'],
      requires_approval: false,
      verify: false,
    },
    {
      name: 'tasks.create',
      description: 'Add a task',
      input_schema: object({ title: { type: 'string' } }),
      effect_class: 'write_reversible',
      required_scopes: ['tasks.create'],
      requires_approval: true,
      verify: false,
    },
  ],
};

const approving: Reviewer = {
  model: 'fake/scripted',
  async review() {
    return { verdict: 'approve', risk: 'low', reason: 'It is what was asked.' };
  },
};

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((tool) => tool.name),
    provider: 'mcp',
  });
  const personId = recordId('prn');
  const otherId = recordId('prn');
  const hash = await Bun.password.hash(PASSWORD);
  await sql`insert into principal (id, email, password_hash)
    values (${personId}, ${`${personId}@example.test`}, ${hash}),
      (${otherId}, ${`${otherId}@example.test`}, ${hash})`;
  await sql`update job set principal_id = ${personId} where id = ${seed.claims.job_id}`;
  // Everything the person can switch on to go ahead without asking is on.
  await saveApprovalSettings(sql, seed.claims.space_id, {
    mode: 'auto_review',
    classes: {
      ...DEFAULT_APPROVAL_SETTINGS.classes,
      sandbox: true,
      app_changes: true,
      calendar: true,
    },
  });
  const dispatched: string[] = [];
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
  const broker = new BrokerService({
    sql,
    connectors: { get: (id: string) => (id === seed.connectionId ? connector : undefined) },
    autoReview: { reviewer: approving },
  });
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { connection_id: seed.connectionId, kind, payload });
  const approval = async (actionId: string) => {
    const [row] = await sql`select * from approval where action_id = ${actionId}`;
    if (!row) throw new Error('no approval');
    return row;
  };
  /** A step-up as the password check makes it, for this person and this card. */
  const stepUp = async (actionId: string, principalId = personId) => {
    const row = await approval(actionId);
    return (
      await sql.begin((tx) =>
        issueStepUp(tx, {
          principalId,
          approvalId: String(row.id),
          actionId,
          payloadHash: String(row.payload_hash),
          method: 'password',
        }),
      )
    ).token;
  };
  const allow = (
    proposal: { action_id: string; payload_hash: string },
    token?: string,
  ): Promise<unknown> => {
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
    new ExperienceEffects(sql, broker, {
      get: (id: string) => (id === seed.connectionId ? connector : undefined),
    } as never),
  );
  /** As the signed-in `principal`, through the service's own routes. */
  const as = <T>(principal: string, run: () => Promise<T>) => principalContext.run(principal, run);
  return {
    ...seed,
    sql,
    broker,
    propose,
    approval,
    stepUp,
    allow,
    dispatched,
    personId,
    otherId,
    permissions,
    as,
  };
}

const PASSWORD = 'correct horse battery staple';

describe('a money move', () => {
  databaseTest('waits on a card that cannot be allowed for good, with nothing sent', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    expect(proposal.status).toBe('needs_approval');
    expect(await s.approval(proposal.action_id)).toMatchObject({
      step_up_required: true,
      decision: null,
    });
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('is refused without a step-up, and nothing moves', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const error = await rejectionOf(s.allow(proposal));
    expect(String((error as Error).message)).toContain(STEP_UP_NEEDED);
    expect(await s.approval(proposal.action_id)).toMatchObject({ decision: null });
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('goes ahead with a fresh step-up made for it', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    await s.allow(proposal, await s.stepUp(proposal.action_id));
    const row = await s.approval(proposal.action_id);
    expect(row).toMatchObject({ decision: 'approved', decided_by: s.personId });
    expect(row.step_up_id).toBeString();
    expect((await s.broker.resume(s.claims, proposal.action_id)).status).toBe('succeeded');
    expect(s.dispatched).toEqual(['payments.pay']);
  });

  databaseTest('refuses a step-up used once already', async () => {
    const s = await setup();
    const first = await s.propose('payments.pay', { amount: 5 });
    const token = await s.stepUp(first.action_id);
    await s.allow(first, token);
    // The same bytes asked again make a new card; the spent token does not count for it.
    const again = await s.propose('payments.pay', { amount: 5, memo: 'again' });
    await rejectionOf(s.allow(again, token));
    expect(await s.approval(again.action_id)).toMatchObject({ decision: null });
  });

  databaseTest('refuses a step-up that has expired', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const token = await s.stepUp(proposal.action_id);
    await s.sql`update step_up set expires_at = clock_timestamp() - interval '1 second'
      where approval_id = ${(await s.approval(proposal.action_id)).id}`;
    const error = await rejectionOf(s.allow(proposal, token));
    expect(String((error as Error).message)).toContain(STEP_UP_NEEDED);
    expect(await s.approval(proposal.action_id)).toMatchObject({ decision: null });
  });

  databaseTest('refuses a step-up another person made, or one made for another card', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    await rejectionOf(s.allow(proposal, await s.stepUp(proposal.action_id, s.otherId)));
    const other = await s.propose('payments.pay', { amount: 7 });
    await rejectionOf(s.allow(proposal, await s.stepUp(other.action_id)));
    expect(await s.approval(proposal.action_id)).toMatchObject({ decision: null });
  });

  databaseTest('an Allow written any other way moves nothing at admission', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    // As if a typed yes, a reviewer or another path had recorded the Allow.
    await s.sql`update approval set decision = 'approved', decided_at = now(),
      decided_by = ${s.personId} where action_id = ${proposal.action_id}`;
    await s.sql`update action set status = 'approved' where id = ${proposal.action_id}`;
    await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash));
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('a step-up made for it is still checked when the card was not marked', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    // Even with the mark lost, the decision reclassifies and asks for the step-up.
    await s.sql`update approval set step_up_required = false where action_id = ${proposal.action_id}`;
    await rejectionOf(s.allow(proposal));
    expect(await s.approval(proposal.action_id)).toMatchObject({ decision: null });
  });
});

describe('a tool not declared as spending', () => {
  databaseTest('an order with a price is held as money though declared reversible', async () => {
    const s = await setup();
    const proposal = await s.propose('shop.place_order', {
      sku: 'kettle',
      total: 39,
      currency: 'USD',
    });
    expect(proposal.status).toBe('needs_approval');
    expect(await s.approval(proposal.action_id)).toMatchObject({ step_up_required: true });
    await rejectionOf(s.allow(proposal));
    expect(s.dispatched).toEqual([]);
  });

  databaseTest(
    'an unknown tool that takes a card fails closed though declared a read',
    async () => {
      const s = await setup();
      const proposal = await s.propose('shop.go', { details: { card_number: '4242424242424242' } });
      expect(proposal.status).toBe('needs_approval');
      expect(await s.approval(proposal.action_id)).toMatchObject({ step_up_required: true });
      await rejectionOf(s.allow(proposal));
      expect(s.dispatched).toEqual([]);
    },
  );

  databaseTest('an ordinary change still goes ahead on its own, with no step-up', async () => {
    const s = await setup();
    const proposal = await s.propose('tasks.create', { title: 'Call the plumber' });
    expect(proposal.status).toBe('succeeded');
    expect(s.dispatched).toEqual(['tasks.create']);
  });
});

describe('the confirmation, through the permission routes', () => {
  databaseTest('the card offers no "always" and asks for the password', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const approvalId = String((await s.approval(proposal.action_id)).id);
    const card = await s.as(s.personId, () => s.permissions.card(s.claims.space_id, approvalId));
    expect(card.options).toEqual(['allow_once', 'deny']);
    expect(card.step_up).toMatchObject({ method: 'password', available: true });
    expect(card.why[0]).toContain('moves money');
  });

  databaseTest('the right password allows it once; a wrong one gets no token', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const approvalId = String((await s.approval(proposal.action_id)).id);
    const space = s.claims.space_id;
    const wrong = await rejectionOf(
      s.as(s.personId, () => s.permissions.stepUp(space, approvalId, { password: 'guess' })),
    );
    expect(wrong).toMatchObject({ code: 'wrong_password' });
    const card = await s.as(s.personId, () => s.permissions.card(space, approvalId));
    const without = await rejectionOf(
      s.as(s.personId, () =>
        s.permissions.decide(space, approvalId, { option: 'allow_once', version: card.version }),
      ),
    );
    expect(without).toMatchObject({ code: 'step_up_required' });
    const { step_up_token } = await s.as(s.personId, () =>
      s.permissions.stepUp(space, approvalId, { password: PASSWORD }),
    );
    await s.as(s.personId, () =>
      s.permissions.decide(space, approvalId, {
        option: 'allow_once',
        version: card.version,
        step_up_token,
      }),
    );
    expect(await s.approval(proposal.action_id)).toMatchObject({
      decision: 'approved',
      decided_by: s.personId,
    });
  });

  databaseTest(
    'wrong passwords lock the confirmation for every instance, the right one included',
    async () => {
      const s = await setup();
      const proposal = await s.propose('payments.pay', { amount: 5 });
      const approvalId = String((await s.approval(proposal.action_id)).id);
      const space = s.claims.space_id;
      for (let i = 0; i < STEP_UP_FAILURES_PER_HOUR; i++) {
        // Waiting out the short pause between tries; the hour's count stays.
        await s.sql`delete from rate_limit_window where key = ${limitKey('step_up', s.personId)}`;
        const wrong = await rejectionOf(
          s.as(s.personId, () =>
            s.permissions.stepUp(space, approvalId, { password: `guess ${i}` }),
          ),
        );
        expect(wrong).toMatchObject({ code: 'wrong_password' });
      }
      await s.sql`delete from rate_limit_window where key = ${limitKey('step_up', s.personId)}`;
      // Another instance of the service answers the same way.
      const elsewhere = new ExperiencePermissions(s.sql, s.broker, s.permissions.effects);
      const locked = await rejectionOf(
        s.as(s.personId, () => elsewhere.stepUp(space, approvalId, { password: PASSWORD })),
      );
      expect(locked).toMatchObject({ code: 'step_up_rate_limited' });
      const [issued] =
        await s.sql`select count(*)::int as n from step_up where approval_id = ${approvalId}`;
      expect(issued?.n).toBe(0);
    },
  );

  databaseTest('a money ask recorded before the mark can still be confirmed', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const approvalId = String((await s.approval(proposal.action_id)).id);
    await s.sql`update approval set step_up_required = false where id = ${approvalId}`;
    const { step_up_token } = await s.as(s.personId, () =>
      s.permissions.stepUp(s.claims.space_id, approvalId, { password: PASSWORD }),
    );
    expect(step_up_token).toBeString();
  });

  databaseTest('someone else cannot confirm it, even with their own password', async () => {
    const s = await setup();
    const proposal = await s.propose('payments.pay', { amount: 5 });
    const approvalId = String((await s.approval(proposal.action_id)).id);
    await rejectionOf(
      s.as(s.otherId, () =>
        s.permissions.stepUp(s.claims.space_id, approvalId, { password: PASSWORD }),
      ),
    );
    const [issued] =
      await s.sql`select count(*)::int as n from step_up where approval_id = ${approvalId}`;
    expect(issued?.n).toBe(0);
  });
});
