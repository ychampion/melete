import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm';
import { databaseUnreachable, failureMessage } from './sweep-failure.ts';

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('a failure met by a background sweep', () => {
  test('a failed query is logged by its cause, never its statement or values', () => {
    const cause = coded('duplicate key value violates unique constraint "job_pkey"', '23505');
    const failed = new DrizzleQueryError(
      'insert into push_intent (title, body) values ($1, $2)',
      ['Compare two kettles', 'what it has so far'],
      cause,
    );
    const line = failureMessage(failed);
    expect(line).toBe('duplicate key value violates unique constraint "job_pkey"');
    expect(line).not.toContain('kettles');
    expect(line).not.toContain('push_intent');
  });

  test('a message stays on one line and loses the credentials it quotes', () => {
    const line = failureMessage(
      new Error('could not reach\npostgres://melete:hunter2@db.internal/melete'),
    );
    expect(line).not.toContain('\n');
    expect(line).not.toContain('hunter2');
  });

  test('a database out of reach stops the sweep; one failed item does not', () => {
    const query = (cause: Error) => new DrizzleQueryError('select 1', [], cause);
    expect(
      databaseUnreachable(query(coded('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'))),
    ).toBe(true);
    expect(databaseUnreachable(coded('write CONNECTION_ENDED', 'CONNECTION_ENDED'))).toBe(true);
    expect(databaseUnreachable(coded('connection failure', '08006'))).toBe(true);
    expect(
      databaseUnreachable(coded('terminating connection due to administrator command', '57P01')),
    ).toBe(true);
    expect(databaseUnreachable(query(coded('duplicate key', '23505')))).toBe(false);
    expect(databaseUnreachable(coded('could not obtain lock', '55P03'))).toBe(false);
    expect(databaseUnreachable(new Error('the record could not be read'))).toBe(false);
    expect(databaseUnreachable('not an error')).toBe(false);
  });
});
