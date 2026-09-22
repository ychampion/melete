import { afterEach, describe, expect, test } from 'bun:test';
import { connectorManifest } from '@melete/contracts';
import { CalendarConnector, calendarManifest, importIcs } from './calendar.ts';
import { asConnectorFault } from './faults.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type { SecretAccess } from './secrets.ts';

const payload = {
  summary: 'Walk with Alex',
  start: '2026-09-12T09:00:00Z',
  end: '2026-09-12T10:00:00Z',
  description: 'Bring tea.',
  location: 'The park',
};
const secret: SecretAccess = {
  withSecret: async (_id, _space, use) => use('caldav-private-password'),
};
const imported =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:external-event\r\nDTSTART:20260912T090000Z\r\nDTEND:20260912T100000Z\r\nSUMMARY:A folded\r\n  event\\, with punctuation\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A server that answers every write with one status, for the typed faults. */
function refusingCaldav(status: number, headers: Record<string, string> = {}) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(null, { status, headers }),
  });
  servers.push(server);
  return new CalendarConnector(
    {
      id: 'con_test',
      spaceId: 'spc_test',
      mode: 'caldav' as const,
      calendarUrl: `${server.url}calendar/`,
      username: 'owner',
      secretRef: 'sec_private',
      allowInsecureLocalForTests: true,
    },
    secret,
  );
}

function caldavDouble() {
  const records = new Map<string, { body: string; etag: string }>();
  const requests: { method: string; url: string; authorization: string | null }[] = [];
  let puts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
      });
      const path = new URL(request.url).pathname;
      if (request.method === 'DELETE') {
        const existing = records.get(path);
        if (!existing || existing.etag !== request.headers.get('if-match'))
          return new Response(null, { status: 412 });
        records.delete(path);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'PUT') {
        puts++;
        const existing = records.get(path);
        if (
          (request.headers.get('if-none-match') === '*' && existing) ||
          (request.headers.has('if-match') && existing?.etag !== request.headers.get('if-match'))
        )
          return new Response(null, { status: 412 });
        const record = { body: await request.text(), etag: `"version-${puts}"` };
        records.set(path, record);
        return new Response(null, { status: 201, headers: { etag: record.etag } });
      }
      if (request.method === 'GET') {
        const record = records.get(path);
        return record
          ? new Response(record.body, { headers: { etag: record.etag } })
          : new Response(null, { status: 404 });
      }
      if (request.method === 'REPORT')
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...records].map(([url, record]) => `<d:response><d:href>${url}</d:href><d:propstat><d:prop><d:getetag>${record.etag}</d:getetag><c:calendar-data><![CDATA[${record.body}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`,
          { status: 207 },
        );
      if (request.method === 'PROPFIND')
        return new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 });
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);
  const config = {
    id: 'con_test',
    spaceId: 'spc_test',
    mode: 'caldav' as const,
    calendarUrl: `${server.url}calendar/`,
    username: 'owner',
    secretRef: 'sec_private',
    allowInsecureLocalForTests: true,
  };
  return { records, requests, config, puts: () => puts };
}

describe('calendar faults are typed, so the broker can repair the cause', () => {
  const raised = async (status: number, headers?: Record<string, string>) => {
    const connector = refusingCaldav(status, headers);
    try {
      await connector.execute(mailAction('calendar.create', payload), mailContext());
    } catch (error) {
      return asConnectorFault(error);
    }
    throw new Error(`expected a typed fault for ${status}`);
  };

  test('a rate limit carries the wait the server asked for', async () => {
    expect(await raised(429, { 'retry-after': '45' })).toMatchObject({
      kind: 'rate_limited',
      retry_after: 45,
      may_have_committed: false,
    });
  });

  test('a rate limit without a readable wait leaves the length to the policy', async () => {
    expect(await raised(429, { 'retry-after': 'soon' })).toMatchObject({
      kind: 'rate_limited',
      retry_after: null,
    });
  });

  test('a refused credential is expired and a refused account is revoked', async () => {
    expect(await raised(401)).toMatchObject({ kind: 'expired_credential' });
    expect(await raised(403)).toMatchObject({ kind: 'revoked_credential' });
  });

  test('every other refusal is still a plain failure', async () => {
    const connector = refusingCaldav(422);
    const result = await connector.execute(mailAction('calendar.create', payload), mailContext());
    expect(result).toMatchObject({ outcome: 'failed', retryable: false });
  });
});

describe('calendar connector', () => {
  test('delete respects the observed version and keeps a changed event', async () => {
    const double = caldavDouble();
    const connector = new CalendarConnector(double.config, secret);
    const create = mailAction('calendar.create', payload);
    const created = await connector.execute(create, mailContext());
    if (created.outcome !== 'succeeded') throw new Error('Create failed');
    const removal = mailAction('calendar.delete', { uid: create.id, etag: '"stale"' });
    expect((await connector.execute(removal, mailContext())).outcome).toBe('failed');
    expect(double.records.size).toBe(1);
    removal.canonical_payload.etag = created.receipt.detail.etag ?? null;
    expect((await connector.execute(removal, mailContext())).outcome).toBe('succeeded');
    expect(double.records.size).toBe(0);
  });
  test('manifests conform and imported ICS exposes only the read tool', () => {
    expect(connectorManifest.safeParse(calendarManifest).success).toBe(true);
    const connector = new CalendarConnector(
      { id: 'con_test', spaceId: 'spc_test', mode: 'ics', ics: imported },
      secret,
    );
    expect(connector.manifest.tools.map((tool) => tool.name)).toEqual(['calendar.list']);
    expect(connector.manifest.credentials).toEqual([]);
  });

  test('ICS import unfolds and unescapes fields, preserves recurrence, and rejects all writes', async () => {
    let readSecret = false;
    const connector = new CalendarConnector(
      { id: 'con_test', spaceId: 'spc_test', mode: 'ics', ics: imported },
      {
        withSecret: async () => {
          readSecret = true;
          throw new Error('Unexpected secret access');
        },
      },
    );
    const result = await connector.execute(mailAction('calendar.list'), mailContext());
    expect(result.outcome).toBe('succeeded');
    expect(importIcs(imported)[0]?.summary).toBe('A folded event, with punctuation');
    expect(importIcs(imported)[0]?.recurrence).toBe('FREQ=WEEKLY;COUNT=3');
    expect(
      (await connector.execute(mailAction('calendar.create', payload), mailContext())).outcome,
    ).toBe('failed');
    expect(
      (await connector.execute(mailAction('calendar.update', payload), mailContext())).outcome,
    ).toBe('failed');
    expect(readSecret).toBe(false);
  });

  test('CalDAV create uses action UID and conditional PUT; list and verify use real HTTP locally', async () => {
    const fake = caldavDouble();
    const connector = new CalendarConnector(fake.config, secret);
    const action = mailAction('calendar.create', payload);
    const result = await connector.execute(action, mailContext());
    expect(result.outcome).toBe('succeeded');
    expect(fake.records.get('/calendar/act_test.ics')?.body).toContain('UID:act_test');
    expect(fake.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('owner:caldav-private-password').toString('base64')}`,
    );
    expect((await connector.verify(action, mailContext())).decision).toBe('succeeded');
    expect(fake.puts()).toBe(1);
    const listed = await connector.execute(mailAction('calendar.list'), mailContext());
    if (listed.outcome !== 'succeeded') throw new Error('Expected calendar list');
    expect(listed.receipt.detail.events).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('caldav-private-password');
    expect((await connector.health()).status).toBe('ok');
  });

  test('a dropped acknowledgement remains unknown until exact UID and content verification', async () => {
    const fake = caldavDouble();
    const fetcher = (async (input, init) => {
      const result = await fetch(input, init);
      if (init?.method === 'PUT') {
        await result.body?.cancel();
        throw new Error('Connection lost after acceptance');
      }
      return result;
    }) as typeof fetch;
    const connector = new CalendarConnector(fake.config, secret, fetcher);
    const action = mailAction('calendar.create', payload);
    expect((await connector.execute(action, mailContext())).outcome).toBe('unknown');
    expect((await connector.verify(action, mailContext())).decision).toBe('succeeded');
    expect(fake.puts()).toBe(1);
    const record = fake.records.get('/calendar/act_test.ics');
    if (!record) throw new Error('Missing accepted fixture');
    record.body = record.body.replace('Walk with Alex', 'Walk with Zara');
    expect((await connector.verify(action, mailContext())).decision).toBe('undecided');
    fake.records.clear();
    expect((await connector.verify(action, mailContext())).decision).toBe('undecided');
    expect(fake.puts()).toBe(1);
  });

  test('update preserves original UID, records its new action, and fails stale ETags', async () => {
    const fake = caldavDouble();
    const connector = new CalendarConnector(fake.config, secret);
    await connector.execute(mailAction('calendar.create', payload), mailContext());
    const update = mailAction(
      'calendar.update',
      { ...payload, summary: 'A longer walk', uid: 'act_test', etag: '"version-1"' },
      'act_update',
    );
    expect((await connector.execute(update, mailContext('act_update'))).outcome).toBe('succeeded');
    const record = fake.records.get('/calendar/act_test.ics');
    expect(record?.body).toContain('UID:act_test');
    expect(record?.body).toContain('X-MELETE-ACTION-ID:act_update');
    expect((await connector.verify(update, mailContext('act_update'))).decision).toBe('succeeded');
    expect((await connector.execute(update, mailContext('act_update'))).outcome).toBe('failed');
    expect(fake.records.size).toBe(1);
  });

  test('cross-space, path traversal and unexpected fields are rejected before a request', async () => {
    const fake = caldavDouble();
    const connector = new CalendarConnector(fake.config, secret);
    const invalid = mailAction('calendar.update', {
      ...payload,
      uid: '../outside',
      etag: '"version-1"',
    });
    expect((await connector.execute(invalid, mailContext())).outcome).toBe('failed');
    expect(
      (
        await connector.execute(
          mailAction('calendar.create', { ...payload, url: 'https://attacker.test' }),
          mailContext(),
        )
      ).outcome,
    ).toBe('failed');
    expect(
      (
        await connector.execute(mailAction('calendar.create', payload), {
          ...mailContext(),
          space_id: 'spc_other',
        })
      ).outcome,
    ).toBe('failed');
    expect(fake.requests).toHaveLength(0);
  });

  test('redirects cannot forward credentials outside the configured calendar', async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        destinationCalls++;
        return new Response('unreachable');
      },
    });
    const redirect = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(null, { status: 307, headers: { location: destination.url.toString() } }),
    });
    servers.push(destination, redirect);
    const connector = new CalendarConnector(
      {
        id: 'con_test',
        spaceId: 'spc_test',
        mode: 'caldav',
        calendarUrl: redirect.url.toString(),
        username: 'owner',
        secretRef: 'sec_private',
        allowInsecureLocalForTests: true,
      },
      secret,
    );
    const result = await connector.execute(mailAction('calendar.create', payload), mailContext());
    expect(result.outcome).toBe('unknown');
    expect(destinationCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('caldav-private-password');
  });
});

describe('a calendar test says why it failed', () => {
  test('a refused password is told apart from a server that cannot be reached', async () => {
    expect(await refusingCaldav(401).health()).toMatchObject({
      status: 'failing',
      reason: 'credential_refused',
    });
    expect(await refusingCaldav(403).health()).toMatchObject({ reason: 'credential_refused' });
    const broken = await refusingCaldav(500).health();
    expect(broken.status).toBe('failing');
    expect(broken.reason).toBeUndefined();
  });
});
