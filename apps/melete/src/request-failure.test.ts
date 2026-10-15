import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { requestFailureText } from './request-failure.ts';

describe('requestFailureText', () => {
  test('a failed query keeps its text and code, never its values or the driver message', () => {
    const cause = Object.assign(
      new Error('invalid input syntax for type uuid: "sam@example.test"'),
      { code: '22P02' },
    );
    const error = new DrizzleQueryError(
      'select "id" from "principal" where "email" = $1',
      ['sam@example.test', 'divorce settlement'],
      cause,
    );
    const text = requestFailureText(error);
    expect(text).toBe(
      'Failed query: select "id" from "principal" where "email" = $1 (database error 22P02)',
    );
    expect(text).not.toContain('sam@example.test');
    expect(text).not.toContain('divorce');
  });

  test('any other error is written as it was', () => {
    expect(requestFailureText(new Error('the queue is closed'))).toBe('the queue is closed');
  });
});
