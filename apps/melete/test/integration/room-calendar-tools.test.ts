/** The room reaches only a current personal calendar share, with private details removed. */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { ROOM_TOOL_SCOPES } from '@melete/contracts';
import { actionFromRow, lockJob, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { CalendarConnector, calendarManifest } from '../../src/connectors/calendar.ts';
import { ConnectorFactory } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createRoomConnector } from '../../src/connectors/room.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { RoomCalendarShareService } from '../../src/rooms/calendar-shares.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const withDb = fixture ? describe : describe.skip;
const servers: ReturnType<typeof Bun.serve>[] = [];
const PRIVATE = 'Private appointment title';
const LOCATION = 'Private clinic address';
const ATTENDEE = 'private-person@example.test';
const start = '2026-11-11T10:00:00Z';
const end = '2026-11-11T11:00:00Z';
const window = { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z' };
const event = (extra: JsonObject = {}): JsonObject => ({
  summary: 'Room appointment',
  start,
  end,
  ...extra,
});

function ics(uid = 'private-event', hour = '100000') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:20261111T${hour}Z`,
    'DTEND:20261111T110000Z',
    `SUMMARY:${PRIVATE}`,
    `LOCATION:${LOCATION}`,
    `ATTENDEE:mailto:${ATTENDEE}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function caldav() {
  const records = new Map<string, { body: string; etag: string }>();
  let writes = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const record = records.get(path);
      if (request.method === 'PUT') {
        if (record && request.headers.get('if-none-match') === '*')
          return new Response(null, { status: 412 });
        const etag = `"v${++writes}"`;
        records.set(path, { body: await request.text(), etag });
        return new Response(null, { status: 201, headers: { etag } });
      }
      if (request.method === 'GET')
        return record
          ? new Response(record.body, { headers: { etag: record.etag } })
          : new Response(null, { status: 404 });
      if (request.method === 'REPORT')
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...records]
            .map(
              ([href, value]) =>
                `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${value.etag}</d:getetag><c:calendar-data><![CDATA[${value.body}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            )
            .join('')}</d:multistatus>`,
          { status: 207 },
        );
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);
  return {
    url: `${server.url}calendar/`,
    records,
    writes: () => writes,
    busy: (uid = 'private-event') =>
      records.set(`/calendar/${uid}.ics`, { body: ics(uid), etag: '"existing"' }),
  };
}

async function setup(mode: 'freebusy' | 'freebusy_add' = 'freebusy', shared = true) {
  if (!fixture) throw new Error('Postgres unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, { provider: 'room', scopes: [...ROOM_TOOL_SCOPES.room] });
  const roomId = seed.claims.space_id;
  const member = recordId('own');
  const agent = recordId('own');
  const personal = recordId('sp');
  const calendarId = recordId('conn');
  await sql`insert into principal (id, email, kind, display_name) values
    (${member}, ${`${member}@example.test`}, 'person', 'Calendar member'),
    (${agent}, ${`${agent}@room.invalid`}, 'room', 'Room')`;
  await sql`update space set kind = 'shared', owner_principal_id = ${member}, audience = 'members' where id = ${roomId}`;
  await sql`insert into space_membership (space_id, principal_id, role) values
    (${roomId}, ${member}, 'owner'), (${roomId}, ${agent}, 'agent')`;
  await sql`update job set principal_id = ${agent}, audience = 'room', requested_by_principal_id = ${member} where id = ${seed.claims.job_id}`;
  seed.claims.principal_id = agent;
  seed.claims.membership_generation = 0;
  await sql`update attempt set principal_id = ${agent}, membership_generation = 0 where id = ${seed.claims.attempt_id}`;
  await sql`update connection set shared_use = 'room', configuration = '{"builtin":"room_handoff"}'::jsonb where id = ${seed.connectionId}`;
  await sql`insert into space (id, name, git_path, owner_principal_id) values
    (${personal}, 'Personal', ${`spaces/${personal}`}, ${member})`;
  await sql`insert into connection (id, space_id, provider, label, scopes, configuration) values
    (${calendarId}, ${personal}, 'caldav', 'Personal calendar',
    ${JSON.stringify(calendarManifest.tools.map((tool) => tool.name))}::jsonb, '{"kind":"caldav"}'::jsonb)`;
  await sql`insert into experience_profile (space_id, time_zone) values (${personal}, 'America/New_York')`;
  const dav = caldav();
  const calendar = new CalendarConnector(
    {
      id: calendarId,
      spaceId: personal,
      mode: 'caldav',
      calendarUrl: dav.url,
      username: 'member@example.test',
      secretRef: 'sec_test',
      allowInsecureLocalForTests: true,
    },
    { withSecret: async (_id, _space, use) => use('fixture-password') },
  );
  const service = new RoomCalendarShareService({ db: fixture.db });
  if (shared) await service.put(roomId, member, calendarId, mode);
  let opened = 0;
  const connector = createRoomConnector({
    sql,
    workRoot: '/tmp',
    spacesRoot: '/tmp',
    openCalendar: async (row) => {
      expect(row.id).toBe(calendarId);
      opened++;
      return calendar;
    },
  });
  const registry = new ConnectorRegistry().register(seed.connectionId, connector);
  const broker = new BrokerService({ sql, connectors: registry });
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { kind, connection_id: seed.connectionId, payload });
  const busy = (extra: JsonObject = {}) =>
    propose('room.member_freebusy', { member, ...window, ...extra });
  const add = (extra: JsonObject = {}) =>
    propose('room.add_to_member_calendar', { member, event: event(extra) });
  const approve = async (proposal: { action_id: string; payload_hash: string }) => {
    await broker.decide(
      proposal.action_id,
      { decision: 'approved', payload_hash: proposal.payload_hash },
      undefined,
      member,
    );
    await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
    return broker.dispatch(proposal.action_id);
  };
  return {
    ...seed,
    sql,
    member,
    roomId,
    personal,
    calendarId,
    dav,
    calendar,
    service,
    connector,
    registry,
    broker,
    propose,
    busy,
    add,
    approve,
    opened: () => opened,
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
afterAll(async () => {
  await fixture?.close();
}, 30_000);

withDb('room personal calendar tools', () => {
  test('free/busy uses the member timezone and contains no event details or identifiers', async () => {
    const ctx = await setup();
    ctx.dav.busy();
    const result = await ctx.busy();
    expect(result.status).toBe('succeeded');
    const [row] = await ctx.sql`select receipt from action where id = ${result.action_id}`;
    const detail = row?.receipt.detail;
    expect(detail).toMatchObject({
      member: ctx.member,
      time_zone: 'America/New_York',
      complete: true,
      busy: [
        {
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          all_day: false,
          status: 'busy',
        },
      ],
    });
    expect(Object.keys(detail.busy[0]).sort()).toEqual([
      'all_day',
      'end',
      'end_local',
      'start',
      'start_local',
      'status',
    ]);
    const output = JSON.stringify(detail);
    for (const field of [
      'title',
      'summary',
      'location',
      'attendees',
      'uid',
      'ref',
      PRIVATE,
      LOCATION,
      ATTENDEE,
    ])
      expect(output).not.toContain(field);
    expect(detail.free).toHaveLength(2);
  });

  test("a window is read in the room's zone, as the board reads times, and blocks say their local times", async () => {
    // The room chose no zone, so it reads time in its requester's: New York,
    // on standard time (UTC-5) by November 11.
    const ctx = await setup();
    ctx.dav.busy();
    const day = await ctx.busy({ start: '2026-11-11', end: '2026-11-11' });
    expect(day.status).toBe('succeeded');
    expect(day.canonical_payload).toMatchObject({
      start: '2026-11-11T05:00:00.000Z',
      end: '2026-11-12T05:00:00.000Z',
    });
    const [row] = await ctx.sql`select receipt from action where id = ${day.action_id}`;
    expect(row?.receipt.detail).toMatchObject({
      room_time_zone: 'America/New_York',
      busy: [{ start_local: '2026-11-11T05:00', end_local: '2026-11-11T06:00', status: 'busy' }],
    });
    const hours = await ctx.busy({ start: '2026-11-11T04:00', end: '2026-11-11T07:00:00' });
    expect(hours.canonical_payload).toMatchObject({
      start: '2026-11-11T09:00:00.000Z',
      end: '2026-11-11T12:00:00.000Z',
    });
    const [read] = await ctx.sql`select receipt from action where id = ${hours.action_id}`;
    expect(read?.receipt.detail.busy).toHaveLength(1);
    // An instant with its own offset is taken as given.
    const given = await ctx.busy({
      start: '2026-11-11T00:00:00-05:00',
      end: '2026-11-11T12:00:00Z',
    });
    expect(given.canonical_payload).toMatchObject({
      start: '2026-11-11T00:00:00-05:00',
      end: '2026-11-11T12:00:00Z',
    });
  });

  test('a window that cannot be read says what is wrong with it', async () => {
    const ctx = await setup();
    expect(
      await rejectionOf(ctx.busy({ start: '2026-11-11T08:00', end: '2026-11-11T07:00' })),
    ).toMatchObject({
      code: 'payload_invalid',
      message: 'The free/busy end must be after its start.',
    });
    expect(await rejectionOf(ctx.busy({ start: '2026-11-01', end: '2027-01-15' }))).toMatchObject({
      code: 'payload_invalid',
      message: 'Choose a free/busy window of at most 62 days.',
    });
    expect(await rejectionOf(ctx.busy({ start: 'Monday', end: '2026-11-11' }))).toMatchObject({
      code: 'payload_invalid',
      message: expect.stringContaining(
        "start must be a real date and time in the room's time zone",
      ),
    });
    expect(ctx.opened()).toBe(0);
  });

  test('an unshared calendar is unreachable even if a connection id is supplied', async () => {
    const ctx = await setup('freebusy_add', false);
    expect(await rejectionOf(ctx.busy({ calendar_connection_id: ctx.calendarId }))).toMatchObject({
      code: 'scope_denied',
    });
    expect(await rejectionOf(ctx.add())).toMatchObject({ code: 'scope_denied' });
    expect(ctx.opened()).toBe(0);
  });

  test('room labels resolve to a member, and identical display names require a handle', async () => {
    const ctx = await setup();
    const byName = await ctx.busy({ member: 'Calendar member' });
    expect(byName.status).toBe('succeeded');
    expect(byName.canonical_payload.member).toBe(ctx.member);
    const other = recordId('own');
    await ctx.sql`insert into principal (id, email, display_name) values (${other}, ${`${other}@example.test`}, 'Calendar member')`;
    await ctx.sql`insert into space_membership (space_id, principal_id, role) values (${ctx.roomId}, ${other}, 'member')`;
    expect(await rejectionOf(ctx.busy({ member: 'Calendar member' }))).toMatchObject({
      code: 'scope_denied',
    });
    const handle = roomHandle(ctx.roomId, ctx.member);
    expect((await ctx.busy({ member: `Calendar member <${handle}>` })).status).toBe('succeeded');
    expect((await ctx.busy({ member: handle })).status).toBe('succeeded');
  });

  test('freebusy consent cannot create an event', async () => {
    const ctx = await setup();
    expect(await rejectionOf(ctx.add())).toMatchObject({ code: 'scope_denied' });
    expect(ctx.dav.writes()).toBe(0);
  });

  test('sharing never grants direct access to the personal calendar connection', async () => {
    const ctx = await setup('freebusy_add');
    ctx.registry.register(ctx.calendarId, ctx.calendar);
    expect(
      await rejectionOf(
        ctx.broker.propose(ctx.claims, {
          kind: 'calendar.list',
          connection_id: ctx.calendarId,
          payload: {},
        }),
      ),
    ).toMatchObject({ code: 'unknown_connection' });
    expect(ctx.opened()).toBe(0);
  });

  test('a failed personal calendar read cannot expose private provider error text', async () => {
    const ctx = await setup();
    const source = ctx.calendar.signals;
    if (source.stream !== 'calendar') throw new Error('Calendar source missing');
    source.occurrences = async () => {
      throw new Error(`${PRIVATE} ${LOCATION} ${ATTENDEE}`);
    };
    const result = await ctx.busy();
    expect(result.status).toBe('failed');
    const [row] = await ctx.sql`select * from action where id = ${result.action_id}`;
    const output = JSON.stringify(row);
    for (const value of [PRIVATE, LOCATION, ATTENDEE]) expect(output).not.toContain(value);
  });

  test('revoking stops the next identical read in the same running request', async () => {
    const ctx = await setup();
    expect((await ctx.busy()).status).toBe('succeeded');
    await ctx.service.revoke(ctx.roomId, ctx.member);
    expect(await rejectionOf(ctx.busy())).toMatchObject({ code: 'scope_denied' });
  });

  test('leaving stops the next read and rejoining does not restore calendar consent', async () => {
    const ctx = await setup();
    expect((await ctx.busy()).status).toBe('succeeded');
    await ctx.sql`update space_membership set revoked_at = now(), generation = generation + 1
      where space_id = ${ctx.roomId} and principal_id = ${ctx.member}`;
    expect(await rejectionOf(ctx.busy())).toMatchObject({ code: 'scope_denied' });
    await ctx.sql`update space_membership set revoked_at = null where space_id = ${ctx.roomId} and principal_id = ${ctx.member}`;
    expect(await rejectionOf(ctx.busy())).toMatchObject({ code: 'scope_denied' });
  });

  test.each(['revoke', 'leave'] as const)(
    '%s while a calendar read is in flight discards its result',
    async (change) => {
      const ctx = await setup();
      ctx.dav.busy();
      const source = ctx.calendar.signals;
      if (source.stream !== 'calendar') throw new Error('Calendar source missing');
      const original = source.occurrences.bind(source);
      let notify: () => void = () => {};
      let release: () => void = () => {};
      const reading = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      source.occurrences = async (...args) => {
        notify();
        await resume;
        return original(...args);
      };
      const pending = ctx.busy();
      await reading;
      if (change === 'revoke') await ctx.service.revoke(ctx.roomId, ctx.member);
      else
        await ctx.sql`update space_membership set revoked_at = now(), generation = generation + 1
      where space_id = ${ctx.roomId} and principal_id = ${ctx.member}`;
      release();
      const result = await pending;
      expect(result.status).not.toBe('succeeded');
      const [row] = await ctx.sql`select receipt from action where id = ${result.action_id}`;
      expect(row?.receipt).toBeNull();
    },
  );

  test('member approval creates only on the shared personal connection and verifies the event', async () => {
    const ctx = await setup('freebusy_add');
    const proposal = await ctx.add({ attendees: ['invitee@example.test'], tentative: true });
    expect(proposal.status).toBe('needs_approval');
    expect(ctx.dav.writes()).toBe(0);
    expect(proposal.canonical_payload).toMatchObject({
      member: ctx.member,
      calendar_connection_id: ctx.calendarId,
      event: {
        summary: 'Room appointment',
        checked: { names: false, time_zone: 'America/New_York' },
      },
    });
    const result = await ctx.approve(proposal);
    expect(result.status).toBe('succeeded');
    expect(ctx.dav.writes()).toBe(1);
    const stored = ctx.dav.records.get(`/calendar/${proposal.action_id}.ics`);
    expect(stored?.body).toContain('SUMMARY:Room appointment');
    expect(stored?.body).toContain('invitee@example.test');
    const [row] = await ctx.sql`select * from action where id = ${proposal.action_id}`;
    if (!row) throw new Error('Calendar action missing');
    const action = actionFromRow(row);
    const context: ConnectorContext = {
      job_id: ctx.claims.job_id,
      space_id: ctx.roomId,
      idempotency_key: proposal.action_id,
      constraints: {
        public_compartment: false,
        allowed_domains: [],
        deliverable: { kind: 'none' },
      },
    };
    expect((await ctx.connector.verify(action, context)).decision).toBe('succeeded');
  });

  test('the configured calendar factory reads reach on the proposal transaction', async () => {
    const ctx = await setup('freebusy_add');
    const secretId = recordId('sec');
    await ctx.sql`insert into secret (id, space_id, ciphertext) values (${secretId}, ${ctx.personal}, 'not-read-during-prepare')`;
    await ctx.sql`update connection set secret_ref = ${secretId}, configuration =
      ${JSON.stringify({ kind: 'caldav', caldav: { calendar_url: 'https://calendar.example.test/calendar/', username: 'member@example.test' } })}::jsonb
      where id = ${ctx.calendarId}`;
    const factory = new ConnectorFactory({
      sql: ctx.sql,
      workRoot: '/tmp',
      spacesRoot: '/tmp',
      multiplayer: true,
    });
    const connector = await factory.open({
      id: ctx.connectionId,
      spaceId: ctx.roomId,
      provider: 'room',
      secretRef: null,
      configuration: { builtin: 'room_handoff' },
    });
    if (!connector?.prepare) throw new Error('Room connector missing');
    const before = process.env.MELETE_EVENT_LOCK_GUARD;
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
    try {
      await ctx.sql.begin(async (tx) => {
        await lockJob(tx, ctx.claims.job_id);
        const prepared = await connector.prepare?.(
          { member: ctx.member, event: event() },
          {
            job_id: ctx.claims.job_id,
            space_id: ctx.roomId,
            idempotency_key: '',
            constraints: {
              public_compartment: false,
              allowed_domains: [],
              deliverable: { kind: 'none' },
            },
          },
          tx,
          'room.add_to_member_calendar',
        );
        expect(prepared).toMatchObject({
          calendar_connection_id: ctx.calendarId,
          event: { checked: { names: false } },
        });
      });
    } finally {
      if (before === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
      else process.env.MELETE_EVENT_LOCK_GUARD = before;
    }
  });

  test('existing conflicts refuse a write without disclosing the private event', async () => {
    const ctx = await setup('freebusy_add');
    ctx.dav.busy();
    const refused = await rejectionOf(ctx.add());
    expect(refused).toMatchObject({ code: 'payload_invalid' });
    for (const privateValue of [PRIVATE, LOCATION, ATTENDEE])
      expect(String(refused)).not.toContain(privateValue);
    expect(ctx.dav.writes()).toBe(0);
  });

  test('a conflict arriving after approval still stops the actual calendar create', async () => {
    const ctx = await setup('freebusy_add');
    const proposal = await ctx.add();
    ctx.dav.busy();
    const result = await ctx.approve(proposal);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(ctx.dav.writes()).toBe(0);
  });

  test.each(['revoke', 'leave'] as const)(
    '%s during the final calendar check stops an approved write',
    async (change) => {
      const ctx = await setup('freebusy_add');
      const proposal = await ctx.add();
      const source = ctx.calendar.signals;
      if (source.stream !== 'calendar') throw new Error('Calendar source missing');
      const original = source.occurrences.bind(source);
      let notify: () => void = () => {};
      let release: () => void = () => {};
      const reading = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      source.occurrences = async (...args) => {
        notify();
        await resume;
        return original(...args);
      };
      const pending = ctx.approve(proposal);
      await reading;
      if (change === 'revoke') await ctx.service.revoke(ctx.roomId, ctx.member);
      else
        await ctx.sql`update space_membership set revoked_at = now(), generation = generation + 1
      where space_id = ${ctx.roomId} and principal_id = ${ctx.member}`;
      release();
      const result = await pending;
      expect(result.status).toBe('failed');
      expect(ctx.dav.writes()).toBe(0);
    },
  );

  test('a bound addition cannot follow a replaced or revoked share', async () => {
    const ctx = await setup('freebusy_add');
    const proposal = await ctx.add();
    await ctx.service.revoke(ctx.roomId, ctx.member);
    await ctx.service.put(ctx.roomId, ctx.member, ctx.calendarId, 'freebusy_add');
    expect(await rejectionOf(ctx.approve(proposal))).toMatchObject({ code: 'scope_denied' });
    expect(ctx.dav.writes()).toBe(0);
  });
});
