/**
 * Undo and compensation: a message waits before it is sent and can be
 * cancelled; an event on the person's own calendar goes ahead without asking
 * when it can be undone and touches nothing important, and asks with the
 * reason when it does; Undo on a receipt runs the change's reversal through
 * the broker, with a receipt of its own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Action, ConnectorManifest, DispatchResult, JsonObject } from '@melete/contracts';
import { loadAction } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import type { Occurrence } from '../../src/signals/types.ts';
import { seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
}, 30_000);

const HOUR = 3600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/** A connector that records what it was asked to do and keeps a calendar in memory. */
function fakeConnector(manifest: ConnectorManifest, existing: Occurrence[] = []) {
  const executed: Action[] = [];
  const events = new Map<string, Occurrence>();
  const connector: Connector = {
    manifest,
    async existingGuests() {
      return 0;
    },
    signals: {
      stream: 'calendar',
      occurrences: async () => ({ items: [...existing, ...events.values()], complete: true }),
    },
    async execute(action): Promise<DispatchResult> {
      executed.push(action);
      const payload = action.canonical_payload as Record<string, string>;
      let detail: JsonObject = {};
      if (action.kind === 'calendar.create') {
        events.set(action.id, {
          uid: action.id,
          occurrence: null,
          title: payload.summary ?? '',
          start: payload.start ?? '',
          end: payload.end ?? '',
          all_day: false,
          location: '',
          status: 'confirmed',
          attendees: 0,
          time_zone: null,
          melete: true,
        });
        detail = { uid: action.id, etag: '"1"', action_id: action.id };
      }
      if (action.kind === 'calendar.delete') {
        events.delete(String(payload.uid));
        detail = { uid: String(payload.uid), removed: true };
      }
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail,
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
  return { connector, executed, events };
}

async function setup(
  manifest: ConnectorManifest,
  options: { existing?: Occurrence[]; sendHoldMs?: number } = {},
) {
  if (!fixture) throw new Error('Postgres unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((tool) => tool.name),
    provider: manifest.provider,
  });
  const fake = fakeConnector(manifest, options.existing);
  const registry = new ConnectorRegistry().register(seed.connectionId, fake.connector);
  const brokerFor = () =>
    new BrokerService({
      sql,
      connectors: registry,
      resolveTrust: createTableTrustResolver(
        new Map([['alex@example.test', { origin_trust: 'owner' as const }]]),
      ),
      // No reviewer: what goes ahead unasked is decided by fixed rules alone.
      autoReview: { reviewer: null },
      sendHoldMs: options.sendHoldMs ?? 0,
    });
  const broker = brokerFor();
  const effects = new ExperienceEffects(sql, broker, registry);
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { connection_id: seed.connectionId, kind, payload });
  return { ...seed, ...fake, sql, registry, broker, brokerFor, effects, propose };
}

describe('undo send', () => {
  databaseTest('a cancel inside the hold sends nothing, and a restart sends once', async () => {
    const s = await setup(emailManifest, { sendHoldMs: 60_000 });
    const send = async (body: string) => {
      const proposed = await s.propose('email.send', {
        to: 'alex@example.test',
        subject: 'Dinner',
        body,
      });
      expect(proposed.status).toBe('needs_approval');
      await s.broker.decide(proposed.action_id, {
        decision: 'approved',
        payload_hash: proposed.payload_hash,
      });
      const resumed = await s.broker.resume(s.claims, proposed.action_id);
      // Cleared to go, it waits in its hold: nothing has been sent.
      expect(resumed.status).toBe('admitted');
      expect(resumed.message).toContain('held');
      return loadAction(s.sql, proposed.action_id);
    };

    // Cancelled inside the hold: nothing leaves, then or after the hold ends.
    const first = await send('Seven?');
    const receipt = await s.effects.receipt(s.claims.space_id, first);
    expect(receipt?.sending_until).toBe(String(first.retry_after_at));
    expect(receipt?.undo?.valid_until).toBe(String(first.retry_after_at));
    const undone = await s.effects.undo(s.claims.space_id, first.id);
    if ('reason' in undone) throw new Error(undone.reason);
    expect(undone.receipt?.what).toBe('Cancelled a message before it was sent');
    expect((await loadAction(s.sql, first.id)).status).toBe('failed');
    await s.broker.resumeParked(Date.now() + 2 * 60_000);
    expect(s.executed).toHaveLength(0);

    // Held across a restart: a new process sends it once when its hold ends.
    const second = await send('Eight?');
    const restarted = s.brokerFor();
    expect(await restarted.resumeParked(Date.now())).toBe(0);
    expect(s.executed).toHaveLength(0);
    const due = Date.parse(String(second.retry_after_at)) + 1;
    await restarted.resumeParked(due);
    await restarted.resumeParked(due + 1000);
    await s.broker.resumeParked(due + 2000);
    expect(s.executed.map((action) => action.id)).toEqual([second.id]);
    expect((await loadAction(s.sql, second.id)).status).toBe('succeeded');
    // Once sent, it cannot be cancelled.
    expect(await s.effects.undo(s.claims.space_id, second.id)).toMatchObject({
      status: 'not_available',
    });
  });

  databaseTest('an action with no reversal shows no Undo', async () => {
    const s = await setup(emailManifest);
    const proposed = await s.propose('email.send', {
      to: 'alex@example.test',
      subject: 'Dinner',
      body: 'Seven?',
    });
    await s.broker.decide(proposed.action_id, {
      decision: 'approved',
      payload_hash: proposed.payload_hash,
    });
    const sent = await s.broker.resume(s.claims, proposed.action_id);
    expect(sent.status).toBe('succeeded');
    const receipt = await s.effects.receipt(
      s.claims.space_id,
      await loadAction(s.sql, proposed.action_id),
    );
    expect(receipt?.what).toBeTruthy();
    expect(receipt?.undo).toBeUndefined();
    expect(receipt?.sending_until).toBeUndefined();
    expect(await s.effects.undo(s.claims.space_id, proposed.action_id)).toMatchObject({
      status: 'not_available',
      reason: 'A sent message cannot be recalled.',
    });
  });
});

describe('events on the person’s own calendar', () => {
  const event = { summary: 'Focus time', start: later(30), end: later(31) };

  databaseTest(
    'an own-calendar event with no guests and no conflict goes through without asking, with undo offered',
    async () => {
      const s = await setup(calendarManifest);
      const proposed = await s.propose('calendar.create', event);
      expect(proposed.status).toBe('succeeded');
      expect(proposed.requires_approval).toBe(false);
      const [review] = await s.sql`select tier, decided_by, outcome from action_review
        where action_id = ${proposed.action_id}`;
      expect(review).toMatchObject({
        tier: 'own_calendar',
        decided_by: 'policy',
        outcome: 'approved',
      });
      const receipt = await s.effects.receipt(
        s.claims.space_id,
        await loadAction(s.sql, proposed.action_id),
      );
      expect(receipt?.undo?.handle).toBeTruthy();
      expect(receipt?.review?.outcome).toBe('auto_approved');
    },
  );

  databaseTest(
    'undoing a created own-calendar event removes it and records both receipts',
    async () => {
      const s = await setup(calendarManifest);
      const proposed = await s.propose('calendar.create', event);
      expect(s.events.has(proposed.action_id)).toBe(true);
      const created = await loadAction(s.sql, proposed.action_id);
      const before = await s.effects.receipt(s.claims.space_id, created);
      const undone = await s.effects.undo(s.claims.space_id, before?.undo?.handle ?? '');
      if ('reason' in undone) throw new Error(undone.reason);
      // The event is gone from the calendar, by a delete of its own.
      expect(s.events.has(proposed.action_id)).toBe(false);
      expect(s.executed.map((action) => action.kind)).toEqual([
        'calendar.create',
        'calendar.delete',
      ]);
      // Both changes keep their receipts, and the undo names the change it took back.
      expect(undone.receipt).toMatchObject({ what: 'Removed an event', reverses: created.id });
      expect(undone.receipt?.undo).toBeUndefined();
      const original = await s.effects.receipt(s.claims.space_id, created);
      expect(original?.what).toBe('Created an event');
      expect(original?.undo).toBeUndefined();
      // Asking again is the same undo, not a second delete.
      expect(await s.effects.undo(s.claims.space_id, created.id)).toEqual(undone);
      expect(s.executed).toHaveLength(2);
    },
  );

  databaseTest(
    'an own-calendar event that overlaps an important event asks first, with the reason',
    async () => {
      const s = await setup(calendarManifest, {
        existing: [
          {
            uid: 'series-1',
            occurrence: later(30),
            title: 'Board review',
            start: later(29.5),
            end: later(30.5),
            all_day: false,
            location: '',
            status: 'confirmed',
            attendees: 0,
            time_zone: null,
          },
        ],
      });
      const proposed = await s.propose('calendar.create', event);
      expect(proposed.status).toBe('needs_approval');
      expect(s.executed).toHaveLength(0);
      const reason = 'It overlaps “Board review”, a repeating meeting.';
      expect(proposed.message).toContain(reason);
      const [review] = await s.sql`select outcome, reason from action_review
        where action_id = ${proposed.action_id}`;
      expect(review).toEqual({ outcome: 'escalated', reason });
    },
  );

  databaseTest('anything within the next few hours asks first, too', async () => {
    const s = await setup(calendarManifest);
    const proposed = await s.propose('calendar.create', {
      summary: 'Call back',
      start: later(1),
      end: later(1.5),
    });
    expect(proposed.status).toBe('needs_approval');
    expect(proposed.message).toContain('It is within the next 4 hours.');
  });
});
