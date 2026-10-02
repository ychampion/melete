import { expect, test } from 'bun:test';
import {
  currentZone,
  plainError,
  plainFailure,
  plainRunReason,
  plainSchedule,
  plainTitle,
  zoneName,
} from './plain.ts';

test('failure codes read as a sentence with a next step', () => {
  expect(plainRunReason('It failed: HTTP 429: token_cap_exceeded')).toMatch(
    /^Today’s model allowance ran out\. .*Settings › Models\.$/,
  );
  expect(plainFailure('provider_key_unavailable')).toContain('Settings › Models');
  expect(plainFailure('upstream said 503 Service Unavailable')).toBe(
    'The model didn’t answer in time. Try again in a moment.',
  );
  expect(plainFailure('ValueError: weird_internal_thing')).toBe(
    'Something went wrong on the way. Try again in a moment.',
  );
  // A sentence the service already wrote is kept.
  expect(plainRunReason('It failed: the calendar could not be reached.')).toBe(
    'It failed: the calendar could not be reached.',
  );
  expect(plainRunReason('It was stopped before it finished.')).toBe(
    'It was stopped before it finished.',
  );
  // An API error keeps its own words unless it is a known code.
  expect(plainError('That email is already in use.')).toBe('That email is already in use.');
  expect(plainError('token_cap_exceeded')).toMatch(/^Today’s model allowance/);
});

test('stored paths and bare addresses read as a file or site name', () => {
  expect(plainTitle('art_01M3WHCANEP5NHW77TPG8QYEEK/ftA-deny.md')).toBe('ftA-deny.md');
  expect(plainTitle('[hidden]/approve-test.txt')).toBe('approve-test.txt');
  expect(plainTitle('art_01M3WHCANEP5NHW77TPG8QYEEK/[hidden]')).toBe('File');
  expect(plainTitle('https://www.example.com/forecast?x=1')).toBe('example.com');
  expect(plainTitle('Dinner at Rosa’s')).toBe('Dinner at Rosa’s');
  expect(plainTitle('notes/plan.md')).toBe('notes/plan.md');
});

test('time zones read by a name people use, old names included', () => {
  expect(currentZone('Asia/Calcutta')).toBe('Asia/Kolkata');
  const summer = new Date('2026-07-01T12:00:00Z');
  expect(zoneName('Asia/Calcutta', summer)).toBe('India Standard Time (Kolkata)');
  expect(zoneName('America/Los_Angeles', summer)).toBe('Pacific Time (Los Angeles)');
  expect(zoneName('UTC', summer)).toBe('UTC');
  // The same name all year, and a retired US name reads as its current zone.
  expect(zoneName('Europe/Berlin', summer)).toBe('Central European Time (Berlin)');
  expect(zoneName('US/Eastern', summer)).toBe('Eastern Time (New York)');
  expect(plainSchedule('Every day at 7:30 AM (Asia/Calcutta)', summer)).toBe(
    'Every day at 7:30 AM (India Standard Time)',
  );
  expect(plainSchedule('Weekdays at 8:00 AM (America/New_York)', summer)).toBe(
    'Weekdays at 8:00 AM (Eastern Time)',
  );
});
