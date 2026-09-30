import { beforeEach, expect, test } from 'bun:test';
import {
  RECENT_LIMIT,
  Ring,
  recentConsoleErrors,
  recentFailedRequests,
  recordConsoleError,
  recordingFetch,
  resetDiagnostics,
} from './diagnostics.ts';

beforeEach(resetDiagnostics);

test('a ring keeps the newest entries only', () => {
  const ring = new Ring<number>(3);
  for (let i = 1; i <= 5; i++) ring.push(i);
  expect(ring.list()).toEqual([3, 4, 5]);
  expect(RECENT_LIMIT).toBe(20);
});

test('a failed API request is remembered without its body or secrets', async () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const failing = recordingFetch(answer(403, { error: { code: 'scope_denied', message: 'x' } }));
  const response = await failing('http://localhost/api/feedback?token=abc&email=a@b.co', {
    method: 'POST',
    body: JSON.stringify({ message: 'private words' }),
  });
  // The caller still reads the whole answer.
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('scope_denied');

  const ok = recordingFetch(answer(200, { fine: true }));
  await ok('http://localhost/api/home');

  const refused = recordingFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  await expect(refused('http://localhost/api/plans')).rejects.toThrow('Failed to fetch');

  const aborted = recordingFetch(async () => {
    throw new DOMException('stopped', 'AbortError');
  });
  await expect(aborted('http://localhost/api/events')).rejects.toThrow('stopped');

  const recorded = recentFailedRequests();
  expect(recorded.map(({ url, status, code }) => ({ url, status, code }))).toEqual([
    {
      url: 'http://localhost/api/feedback?token=[redacted]&email=[redacted]',
      status: 403,
      code: 'scope_denied',
    },
    { url: 'http://localhost/api/plans', status: null, code: null },
  ]);
  expect(JSON.stringify(recorded)).not.toContain('private words');
});

test('console errors are redacted as they are recorded', () => {
  recordConsoleError(['Failed for jamie@example.com', new Error('token=abc123 expired')]);
  const [entry] = recentConsoleErrors();
  expect(entry?.message).toBe('Failed for [email] Error: token=[redacted] expired');
});
