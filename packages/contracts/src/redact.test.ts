import { describe, expect, test } from 'bun:test';
import { REDACTED, REDACTED_EMAIL, redactText, redactUrl } from './redact.ts';

describe('redactUrl', () => {
  test('keeps the endpoint and replaces sensitive query values', () => {
    expect(redactUrl('https://melete.example/api/conversations?token=abc123&limit=20')).toBe(
      `https://melete.example/api/conversations?token=${REDACTED}&limit=20`,
    );
    expect(redactUrl('/api/oauth/callback?code=4/0Ab-xyz&state=s1&scope=mail')).toBe(
      `/api/oauth/callback?code=${REDACTED}&state=${REDACTED}&scope=mail`,
    );
    expect(redactUrl('/api/search?q=my%20salary')).toBe(`/api/search?q=${REDACTED}`);
  });

  test('replaces emails anywhere in the address', () => {
    expect(redactUrl('/api/people/jamie%40example.com/mail?from=ana@example.org')).toBe(
      `/api/people/${REDACTED_EMAIL}/mail?from=${REDACTED_EMAIL}`,
    );
  });

  test('drops credentials in the authority and the fragment', () => {
    expect(redactUrl('https://user:pass@host.example/path#access_token=x')).toBe(
      'https://host.example/path#…',
    );
  });

  test('replaces long tokens in the path and keeps short ids', () => {
    const token = 'k9Qm2Xw8Lr4Tz6Yp1Vb3Nc5Hd7Fg0Js2Ae4';
    expect(redactUrl(`/api/signin/magic-link/${token}`)).toBe(`/api/signin/magic-link/${REDACTED}`);
    expect(redactUrl('/api/jobs/job_01J9ZK/events?after=12')).toBe(
      '/api/jobs/job_01J9ZK/events?after=12',
    );
  });

  test('reads a hash route as a path and a query', () => {
    expect(redactUrl('#/chat/c_1?email=a@b.co&tab=memory')).toBe(
      `#/chat/c_1?email=${REDACTED}&tab=memory`,
    );
  });

  test('bounds its length', () => {
    expect(redactUrl(`/api/${'a/'.repeat(400)}`).length).toBe(500);
  });
});

describe('redactText', () => {
  test('replaces emails, bearer credentials and JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactText(
      `Failed for jamie@example.com with Authorization: Bearer sk-live-abc and ${jwt}`,
    );
    expect(out).not.toContain('jamie@example.com');
    expect(out).not.toContain('sk-live-abc');
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED_EMAIL);
  });

  test('replaces the value of a sensitive pair and keeps its name', () => {
    expect(redactText('melete_session=AbCdEf123; path=/')).toBe(
      `melete_session=${REDACTED}; path=/`,
    );
    expect(redactText('{"api_key": "xyz789", "ok": true}')).toBe(
      `{"api_key": "${REDACTED}", "ok": true}`,
    );
    expect(redactText('password: hunter22')).toBe(`password: ${REDACTED}`);
  });

  test('replaces long key-like runs', () => {
    expect(redactText('id 3f786850e387550fdab836ed7e6dc881de23001b done')).toBe(
      `id ${REDACTED} done`,
    );
  });

  test('leaves an ordinary error alone and bounds its length', () => {
    expect(redactText('TypeError: cannot read properties of undefined (reading "map")')).toBe(
      'TypeError: cannot read properties of undefined (reading "map")',
    );
    expect(redactText('x'.repeat(5000)).length).toBeLessThanOrEqual(1000);
  });
});
