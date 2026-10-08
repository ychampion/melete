import { describe, expect, test } from 'bun:test';
import { type ApiState, decidePath, type PathInput } from './policy.ts';
import { registrableName, serviceOfConnection, serviceOfUrl } from './services.ts';

const noApi: ApiState = { tools: [], pending: false, denied: false, refused: null };
const withApi: ApiState = { ...noApi, tools: ['email.send'] };
const input = (over: Partial<PathInput> = {}): PathInput => ({
  service: 'google:mail',
  via: 'browser',
  unsettled: null,
  api: noApi,
  record: null,
  now: Date.parse('2026-10-08T12:00:00Z'),
  ...over,
});

describe('the path policy', () => {
  test('the policy picks the API when one exists', () => {
    const decided = decidePath(input({ api: withApi }));
    expect(decided).toMatchObject({ allow: false, code: 'path_refused', path: 'api' });
    if (!decided.allow) expect(decided.reason).toContain('use email.send');
    expect(decidePath(input({ via: 'api', api: withApi }))).toMatchObject({
      allow: true,
      path: 'api',
    });
  });

  test('an unsettled effect stops every path, the same one included', () => {
    const unsettled = { action_id: 'act_01', via: 'api' };
    expect(decidePath(input({ unsettled }))).toMatchObject({
      allow: false,
      code: 'outcome_unconfirmed',
      path: 'settle',
    });
    expect(decidePath(input({ unsettled, via: 'api', api: withApi }))).toMatchObject({
      allow: false,
      code: 'outcome_unconfirmed',
    });
  });

  test('the browser stands in only when the app could not do it, never around a no or a wait', () => {
    expect(decidePath(input({ api: { ...withApi, refused: 'around' } }))).toMatchObject({
      allow: true,
      path: 'browser',
    });
    for (const api of [
      { ...withApi, refused: 'blocking' as const },
      { ...withApi, pending: true, refused: 'around' as const },
      { ...withApi, denied: true, refused: 'around' as const },
    ])
      expect(decidePath(input({ api })).allow).toBe(false);
  });

  test('with no app, the browser is used, until its record says to hand it to the person', () => {
    expect(decidePath(input({ service: 'opentable.com' }))).toMatchObject({ allow: true });
    const missed = { attempts: 3, successes: 0, streak: 3, last_fault_at: new Date('2026-10-07') };
    expect(decidePath(input({ service: 'opentable.com', record: missed }))).toMatchObject({
      allow: false,
      path: 'person',
    });
    // A run of misses long ago no longer decides.
    const old = { ...missed, last_fault_at: new Date('2026-09-01') };
    expect(decidePath(input({ service: 'opentable.com', record: old })).allow).toBe(true);
  });
});

describe('services', () => {
  test('a web app and its connected account read as one service', () => {
    expect(serviceOfUrl('https://mail.google.com/mail/u/0/')).toBe('google:mail');
    expect(serviceOfConnection({ provider: 'imap', configuration: { kind: 'gmail' } })).toBe(
      'google:mail',
    );
    expect(
      serviceOfConnection({
        provider: 'imap',
        configuration: { kind: 'mail', mail: { smtp: { host: 'smtp.gmail.com' } } },
      }),
    ).toBe('google:mail');
    expect(serviceOfUrl('https://outlook.office.com/calendar/view')).toBe('microsoft:calendar');
  });

  test('a site is its registrable name, and an unknown mailbox never matches a website', () => {
    expect(serviceOfUrl('https://www.opentable.com/booking')).toBe('opentable.com');
    expect(registrableName('shop.example.co.uk')).toBe('example.co.uk');
    expect(
      serviceOfConnection({
        provider: 'imap',
        configuration: { kind: 'mail', mail: { smtp: { host: 'mail.acme.test' } } },
      }),
    ).toBe('mail:mail.acme.test');
    expect(serviceOfUrl('https://acme.test/contact')).toBe('acme.test');
    expect(
      serviceOfConnection({
        provider: 'mcp',
        configuration: {
          server: { endpoint: { transport: 'http', url: 'https://mcp.linear.app/sse' } },
        },
      }),
    ).toBe('linear.app');
    expect(serviceOfUrl('javascript:alert(1)')).toBeNull();
  });
});
