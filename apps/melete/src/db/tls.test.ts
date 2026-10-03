import { describe, expect, test } from 'bun:test';
import type { PeerCertificate } from 'node:tls';
import { openDatabase } from './client.ts';
import { verifyingTls } from './tls.ts';

const certificate = (subjectaltname: string, cn: string) =>
  ({ subject: { CN: cn }, subjectaltname }) as unknown as PeerCertificate;

const url = (host: string, query: string) => `postgres://melete:p@${host}:5432/melete?${query}`;

describe('checking the database server', () => {
  test('a server reached by its IP address is checked against that address, not the empty server name', () => {
    const tls = verifyingTls(url('10.1.0.5', 'sslmode=verify-full'));
    // The drivers hand Node no server name for an address, and Node would check "localhost".
    expect(
      tls?.checkServerIdentity('localhost', certificate('IP Address:10.1.0.5', '10.1.0.5')),
    ).toBeUndefined();
    expect(tls?.rejectUnauthorized).toBe(true);
  });

  test('a certificate made out to another address is refused', () => {
    const tls = verifyingTls(url('10.1.0.5', 'sslmode=verify-full'));
    expect(
      tls?.checkServerIdentity('localhost', certificate('IP Address:10.1.0.6', '10.1.0.6')),
    ).toBeInstanceOf(Error);
    // An address in the common name alone does not count, as Node and libpq agree.
    expect(
      tls?.checkServerIdentity('localhost', certificate('DNS:db.example.net', '10.1.0.5')),
    ).toBeInstanceOf(Error);
  });

  test('a server reached by name is checked against that name', () => {
    const tls = verifyingTls(url('db.example.net', 'sslmode=verify-full'));
    expect(
      tls?.checkServerIdentity(
        'db.example.net',
        certificate('DNS:db.example.net', 'db.example.net'),
      ),
    ).toBeUndefined();
    expect(
      tls?.checkServerIdentity(
        'db.example.net',
        certificate('DNS:other.example.net', 'other.example.net'),
      ),
    ).toBeInstanceOf(Error);
    const system = verifyingTls(url('db.example.net', 'sslrootcert=system'));
    expect(system?.checkServerIdentity('', certificate('DNS:db.example.net', 'x'))).toBeUndefined();
  });

  test('verify-ca checks the authority only; require and no mode keep the driver reading', () => {
    const ca = verifyingTls(url('10.1.0.5', 'sslmode=verify-ca'));
    expect(ca?.rejectUnauthorized).toBe(true);
    expect(
      ca?.checkServerIdentity('localhost', certificate('DNS:elsewhere', 'elsewhere')),
    ).toBeUndefined();
    expect(verifyingTls(url('10.1.0.5', 'sslmode=require'))).toBeNull();
    expect(verifyingTls('postgres://melete:p@postgres:5432/melete')).toBeNull();
  });

  test('the service client takes the check, and require stays its own', async () => {
    const full = openDatabase(url('10.1.0.5', 'sslmode=verify-full'), 1);
    const ssl = full.sql.options.ssl as unknown as { checkServerIdentity?: unknown };
    expect(typeof ssl.checkServerIdentity).toBe('function');
    const required = openDatabase(url('10.1.0.5', 'sslmode=require'), 1);
    expect(required.sql.options.ssl as unknown).toBe('require');
    await Promise.all([full.close(), required.close()]);
  });
});
