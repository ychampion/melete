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
      'postgres://melete:p@db.example.net:5432/melete?sslmode=verify-full',
      'postgres://melete:p@postgres:5432/melete',
      'postgres://melete:p@db.example.net:5432/melete?sslmode=disable',
    ])
      expect(queueConnection(url)).toEqual({ connectionString: url });
  });
});
