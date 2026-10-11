import { describe, expect, test } from 'bun:test';
import {
  claimNotice,
  isLoopbackHost,
  newSetupCode,
  normalizeSetupCode,
  openClaimRefused,
  publicAddress,
  setupCodeHash,
  setupLink,
} from './setup-code.ts';

test('a setup code is five groups of four characters nobody misreads', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}(-[A-HJKMNP-TV-Z2-9]{4}){4}$/);
    seen.add(code);
  }
  expect(seen.size).toBe(2000);
});

test('the code matches however it is typed', () => {
  const code = 'ABCD-EFGH-JKMN-PQRS-TVWX';
  expect(normalizeSetupCode(' abcd efgh-jkmn pqrs tvwx ')).toBe('ABCDEFGHJKMNPQRSTVWX');
  expect(setupCodeHash('abcdefghjkmnpqrstvwx')).toBe(setupCodeHash(code));
  expect(setupCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
});

test('the setup link opens the sign-in screen with the code, in the fragment', () => {
  const link = new URL(setupLink('https://melete.example.com/', 'ABCD-EFGH-JKMN-PQRS-TVWX'));
  expect(link.pathname).toBe('/');
  expect(link.search).toBe('');
  expect(link.hash).toBe('#/welcome?code=ABCD-EFGH-JKMN-PQRS-TVWX');
});

test('only names and addresses of this machine count as loopback', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'melete.localhost',
    '127.0.0.1',
    '127.255.3.9',
    '::1',
    '[::1]',
  ])
    expect([host, isLoopbackHost(host)]).toEqual([host, true]);
  for (const host of [
    'melete.example.test',
    'localhost.example.test',
    '127.0.0.1.nip.io',
    '128.0.0.1',
    '10.0.0.5',
    '192.168.1.20',
    '0.0.0.0',
    '[::]',
    '[::ffff:7f00:1]',
    '',
  ])
    expect([host, isLoopbackHost(host)]).toEqual([host, false]);
});

test('an address other machines reach is found in either setting, as written', () => {
  expect(publicAddress({})).toBeNull();
  expect(publicAddress({ MELETE_PUBLIC_URL: '', MELETE_WEB_ORIGIN: '  ' })).toBeNull();
  for (const local of [
    'http://127.0.0.1:3101',
    'http://localhost:3101/',
    'http://[::1]:3101',
    'http://[0:0:0:0:0:0:0:1]:3101',
    'http://127.1:3101',
  ])
    expect([local, publicAddress({ MELETE_PUBLIC_URL: local })]).toEqual([local, null]);
  expect(
    publicAddress({
      MELETE_PUBLIC_URL: 'http://127.0.0.1:3101',
      MELETE_WEB_ORIGIN: 'https://melete.tail1a2b3.ts.net',
    }),
  ).toBe('https://melete.tail1a2b3.ts.net');
  expect(publicAddress({ MELETE_PUBLIC_URL: 'https://melete.example.com' })).toBe(
    'https://melete.example.com',
  );
  // Not a URL: nothing says it stays on this machine.
  expect(publicAddress({ MELETE_WEB_ORIGIN: 'melete.example.com' })).toBe('melete.example.com');
});

test('the first visitor is refused only at a public address the operator did not open', () => {
  const exposed = { MELETE_PUBLIC_URL: 'https://melete.example.com' };
  expect(openClaimRefused(exposed)).toBe(true);
  expect(openClaimRefused({ ...exposed, MELETE_SETUP_OPEN: false })).toBe(true);
  expect(openClaimRefused({ ...exposed, MELETE_SETUP_OPEN: true })).toBe(false);
  expect(openClaimRefused({ MELETE_PUBLIC_URL: 'http://127.0.0.1:3101' })).toBe(false);
  expect(openClaimRefused({})).toBe(false);
});

/**
 * A database for claimNotice: whether an owner exists and whether a setup
 * code was issued. Any other query fails the test.
 */
function claimDatabase(state: { owner?: boolean; issued?: boolean }) {
  const queries: string[] = [];
  const sql = async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    queries.push(query);
    if (query.includes('from owner')) return state.owner ? [{ '?column?': 1 }] : [];
    if (query.includes('from setup_code')) return state.issued ? [{ '?column?': 1 }] : [];
    throw new Error(`unexpected query: ${query}`);
  };
  return { sql: sql as unknown as Parameters<typeof claimNotice>[0], queries };
}

describe('the line the service logs at start about claiming it', () => {
  const exposed = { MELETE_PUBLIC_URL: 'https://melete.example.com' };

  test('no account and no code at a public address: it says a setup code is needed', async () => {
    const notice = await claimNotice(claimDatabase({}).sql, exposed);
    expect(notice).toBe(
      'No account exists yet, and https://melete.example.com can be reached from other machines, so creating it needs a setup code. Run bun run melete account setup-code on this host to make one.',
    );
  });

  test('the web origin alone is enough to say so', async () => {
    const notice = await claimNotice(claimDatabase({}).sql, {
      MELETE_WEB_ORIGIN: 'https://melete.example.com',
    });
    expect(notice).toStartWith('No account exists yet, and https://melete.example.com');
  });

  test('a claim left open on purpose is a warning naming the address', async () => {
    const notice = await claimNotice(claimDatabase({}).sql, {
      ...exposed,
      MELETE_SETUP_OPEN: true,
    });
    expect(notice).toBe(
      "WARNING: MELETE_SETUP_OPEN=true and no account exists yet, so whoever opens https://melete.example.com first becomes this installation's owner. Create your account now, or run bun run melete account setup-code and set MELETE_SETUP_OPEN=false.",
    );
  });

  test('once an owner exists, nothing is said, open or not', async () => {
    const owned = { owner: true };
    expect(await claimNotice(claimDatabase(owned).sql, exposed)).toBeNull();
    expect(
      await claimNotice(claimDatabase(owned).sql, { ...exposed, MELETE_SETUP_OPEN: true }),
    ).toBeNull();
  });

  test('with a code configured or issued, nothing is said', async () => {
    expect(
      await claimNotice(claimDatabase({}).sql, {
        ...exposed,
        MELETE_SETUP_OPEN: true,
        MELETE_SETUP_CODE_HASH: 'a'.repeat(64),
      }),
    ).toBeNull();
    expect(await claimNotice(claimDatabase({ issued: true }).sql, exposed)).toBeNull();
  });

  test('on this machine only, nothing is said and the database is not asked', async () => {
    for (const settings of [
      {},
      { MELETE_PUBLIC_URL: 'http://127.0.0.1:3101' },
      { MELETE_WEB_ORIGIN: 'http://melete.localhost:3101', MELETE_SETUP_OPEN: true },
    ]) {
      const database = claimDatabase({});
      expect(await claimNotice(database.sql, settings)).toBeNull();
      expect(database.queries).toEqual([]);
    }
  });
});
