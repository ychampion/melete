/**
 * Calendar truth through the broker against a real database and a CalDAV
 * server: a time already taken is refused before anyone is asked, naming what
 * is there, and again at dispatch if something landed there since; inviting
 * someone outside the person's own accounts asks, naming them; a double-booking
 * asks with its reason; a hold can be released and leaves nothing.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { BrokerFault } from '../../src/broker/errors.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { CalendarConnector } from '../../src/connectors/calendar.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { SecretAccess } from '../../src/connectors/secrets.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;
const secret: SecretAccess = { withSecret: async (_id, _space, use) => use('caldav-password') };
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
afterAll(async () => {
  await fixture?.close();
}, 15_000);

/** A CalDAV collection in memory: PUT, GET, DELETE by ETag, and REPORT of everything. */
function caldavServer() {
  const records = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const existing = records.get(path);
      if (request.method === 'PUT') {
        if (
          (request.headers.get('if-none-match') === '*' && existing) ||
          (request.headers.has('if-match') && existing?.etag !== request.headers.get('if-match'))
        )
          return new Response(null, { status: 412 });
        const record = { body: await request.text(), etag: `"v${++version}"` };
        records.set(path, record);
        return new Response(null, { status: 201, headers: { etag: record.etag } });
      }
      if (request.method === 'DELETE') {
        if (!existing || existing.etag !== request.headers.get('if-match'))
          return new Response(null, { status: 412 });
        records.delete(path);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET')
        return existing
          ? new Response(existing.body, { headers: { etag: existing.etag } })
          : new Response(null, { status: 404 });
      if (request.method === 'REPORT')
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...records]
            .map(
              ([href, record]) =>
                `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${record.etag}</d:getetag><c:calendar-data><![CDATA[${record.body}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            )
            .join('')}</d:multistatus>`,
          { status: 207 },
        );
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);
  /** An event someone else put on the calendar. */
  const existingEvent = (uid: string, title: string, start: string, end: string) =>
    records.set(`/calendar/${uid}.ics`, {
      etag: `"x${++version}"`,
      body: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${title}`,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    });
  return { url: `${server.url}calendar/`, records, existingEvent };
}

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, {
    scopes: [
      'calendar.list',
      'calendar.freebusy',
      'calendar.create',
      'calendar.update',
      'calendar.delete',
    ],
    provider: 'caldav',
  });
  const dav = caldavServer();
  // The person's own other account, and their time zone.
  await sql`insert into connection (id, space_id, provider, label, scopes, configuration)
    values (${`conn_own_${seed.connectionId}`}, ${seed.claims.space_id}, 'caldav', 'Work calendar',
      '[]'::jsonb, ${JSON.stringify({ kind: 'google_calendar', account: 'me@work.example' })}::jsonb)`;
  await sql`insert into experience_profile (space_id, time_zone)
    values (${seed.claims.space_id}, 'America/New_York')`;
  const registry = new ConnectorRegistry().register(
    seed.connectionId,
    new CalendarConnector(
      {
        id: seed.connectionId,
        spaceId: seed.claims.space_id,
        mode: 'caldav',
        calendarUrl: dav.url,
        username: 'owner',
        secretRef: 'sec_calendar',
        allowInsecureLocalForTests: true,
      },
      secret,
    ),
  );
  const broker = new BrokerService({ sql, connectors: registry });
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { kind, connection_id: seed.connectionId, payload });
  const approveAndRun = async (proposal: { action_id: string; payload_hash: string }) => {
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(seed.claims, proposal.action_id, proposal.payload_hash);
    return broker.dispatch(proposal.action_id);
  };
  const permissions = new ExperiencePermissions(
    sql,
    broker,
    new ExperienceEffects(sql, broker, registry),
  );
  return { ...seed, sql, dav, broker, propose, approveAndRun, permissions };
}

const event = (start: string, end: string, extra: JsonObject = {}): JsonObject => ({
  summary: 'Catch-up',
  start,
  end,
  ...extra,
});

databaseTest(
  'a create over a busy slot is refused with the conflict named',
  async () => {
    const ctx = await setup();
    ctx.dav.existingEvent('board', 'Board meeting', '20261109T150000Z', '20261109T160000Z');
    const refused = await rejectionOf(
      ctx.propose('calendar.create', event('2026-11-09T15:30:00Z', '2026-11-09T16:30:00Z')),
    );
    expect(refused).toBeInstanceOf(BrokerFault);
    expect((refused as BrokerFault).code).toBe('payload_invalid');
    // Named in the person's own zone: 10:00 in New York.
    expect((refused as BrokerFault).message).toContain(
      '“Board meeting” (Mon, Nov 9, 10:00 AM–11:00 AM EST)',
    );
    // Nobody was asked about it, and nothing was written.
    const [{ count }] = (await ctx.sql`select count(*)::int as count from action
      where job_id = ${ctx.claims.job_id}`) as unknown as [{ count: number }];
    expect(count).toBe(0);
    expect(ctx.dav.records.size).toBe(1);

    // A free time is asked about as before; if something lands there before
    // it is sent, the check at dispatch stops it and names that instead.
    const free = await ctx.propose(
      'calendar.create',
      event('2026-11-09T17:00:00Z', '2026-11-09T18:00:00Z'),
    );
    expect(free.status).toBe('needs_approval');
    ctx.dav.existingEvent('dentist', 'Dentist', '20261109T173000Z', '20261109T180000Z');
    const stopped = await ctx.approveAndRun(free);
    expect(stopped.status).toBe('failed');
    const [row] = await ctx.sql`select reconciliation from action where id = ${free.action_id}`;
    expect(JSON.stringify(row?.reconciliation)).toContain('“Dentist”');
    expect(ctx.dav.records.size).toBe(2);
  },
  SLOW,
);

databaseTest(
  'inviting someone outside asks, naming them',
  async () => {
    const ctx = await setup();
    const asked = await ctx.propose(
      'calendar.create',
      event('2026-11-10T15:00:00Z', '2026-11-10T16:00:00Z', {
        attendees: ['Priya@Partner.example', 'me@work.example'],
      }),
    );
    expect(asked.status).toBe('needs_approval');
    expect(asked.canonical_payload).toMatchObject({
      attendees: ['priya@partner.example', 'me@work.example'],
      checked: { outside: ['priya@partner.example'], time_zone: 'America/New_York' },
    });
    const card = await ctx.permissions.card(ctx.claims.space_id, String(asked.approval_id));
    expect(card.why.join(' ')).toContain(
      'It invites someone outside your own accounts: priya@partner.example.',
    );
    expect(card.preview?.facts).toEqual(
      expect.arrayContaining([
        { label: 'Invites', value: 'priya@partner.example' },
        { label: 'Also invites your own', value: 'me@work.example' },
      ]),
    );
    // An empty guest list is no invitation at all.
    const alone = await ctx.propose(
      'calendar.create',
      event('2026-11-10T17:00:00Z', '2026-11-10T18:00:00Z', { attendees: [] }),
    );
    expect(alone.canonical_payload).not.toHaveProperty('attendees');
    expect(alone.canonical_payload).toMatchObject({ checked: { outside: [] } });
    // Approved, the invitation is written with the guest on it.
    expect((await ctx.approveAndRun(asked)).status).toBe('succeeded');
    const written = [...ctx.dav.records.values()].map((record) => record.body).join('');
    expect(written.replace(/\r\n /g, '')).toContain('mailto:priya@partner.example');
  },
  SLOW,
);

databaseTest(
  'a double-booking asks, with its reason and what it lands on, and then goes ahead',
  async () => {
    const ctx = await setup();
    ctx.dav.existingEvent('board', 'Board meeting', '20261109T150000Z', '20261109T160000Z');
    const asked = await ctx.propose(
      'calendar.create',
      event('2026-11-09T15:30:00Z', '2026-11-09T16:30:00Z', {
        double_book: { reason: 'The person wants to leave the board meeting early for this' },
      }),
    );
    expect(asked.status).toBe('needs_approval');
    const card = await ctx.permissions.card(ctx.claims.space_id, String(asked.approval_id));
    expect(card.why.join(' ')).toContain(
      'It goes on top of Board meeting. The reason given: The person wants to leave the board meeting early for this',
    );
    expect((await ctx.approveAndRun(asked)).status).toBe('succeeded');
    expect(ctx.dav.records.size).toBe(2);
  },
  SLOW,
);

databaseTest(
  'a tentative hold can be confirmed or released, and a released hold leaves nothing',
  async () => {
    const ctx = await setup();
    // A repeated read in one attempt reuses its first answer, so each read
    // asks for a window a few seconds longer.
    let reads = 0;
    const busy = async () => {
      reads += 1;
      const read = await ctx.propose('calendar.freebusy', {
        start: '2026-11-11',
        end: `2026-11-12T00:00:${String(reads).padStart(2, '0')}Z`,
      });
      expect(read.status).toBe('succeeded');
      const [row] = await ctx.sql`select receipt from action where id = ${read.action_id}`;
      // The person's own zone was bound before the read.
      expect(read.canonical_payload).toMatchObject({ time_zone: 'America/New_York' });
      return ((row?.receipt?.detail?.busy ?? []) as { title: string; status: string }[]).map(
        (block) => `${block.title}:${block.status}`,
      );
    };
    const hold = await ctx.propose(
      'calendar.create',
      event('2026-11-11T15:00:00Z', '2026-11-11T16:00:00Z', {
        summary: 'Hold: design review',
        tentative: true,
      }),
    );
    const held = await ctx.approveAndRun(hold);
    expect(held.status).toBe('succeeded');
    expect(await busy()).toEqual(['Hold: design review:tentative']);
    const [made] = await ctx.sql`select receipt from action where id = ${hold.action_id}`;
    const confirmed = await ctx.approveAndRun(
      await ctx.propose(
        'calendar.update',
        event('2026-11-11T15:00:00Z', '2026-11-11T16:00:00Z', {
          summary: 'Design review',
          tentative: false,
          uid: hold.action_id,
          etag: made?.receipt?.detail?.etag,
        }),
      ),
    );
    expect(confirmed.status).toBe('succeeded');
    expect(await busy()).toEqual(['Design review:busy']);

    const second = await ctx.propose(
      'calendar.create',
      event('2026-11-11T18:00:00Z', '2026-11-11T19:00:00Z', {
        summary: 'Hold: dinner',
        tentative: true,
      }),
    );
    await ctx.approveAndRun(second);
    const [secondRow] = await ctx.sql`select receipt from action where id = ${second.action_id}`;
    expect(await busy()).toEqual(['Design review:busy', 'Hold: dinner:tentative']);
    const released = await ctx.approveAndRun(
      await ctx.propose('calendar.delete', {
        uid: second.action_id,
        etag: secondRow?.receipt?.detail?.etag,
      }),
    );
    expect(released.status).toBe('succeeded');
    expect(await busy()).toEqual(['Design review:busy']);
    expect([...ctx.dav.records.keys()]).toEqual([`/calendar/${hold.action_id}.ics`]);
  },
  SLOW,
);
