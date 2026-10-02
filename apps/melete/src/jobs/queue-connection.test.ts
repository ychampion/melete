import { describe, expect, test } from 'bun:test';
import { queueConnection } from './queue.ts';

const URL_REQUIRE = 'postgres://melete:p%40ss@db.example.net:5432/melete?sslmode=require';

describe('the queue connection', () => {
  test('sslmode=require encrypts without verifying the certificate, as the service client and libpq read it', () => {
    const connection = queueConnection(URL_REQUIRE);
    expect(connection.ssl).toEqual({ rejectUnauthorized: false });
    // pg parses the string over its explicit options, so the mode must leave the string.
    const url = new URL(connection.connectionString);
    expect(url.searchParams.has('sslmode')).toBe(false);
    expect([
      url.hostname,
      url.port,
      url.pathname,
      url.username,
      decodeURIComponent(url.password),
    ]).toEqual(['db.example.net', '5432', '/melete', 'melete', 'p@ss']);
  });

  test('every other mode, and a URL without one, is passed as written', () => {
    for (const url of [
      'postgres://melete:p@postgres:5432/melete',
      'postgres://melete:p@db.example.net:5432/melete?sslmode=disable',
    ])
      expect(queueConnection(url)).toEqual({ connectionString: url });
  });

  test('require with a root certificate named stays verified, as libpq verifies it', () => {
    const url =
      'postgres://melete:p@db.example.net:5432/melete?sslmode=require&sslrootcert=/etc/melete/ca.pem';
    expect(queueConnection(url)).toEqual({ connectionString: url });
  });

  test('verify-full and sslrootcert=system leave the URL, and the server is checked against its own host, an address included', () => {
    for (const query of ['sslmode=verify-full', 'sslmode=verify-full&sslrootcert=system']) {
      const connection = queueConnection(`postgres://melete:p@10.1.0.5:5432/melete?${query}`);
      const url = new URL(connection.connectionString);
      // The driver would read sslrootcert=system as a file, and sslmode over these options.
      expect(url.searchParams.has('sslmode')).toBe(false);
      expect(url.searchParams.has('sslrootcert')).toBe(false);
      const ssl = connection.ssl as {
        rejectUnauthorized: boolean;
        checkServerIdentity: (name: string, cert: unknown) => Error | undefined;
      };
      expect(ssl.rejectUnauthorized).toBe(true);
      const cert = (san: string) => ({ subject: { CN: 'x' }, subjectaltname: san });
      expect(ssl.checkServerIdentity('localhost', cert('IP Address:10.1.0.5'))).toBeUndefined();
      expect(ssl.checkServerIdentity('localhost', cert('IP Address:10.1.0.6'))).toBeInstanceOf(
        Error,
      );
    }
  });
});
