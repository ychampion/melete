/** Delegated calendar consent is checked after provider reads, before any write. */
import { describe, expect, test } from 'bun:test';
import { BrokerFault } from '../broker/errors.ts';
import { CalendarConnector } from './calendar.ts';
import { GoogleCalendarConnector } from './google-calendar.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import { OutlookCalendarConnector } from './outlook-calendar.ts';
import type { Connector } from './types.ts';

type Provider = 'caldav' | 'google' | 'outlook';

function fixture(provider: Provider) {
  const steps: string[] = [];
  let writes = 0;
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(init?.method ?? 'GET')) {
      steps.push('write');
      writes++;
    }
    return new Response(JSON.stringify({ items: [], value: [], etag: '"created"' }), {
      status: init?.method === 'GET' ? 200 : 201,
      headers: { 'content-type': 'application/json', etag: '"created"' },
    });
  }) as typeof fetch;
  const config = { id: 'con_test', spaceId: 'spc_test' };
  const access = { token: async () => 'fixture-token', renew: async () => 'fixture-token' };
  const connector: Connector =
    provider === 'caldav'
      ? new CalendarConnector(
          {
            ...config,
            mode: 'caldav',
            calendarUrl: 'https://calendar.example.test/events/',
            username: 'member@example.test',
            secretRef: 'sec_test',
          },
          { withSecret: async (_id, _space, use) => use('fixture-password') },
          fetcher,
        )
      : provider === 'google'
        ? new GoogleCalendarConnector({
            ...config,
            base: 'https://www.googleapis.com/calendar/v3/calendars/primary',
            access,
            fetcher,
          })
        : new OutlookCalendarConnector({
            ...config,
            base: 'https://graph.microsoft.com/v1.0/me',
            access,
            fetcher,
          });
  const source = connector.signals;
  if (source?.stream !== 'calendar') throw new Error('Calendar source missing');
  const action = mailAction('calendar.create', {
    summary: 'Room event',
    start: '2026-11-11T10:00:00Z',
    end: '2026-11-11T11:00:00Z',
  });
  return { connector, source, action, steps, writes: () => writes };
}

describe('delegated calendar write authorization', () => {
  for (const provider of ['caldav', 'google', 'outlook'] as const) {
    test(`${provider} refuses a write when consent ends during the conflict read`, async () => {
      const ctx = fixture(provider);
      let consent = true;
      ctx.source.occurrences = async () => {
        ctx.steps.push('read');
        // The earlier dispatch check passed, but the read yielded to a revocation.
        consent = false;
        return { items: [], complete: true };
      };
      const result = await ctx.connector.execute(ctx.action, {
        ...mailContext(),
        beforeCalendarWrite: async () => {
          ctx.steps.push('consent');
          if (!consent) throw new BrokerFault('scope_denied', 'Calendar share revoked.');
        },
      });
      expect(result.outcome).toBe('failed');
      expect(ctx.steps).toEqual(['read', 'consent']);
      expect(ctx.writes()).toBe(0);
    });

    test(`${provider} writes after a current consent check`, async () => {
      const ctx = fixture(provider);
      ctx.source.occurrences = async () => {
        ctx.steps.push('read');
        return { items: [], complete: true };
      };
      const result = await ctx.connector.execute(ctx.action, {
        ...mailContext(),
        beforeCalendarWrite: async () => {
          ctx.steps.push('consent');
        },
      });
      expect(result.outcome).toBe('succeeded');
      expect(ctx.steps).toEqual(['read', 'consent', 'write']);
      expect(ctx.writes()).toBe(1);
    });
  }
});
