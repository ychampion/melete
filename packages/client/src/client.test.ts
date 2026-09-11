import { describe, expect, test } from 'bun:test';
import { createMeleteClient, errorMessage, meleteUrl } from './client.ts';

type Call = { url: string; method: string; body: string | null; headers: Record<string, string> };

/** A fetch that records what it was asked for and answers from a script. */
function fakeFetch(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      url: request.url,
      method: request.method,
      body: request.body ? await request.text() : null,
      headers,
    };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createMeleteClient', () => {
  test('trims the base URL and keeps the resolved options beside the client', () => {
    const client = createMeleteClient({ baseUrl: 'http://localhost:3190///' });
    expect(client.options.baseUrl).toBe('http://localhost:3190');
    expect(client.options.credentials).toBe('include');
  });

  test('sends the list query as search parameters', async () => {
    const { fetch, calls } = fakeFetch(() => json({ jobs: [] }));
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const { data, error } = await client.api.GET('/jobs', {
      params: { query: { space_id: 'sp_01J000000000000000000000', limit: 5 } },
    });

    expect(error).toBeUndefined();
    expect(data).toEqual({ jobs: [] });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/jobs');
    expect(url.searchParams.get('space_id')).toBe('sp_01J000000000000000000000');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  test('posts a job as JSON and fills the path parameter', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === 'POST' ? json({ job: { id: 'job_1' } }, 201) : json({ job: {} }),
    );
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    await client.api.POST('/jobs', {
      body: {
        space_id: 'sp_01J000000000000000000000',
        title: 'Reply to the landlord',
        objective: 'Draft and send a reply.',
      },
    });
    await client.api.GET('/jobs/{jobId}', {
      params: { path: { jobId: 'job_01J000000000000000000000' } },
    });

    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}').title).toBe('Reply to the landlord');
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/jobs/job_01J000000000000000000000');
  });

  test('carries the caller headers on every request', async () => {
    const { fetch, calls } = fakeFetch(() => json({ approvals: [] }));
    const client = createMeleteClient({
      baseUrl: 'http://api.test',
      fetch,
      headers: { 'x-melete-client': 'reference-web' },
    });

    await client.api.GET('/approvals', {});

    expect(calls[0]?.headers['x-melete-client']).toBe('reference-web');
  });

  test('hands back the error body rather than throwing', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 'not_found', message: 'No such job' } }, 404),
    );
    const client = createMeleteClient({ baseUrl: 'http://api.test', fetch });

    const { data, error } = await client.api.GET('/jobs/{jobId}', {
      params: { path: { jobId: 'job_missing' } },
    });

    expect(data).toBeUndefined();
    expect(errorMessage(error)).toBe('No such job');
  });
});

describe('meleteUrl', () => {
  test('builds an absolute URL and drops empty query values', () => {
    const client = createMeleteClient({ baseUrl: 'http://api.test' });
    const url = meleteUrl(client, '/events', { after: 12, types: undefined, limit: null });
    expect(url).toBe('http://api.test/events?after=12');
  });
});

describe('errorMessage', () => {
  test('falls back when the body is not an API error', () => {
    expect(errorMessage(undefined)).toBe('The request failed.');
    expect(errorMessage({ error: {} }, 'nope')).toBe('nope');
  });
});
