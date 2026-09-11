import { afterAll, expect, test } from 'bun:test';
import { type Action, type DispatchResult, permissionOutcome } from '@melete/contracts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver, type TrustTableEntry } from '../../src/broker/trust.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { BACKEND_VOCABULARY } from '../../src/experience/projectors.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
}, 30000);
async function setup(mode: 'email' | 'calendar' = 'email') {
  if (!fixture) throw new Error('Postgres unavailable');
  const sql = fixture.sql;
  const manifest = mode === 'email' ? emailManifest : calendarManifest;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((tool) => tool.name),
    provider: manifest.provider,
  });
  const persona = recordId('agent');
  await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction, allowed_connection_ids)
    values (${persona}, ${seed.claims.space_id}, 'Nova', 'Planner', '#778899', 'rounded', '#112233', 'Calm', 'Be concise', ${JSON.stringify([seed.connectionId])}::jsonb)`;
  await sql`update job set kind = 'chat', agent_id = ${persona} where id = ${seed.claims.job_id}`;
  const calls: Action[] = [];
  const connector: Connector = {
    manifest,
    async execute(action): Promise<DispatchResult> {
      calls.push(action);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail:
            action.kind === 'calendar.create'
              ? { uid: action.id, etag: '"one"' }
              : action.kind === 'calendar.list'
                ? {
                    events: [
                      {
                        uid: 'dinner',
                        summary: 'Dinner',
                        start: '2026-09-12T19:00:00Z',
                        end: '2026-09-12T20:00:00Z',
                      },
                    ],
                  }
                : {},
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
  const registry = new ConnectorRegistry().register(seed.connectionId, connector);
  const trust = new Map<string, TrustTableEntry>([
    ['alex@example.test', { origin_trust: 'owner', handle: 'owner:alex' }],
    ['jules@example.test', { origin_trust: 'verified_connector', handle: 'contact:jules' }],
  ]);
  const broker = new BrokerService({
    sql,
    connectors: registry,
    resolveTrust: createTableTrustResolver(trust),
    resolveStandingGrant: resolveExperienceGrant,
  });
  const effects = new ExperienceEffects(sql, broker, registry);
  const permissions = new ExperiencePermissions(sql, broker, effects);
  const draft = async (to = 'alex@example.test', body = 'Dinner at seven?') => {
    const proposed = await broker.propose(seed.claims, {
      connection_id: seed.connectionId,
      kind: 'email.draft',
      payload: { to, body, subject: 'Dinner' },
    });
    return proposed.action_id;
  };
  return { ...seed, sql, broker, registry, calls, effects, permissions, trust, draft, persona };
}
const bounds = () => ({
  count_cap: 2,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  reconsent_after_days: 1,
});

databaseTest('home calendar reads use a scoped private command and reject writes', async () => {
  const s = await setup('calendar');
  const read = await s.effects.read(s.claims.space_id, s.connectionId, 'calendar.list', {
    limit: 20,
  });
  expect(read).toMatchObject({
    status: 'succeeded',
    receipt: { detail: { events: [{ summary: 'Dinner' }] } },
  });
  const repeated = await s.effects.read(s.claims.space_id, s.connectionId, 'calendar.list', {
    limit: 20,
  });
  expect(repeated).toEqual(read);
  expect(s.calls).toHaveLength(1);
  expect(
    await s.effects.read(s.claims.space_id, s.connectionId, 'calendar.create', {}),
  ).toMatchObject({ status: 'not_available' });
  expect(await s.effects.read('foreign', s.connectionId, 'calendar.list', {})).toMatchObject({
    status: 'not_available',
  });
});

databaseTest(
  'chat catalog and proposal both reject direct sends; owner draft send is durable and reviewed',
  async () => {
    const s = await setup();
    const catalog = await s.broker.catalog(s.claims);
    expect(catalog.some((tool) => tool.name === 'email.send')).toBe(false);
    expect(catalog.some((tool) => tool.name === 'say')).toBe(true);
    expect(
      await rejectionOf(
        s.broker.propose(s.claims, {
          connection_id: s.connectionId,
          kind: 'email.send',
          payload: { to: 'alex@example.test', subject: 'No', body: 'No' },
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    const id = await s.draft();
    const proposed = await s.permissions.send(s.claims.space_id, id);
    if ('reason' in proposed || !proposed.permission) throw new Error('Expected permission');
    expect(proposed.draft.status).toBe('awaiting_permission');
    expect(s.calls.filter((call) => call.kind === 'email.send')).toHaveLength(0);
    expect(JSON.stringify(proposed)).not.toMatch(BACKEND_VOCABULARY);
    await s.permissions.decide(s.claims.space_id, proposed.permission.id, {
      option: 'allow_once',
      version: proposed.permission.version,
    });
    const repeated = await s.permissions.send(s.claims.space_id, id);
    if ('reason' in repeated) throw new Error(repeated.reason);
    expect(repeated.draft.status).toBe('sent');
    expect(repeated.receipt?.what).toBe('Sent a message');
    expect(s.calls.filter((call) => call.kind === 'email.send')).toHaveLength(1);
    expect(await s.effects.undo(s.claims.space_id, repeated.receipt?.id ?? '')).toMatchObject({
      status: 'not_available',
    });
    expect(await rejectionOf(s.permissions.send(recordId('sp'), id))).toMatchObject({
      status: 404,
    });
  },
);

databaseTest(
  'calendar undo leaves one create and one conditional delete, each with a receipt',
  async () => {
    const s = await setup('calendar');
    const proposed = await s.broker.propose(s.claims, {
      connection_id: s.connectionId,
      kind: 'calendar.create',
      payload: { summary: 'Dinner', start: '2026-09-13T18:00:00Z', end: '2026-09-13T19:00:00Z' },
    });
    const card = await s.permissions.card(s.claims.space_id, proposed.approval_id ?? '');
    await s.permissions.decide(s.claims.space_id, card.id, {
      option: 'allow_once',
      version: card.version,
    });
    await s.broker.admit(s.claims, proposed.action_id, proposed.payload_hash);
    const created = await s.broker.dispatch(proposed.action_id);
    const receipt = await s.effects.receipt(s.claims.space_id, created);
    expect(receipt?.undo?.handle).toBeTruthy();
    const undo = await s.effects.undo(s.claims.space_id, receipt?.undo?.handle ?? '');
    expect(undo).toMatchObject({ receipt: { what: 'Removed an event' } });
    expect(await s.effects.undo(s.claims.space_id, created.id)).toEqual(undo);
    expect(s.calls.map((call) => call.kind)).toEqual(['calendar.create', 'calendar.delete']);
    expect(s.calls[1]?.canonical_payload).toEqual({ uid: created.id, etag: '"one"' });
    const rows =
      await s.sql`select a.* from action a join job j on j.id = a.job_id where j.space_id = ${s.claims.space_id}`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.receipt && row.intent_key)).toBe(true);
  },
);

databaseTest(
  'always is bounded, exact-recipient only, and untrusted destinations cannot create a rule',
  async () => {
    const s = await setup();
    const first = await s.permissions.send(s.claims.space_id, await s.draft());
    if ('reason' in first || !first.permission) throw new Error('Expected permission');
    const allowed = permissionOutcome.parse(
      await s.permissions.decide(s.claims.space_id, first.permission.id, {
        option: 'always',
        version: first.permission.version,
        bounds: bounds(),
      }),
    );
    expect(allowed.rule?.used).toBe(0);
    const next = await s.permissions.send(
      s.claims.space_id,
      await s.draft('alex@example.test', 'A second message'),
    );
    if ('reason' in next) throw new Error(next.reason);
    expect(next.draft.status).toBe('sent');
    expect(next.permission).toBeNull();
    expect((await s.permissions.rules(s.claims.space_id)).rules[0]?.used).toBe(1);
    const other = await s.permissions.send(s.claims.space_id, await s.draft('jules@example.test'));
    if ('reason' in other) throw new Error(other.reason);
    expect(other.permission).not.toBeNull();
    const untrusted = await s.permissions.send(
      s.claims.space_id,
      await s.draft('page@example.test'),
    );
    if ('reason' in untrusted || !untrusted.permission) throw new Error('Expected permission');
    expect(untrusted.permission.options).not.toContain('always');
    expect(
      await rejectionOf(
        s.permissions.decide(s.claims.space_id, untrusted.permission.id, {
          option: 'always',
          version: untrusted.permission.version,
          bounds: bounds(),
        }),
      ),
    ).toMatchObject({ code: 'unconfirmed_destination' });
    expect((await s.permissions.rules(s.claims.space_id)).rules).toHaveLength(1);
  },
);

databaseTest('revoking an admitted standing permission prevents dispatch', async () => {
  const s = await setup();
  const initial = await s.permissions.send(s.claims.space_id, await s.draft());
  if ('reason' in initial || !initial.permission) throw new Error('Expected permission');
  const answer = permissionOutcome.parse(
    await s.permissions.decide(s.claims.space_id, initial.permission.id, {
      option: 'always',
      version: initial.permission.version,
      bounds: bounds(),
    }),
  );
  const source = await loadAction(s.sql, await s.draft('alex@example.test', 'Will be revoked'));
  const originalDispatch = s.broker.dispatch.bind(s.broker);
  s.broker.dispatch = async (id) => loadAction(s.sql, id);
  const admitted = await s.effects.execute(
    s.claims.space_id,
    source,
    'send',
    'email.send',
    source.canonical_payload,
  );
  if ('reason' in admitted) throw new Error(admitted.reason);
  expect(admitted.status).toBe('admitted');
  await s.permissions.revoke(s.claims.space_id, answer.rule?.id ?? '');
  s.broker.dispatch = originalDispatch;
  const result = await originalDispatch(admitted.id);
  expect(result.status).toBe('failed');
  expect(s.calls.filter((call) => call.kind === 'email.send')).toHaveLength(1);
});

databaseTest('a rule cannot exceed its count cap or survive expiry and re-consent', async () => {
  const s = await setup();
  const first = await s.permissions.send(s.claims.space_id, await s.draft());
  if ('reason' in first || !first.permission) throw new Error('Expected permission');
  const result = permissionOutcome.parse(
    await s.permissions.decide(s.claims.space_id, first.permission.id, {
      option: 'always',
      version: first.permission.version,
      bounds: { ...bounds(), count_cap: 1 },
    }),
  );
  const second = await s.permissions.send(
    s.claims.space_id,
    await s.draft('alex@example.test', 'Second'),
  );
  if ('reason' in second) throw new Error(second.reason);
  expect(second.draft.status).toBe('sent');
  const third = await s.permissions.send(
    s.claims.space_id,
    await s.draft('alex@example.test', 'Third'),
  );
  if ('reason' in third) throw new Error(third.reason);
  expect(third.permission).not.toBeNull();
  const ruleId = result.rule?.id ?? '';
  await s.sql`update experience_rule set used = 0, expires_at = now() - interval '1 second' where id = ${ruleId}`;
  const fourth = await s.permissions.send(
    s.claims.space_id,
    await s.draft('alex@example.test', 'Fourth'),
  );
  if ('reason' in fourth) throw new Error(fourth.reason);
  expect(fourth.permission).not.toBeNull();
  await s.sql`update experience_rule set expires_at = now() + interval '1 day', created_at = now() - interval '2 days' where id = ${ruleId}`;
  const fifth = await s.permissions.send(
    s.claims.space_id,
    await s.draft('alex@example.test', 'Fifth'),
  );
  if ('reason' in fifth) throw new Error(fifth.reason);
  expect(fifth.permission).not.toBeNull();
});

databaseTest('stale permission versions and removed agent access block effects', async () => {
  const s = await setup();
  const id = await s.draft();
  const result = await s.permissions.send(s.claims.space_id, id);
  if ('reason' in result || !result.permission) throw new Error('Expected permission');
  expect(
    await rejectionOf(
      s.permissions.decide(s.claims.space_id, result.permission.id, {
        option: 'allow_once',
        version: 'stale',
      }),
    ),
  ).toMatchObject({ code: 'stale_permission' });
  await s.sql`update agent set allowed_connection_ids = '[]'::jsonb where id = ${s.persona}`;
  expect(
    await rejectionOf(
      s.permissions.decide(s.claims.space_id, result.permission.id, {
        option: 'allow_once',
        version: result.permission.version,
      }),
    ),
  ).toMatchObject({ code: 'scope_denied' });
  expect(s.calls.filter((call) => call.kind === 'email.send')).toHaveLength(0);
});
