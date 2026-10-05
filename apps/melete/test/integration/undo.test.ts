/**
 * Undo and compensation: a message waits before it is sent and can be
 * cancelled; an event on the person's own calendar goes ahead without asking
 * when it can be undone and touches nothing important, and asks with the
 * reason when it does; Undo on a receipt runs the change's reversal through
 * the broker, with a receipt of its own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Action, ConnectorManifest, DispatchResult, JsonObject } from '@melete/contracts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver, type TrustTableEntry } from '../../src/broker/trust.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { principalContext } from '../../src/principals/authority.ts';
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
function fakeConnector(
  manifest: ConnectorManifest,
  existing: Occurrence[] = [],
  /** A tool of its own this connector declares as held before it runs. */
  declaresHold?: string,
) {
  const executed: Action[] = [];
  const events = new Map<string, Occurrence>();
  /** What the calendar says now; tests change it after the fact. */
  const state = { guests: 0, unreadable: false };
  const connector: Connector = {
    manifest,
    ...(declaresHold
      ? {
          reversalDeclared: (kind: string) =>
            kind === declaresHold ? { mode: 'hold' as const, says: 'Waits before sending.' } : null,
        }
      : {}),
    async existingGuests() {
      return state.guests;
    },
    signals: {
      stream: 'calendar',
      occurrences: async () => {
        if (state.unreadable) throw new Error('calendar unavailable');
        return { items: [...existing, ...events.values()], complete: true };
      },
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
          // As CalDAV reports it: the uid names the action that made it.
          melete_uid: action.id,
        });
        detail = { uid: action.id, etag: '"1"', action_id: action.id };
      }
      if (action.kind === 'calendar.update') {
        const moved = events.get(String(payload.uid));
        if (moved)
          events.set(String(payload.uid), {
            ...moved,
            start: payload.start ?? moved.start,
            end: payload.end ?? moved.end,
          });
        detail = { uid: String(payload.uid), etag: '"2"', action_id: action.id };
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
  return { connector, executed, events, state };
}

async function setup(
  manifest: ConnectorManifest,
  options: {
    existing?: Occurrence[];
    sendHoldMs?: number;
    declaresHold?: string;
    /** Events on another calendar the person has connected in the same space. */
    otherCalendar?: Occurrence[];
  } = {},
) {
  if (!fixture) throw new Error('Postgres unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((tool) => tool.name),
    provider: manifest.provider,
  });
  const fake = fakeConnector(manifest, options.existing, options.declaresHold);
  const registry = new ConnectorRegistry().register(seed.connectionId, fake.connector);
  if (options.otherCalendar) {
    const other = recordId('con');
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${other}, ${seed.claims.space_id}, 'caldav', 'Work', '[]'::jsonb)`;
    registry.register(other, fakeConnector(calendarManifest, options.otherCalendar).connector);
  }
  // Where values came from, as the trust resolver answers; tests add to it.
  const trust = new Map<string, TrustTableEntry>([
    ['alex@example.test', { origin_trust: 'owner' }],
    // The event the person pointed at themselves.
    ['act_theirs', { origin_trust: 'owner' }],
  ]);
  const brokerFor = () =>
    new BrokerService({
      sql,
      connectors: registry,
      resolveTrust: createTableTrustResolver(trust),
      // No reviewer: what goes ahead unasked is decided by fixed rules alone.
      autoReview: { reviewer: null },
      sendHoldMs: options.sendHoldMs ?? 0,
    });
  const broker = brokerFor();
  const effects = new ExperienceEffects(sql, broker, registry);
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { connection_id: seed.connectionId, kind, payload });
  return { ...seed, ...fake, sql, registry, broker, brokerFor, effects, propose, trust };
}

describe('undo send', () => {
  databaseTest('a cancel inside the hold sends nothing, and a restart sends once', async () => {
    const s = await setup(emailManifest, { sendHoldMs: 2_000 });
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
    // Nor after a restart: the cancel is kept, not the hold.
    await s.brokerFor().resumeParked(Date.now() + 3 * 60_000);
    expect(s.executed).toHaveLength(0);

    // Held across a restart: a new process sends it once when its hold ends.
    const second = await send('Eight?');
    const restarted = s.brokerFor();
    expect(await restarted.resumeParked(Date.now())).toBe(0);
    expect(s.executed).toHaveLength(0);
    await Bun.sleep(Math.max(0, Date.parse(String(second.retry_after_at)) - Date.now()) + 300);
    await restarted.resumeParked();
    await restarted.resumeParked();
    await s.broker.resumeParked();
    expect(s.executed.map((action) => action.id)).toEqual([second.id]);
    expect((await loadAction(s.sql, second.id)).status).toBe('succeeded');
    // Once sent, it cannot be cancelled.
    expect(await s.effects.undo(s.claims.space_id, second.id)).toMatchObject({
      status: 'not_available',
    });
  });

  databaseTest('an instance whose clock runs ahead does not end a hold early', async () => {
    const s = await setup(emailManifest, { sendHoldMs: 60_000 });
    const proposed = await s.propose('email.send', {
      to: 'alex@example.test',
      subject: 'Dinner',
      body: 'Nine?',
    });
    await s.broker.decide(proposed.action_id, {
      decision: 'approved',
      payload_hash: proposed.payload_hash,
    });
    expect((await s.broker.resume(s.claims, proposed.action_id)).status).toBe('admitted');
    // Two minutes fast, by this instance's own clock.
    const ahead = Date.now() + 120_000;
    await s.brokerFor().resumeParked(ahead);
    await s.broker.dispatch(proposed.action_id, ahead);
    expect(s.executed).toHaveLength(0);
    expect((await loadAction(s.sql, proposed.action_id)).status).toBe('admitted');
  });

  databaseTest('a send parked by its destination in a finished task is not sent', async () => {
    const s = await setup(emailManifest);
    const proposed = await s.propose('email.send', {
      to: 'alex@example.test',
      subject: 'Dinner',
      body: 'Ten?',
    });
    await s.broker.decide(proposed.action_id, {
      decision: 'approved',
      payload_hash: proposed.payload_hash,
    });
    await s.broker.admit(s.claims, proposed.action_id, proposed.payload_hash);
    // The destination asked to be left alone, and the task finished meanwhile.
    await s.sql`update action set retry_after_at = clock_timestamp() - interval '1 second'
      where id = ${proposed.action_id}`;
    await s.sql`update job set state = 'completed' where id = ${s.claims.job_id}`;
    await s.broker.resumeParked();
    expect(s.executed).toHaveLength(0);
    expect((await loadAction(s.sql, proposed.action_id)).status).toBe('failed');
  });

  databaseTest('a send its connector declares as held waits like a message', async () => {
    const chat: ConnectorManifest = {
      ...emailManifest,
      tools: emailManifest.tools.map((tool) =>
        tool.name === 'email.send'
          ? { ...tool, name: 'chat.send', required_scopes: ['chat.send'] }
          : tool,
      ),
    };
    const s = await setup(chat, { sendHoldMs: 60_000, declaresHold: 'chat.send' });
    const proposed = await s.propose('chat.send', {
      to: 'alex@example.test',
      subject: 'Dinner',
      body: 'Eleven?',
    });
    await s.broker.decide(proposed.action_id, {
      decision: 'approved',
      payload_hash: proposed.payload_hash,
    });
    const resumed = await s.broker.resume(s.claims, proposed.action_id);
    expect(resumed.status).toBe('admitted');
    expect(resumed.message).toContain('held');
    expect(s.executed).toHaveLength(0);
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

  databaseTest('a calendar that cannot be read asks first, and nothing is written', async () => {
    const s = await setup(calendarManifest);
    s.state.unreadable = true;
    const proposed = await s.propose('calendar.create', event);
    expect(proposed.status).toBe('needs_approval');
    expect(proposed.message).toContain('Melete could not read your calendar around that time.');
    expect(s.executed).toHaveLength(0);
  });

  databaseTest(
    'undoing an event that has guests now waits for approval instead of telling them',
    async () => {
      const s = await setup(calendarManifest);
      const proposed = await s.propose('calendar.create', event);
      expect(proposed.status).toBe('succeeded');
      // Someone added guests in the calendar since; removing it would tell them.
      s.state.guests = 2;
      const undone = await s.effects.undo(s.claims.space_id, proposed.action_id);
      expect(undone).toMatchObject({ status: 'not_available' });
      expect(s.executed.map((action) => action.kind)).toEqual(['calendar.create']);
      expect(s.events.has(proposed.action_id)).toBe(true);
      const [reversal] = await s.sql`select a.status from experience_undo u
        join action a on a.id = u.reversal_action_id where u.action_id = ${proposed.action_id}`;
      expect(reversal?.status).toBe('needs_approval');
    },
  );

  databaseTest('only the person whose work it was can undo it', async () => {
    const s = await setup(calendarManifest);
    const proposed = await s.propose('calendar.create', event);
    const [mine, other] = [recordId('prn'), recordId('prn')];
    for (const id of [mine, other])
      await s.sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
    await s.sql`update job set principal_id = ${mine} where id = ${s.claims.job_id}`;
    const refused = await principalContext
      .run(other, () => s.effects.undo(s.claims.space_id, proposed.action_id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String(refused)).toContain('That item is not here.');
    expect(s.executed.map((action) => action.kind)).toEqual(['calendar.create']);
  });

  databaseTest(
    'the person’s event, updated by Melete and marked free, asks before removal',
    async () => {
      // The person's own event, which Melete updated once (and so carries its mark),
      // marked free: nothing about the time it holds would make it important.
      const theirs: Occurrence = {
        uid: 'act_theirs',
        occurrence: null,
        title: 'Gym',
        start: later(40),
        end: later(41),
        all_day: false,
        location: '',
        status: 'confirmed',
        attendees: 0,
        time_zone: null,
        transparent: true,
        // It carries Melete's mark, but Melete never created it.
        melete_uid: 'act_theirs',
      };
      const s = await setup(calendarManifest, { existing: [theirs] });
      const update = await s.propose('calendar.update', {
        uid: 'act_theirs',
        etag: '"1"',
        summary: 'Gym',
        start: later(40),
        end: later(41),
      });
      // Changing an event Melete did not create asks first: there is no earlier
      // version of it on record to put back.
      expect(update.status).toBe('needs_approval');
      await s.broker.decide(update.action_id, {
        decision: 'approved',
        payload_hash: update.payload_hash,
      });
      expect((await s.broker.resume(s.claims, update.action_id)).status).toBe('succeeded');
      // Removing it is never Melete undoing its own booking: it asks.
      const removal = await s.propose('calendar.delete', { uid: 'act_theirs', etag: '"2"' });
      expect(removal.status).toBe('needs_approval');
      expect(s.executed.map((action) => action.kind)).toEqual(['calendar.update']);
    },
  );

  databaseTest(
    'moving and removing an event Melete made go ahead unasked, vouched for by its own record',
    async () => {
      // No trust entry for the event's id: only Melete's record of making it vouches for it.
      const s = await setup(calendarManifest);
      const created = await s.propose('calendar.create', event);
      expect(created.status).toBe('succeeded');
      const moved = await s.propose('calendar.update', {
        uid: created.action_id,
        etag: '"1"',
        summary: 'Focus time',
        start: later(50),
        end: later(51),
      });
      expect(moved.status).toBe('succeeded');
      const removed = await s.propose('calendar.delete', { uid: created.action_id, etag: '"2"' });
      expect(removed.status).toBe('succeeded');
      expect(s.events.has(created.action_id)).toBe(false);
    },
  );

  databaseTest(
    'an event that only claims to be Melete’s, and blocks the time, asks first',
    async () => {
      const s = await setup(calendarManifest, {
        existing: [
          {
            uid: 'act_lookslikemelete',
            occurrence: null,
            title: 'Planning',
            start: later(30),
            end: later(31),
            all_day: false,
            location: '',
            status: 'confirmed',
            attendees: 0,
            time_zone: null,
            melete_uid: 'act_lookslikemelete',
          },
        ],
      });
      const proposed = await s.propose('calendar.create', event);
      expect(proposed.status).toBe('needs_approval');
      expect(proposed.message).toContain('It overlaps “Planning” on your calendar');
    },
  );

  databaseTest(
    'an id of Melete’s own event that arrives through outside content asks before a move or removal',
    async () => {
      const s = await setup(calendarManifest);
      const created = await s.propose('calendar.create', event);
      expect(created.status).toBe('succeeded');
      // An invitation or an email handed the agent this event's id.
      s.trust.set(created.action_id.toLowerCase(), {
        origin_trust: 'external_content',
        description: 'From an email.',
      });
      const moved = await s.propose('calendar.update', {
        uid: created.action_id,
        etag: '"1"',
        summary: 'Focus time',
        start: later(50),
        end: later(51),
      });
      expect(moved.status).toBe('needs_approval');
      const removed = await s.propose('calendar.delete', { uid: created.action_id, etag: '"1"' });
      expect(removed.status).toBe('needs_approval');
      expect(s.executed.map((action) => action.kind)).toEqual(['calendar.create']);
    },
  );

  databaseTest('an event another task created is not this task’s to move unasked', async () => {
    const s = await setup(calendarManifest);
    const created = await s.propose('calendar.create', event);
    expect(created.status).toBe('succeeded');
    // A different task in the same space, holding only the id.
    const otherJob = recordId('job');
    const otherAttempt = recordId('att');
    await s.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
      select ${otherJob}, space_id, title, objective, state, lease_epoch, budget, constraints
      from job where id = ${s.claims.job_id}`;
    await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${otherAttempt}, ${otherJob}, 1, 'fake', 'fake', 'scripted')`;
    const claims = { ...s.claims, job_id: otherJob, attempt_id: otherAttempt };
    const removed = await s.broker.propose(claims, {
      connection_id: s.connectionId,
      kind: 'calendar.delete',
      payload: { uid: created.action_id, etag: '"1"' },
    });
    expect(removed.status).toBe('needs_approval');
    expect(s.executed.map((action) => action.kind)).toEqual(['calendar.create']);
  });

  databaseTest('a clash on another of the person’s calendars asks first', async () => {
    const s = await setup(calendarManifest, {
      otherCalendar: [
        {
          uid: 'work-1',
          occurrence: null,
          title: 'Quarterly review',
          start: later(30),
          end: later(31),
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
    expect(proposed.message).toContain('It overlaps “Quarterly review” on your calendar');
    expect(s.executed).toHaveLength(0);
  });

  databaseTest(
    'an event put back after a removal that had guests says it comes back without them',
    async () => {
      const s = await setup(calendarManifest);
      const created = await s.propose('calendar.create', event);
      // Guests were added in the calendar; the person approved removing it anyway.
      s.state.guests = 2;
      const removal = await s.propose('calendar.delete', { uid: created.action_id, etag: '"1"' });
      expect(removal.status).toBe('needs_approval');
      await s.broker.decide(removal.action_id, {
        decision: 'approved',
        payload_hash: removal.payload_hash,
      });
      expect((await s.broker.resume(s.claims, removal.action_id)).status).toBe('succeeded');
      s.state.guests = 0;
      const undone = await s.effects.undo(s.claims.space_id, removal.action_id);
      if ('reason' in undone) throw new Error(undone.reason);
      expect(undone.receipt).toMatchObject({
        what: 'Put the event back as a new event, without its guests',
        reverses: removal.action_id,
      });
      // A removal the own-calendar rule let through had no guests: its undo says so plainly.
      const again = await s.propose('calendar.create', {
        summary: 'Reading',
        start: later(60),
        end: later(61),
      });
      const quiet = await s.propose('calendar.delete', { uid: again.action_id, etag: '"1"' });
      expect(quiet.status).toBe('succeeded');
      const back = await s.effects.undo(s.claims.space_id, quiet.action_id);
      if ('reason' in back) throw new Error(back.reason);
      expect(back.receipt?.what).toBe('Created an event');
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
