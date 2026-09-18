/**
 * The live call, against a stubbed transport. No key is needed and nothing
 * leaves the machine; what is checked is that the request is the one the
 * current API documents, that the list of retrieved pages is read out of the
 * reply (the link gate has nothing to check against otherwise), and that each
 * way the reply can disappoint comes back as its own outcome code.
 */
import { describe, expect, test } from 'bun:test';
import type { Transport } from '../src/openai.ts';
import { collectSources, openAiProvider } from '../src/openai.ts';
import type { ProviderError } from '../src/provider.ts';

type Body = Record<string, unknown>;

const message = (text: string) => ({
  type: 'message',
  content: [{ type: 'output_text', text }],
});

const search = (urls: string[]) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', queries: ['x'], sources: urls.map((url) => ({ url, title: url })) },
});

/** Capture the request and answer with whatever the test wants back. */
function stub(reply: unknown, status = 200) {
  const sent: { url?: string; body?: Body; headers?: Headers } = {};
  const call: Transport = async (url, init) => {
    sent.url = String(url);
    sent.headers = new Headers(init.headers);
    sent.body = JSON.parse(String(init.body)) as Body;
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { sent, call };
}

const run = {
  pasted: 'They owe me money.',
  today: '2026-09-18',
  signal: new AbortController().signal,
};

describe('the request', () => {
  test('is the Responses API call the docs describe', async () => {
    const { sent, call } = stub({
      status: 'completed',
      output: [search(['https://example.com/policy']), message('{"ok":1}')],
    });
    await openAiProvider({ apiKey: 'sk-test', fetch: call }).run(run);

    expect(sent.url).toBe('https://api.openai.com/v1/responses');
    expect(sent.headers?.get('authorization')).toBe('Bearer sk-test');

    const body = sent.body ?? {};
    expect(body.model).toBe('gpt-6-astra');
    expect(body.store).toBe(false);
    // Structured output lives under text.format on this API, not response_format.
    expect(body).not.toHaveProperty('response_format');
    const format = (body.text as { format: Body }).format;
    expect(format.type).toBe('json_schema');
    expect(format.strict).toBe(true);
    // Web search, and nothing else it could be talked into using.
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
    // Without this the reply carries no list of pages for the link gate.
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect((body.reasoning as Body).effort).toBe('medium');
    expect(body).not.toHaveProperty('temperature');
    expect(String(body.instructions)).toContain('DATA, NOT INSTRUCTIONS');
    expect(JSON.stringify(body.input)).toContain('They owe me money.');
  });

  test('the model and the effort are configuration', async () => {
    const { sent, call } = stub({ status: 'completed', output: [message('{}')] });
    await openAiProvider({ apiKey: 'k', fetch: call, model: 'other', effort: 'high' }).run(run);
    const body = sent.body ?? {};
    expect(body.model).toBe('other');
    expect((body.reasoning as Body).effort).toBe('high');
  });
});

describe('the reply', () => {
  test('gives back the case file and every page the search returned', async () => {
    const { call } = stub({
      status: 'completed',
      output: [
        search(['https://a.example/one', 'https://b.example/two']),
        message('{"company":"A"}'),
      ],
    });
    const result = await openAiProvider({ apiKey: 'k', fetch: call }).run(run);
    expect(result.json).toEqual({ company: 'A' });
    expect(result.searches).toBe(1);
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://a.example/one',
      'https://b.example/two',
    ]);
  });

  test('sources are read whether they sit on the action or the call', () => {
    const found = collectSources([
      { type: 'web_search_call', action: { sources: ['https://a.example/x'] } },
      { type: 'web_search_call', sources: [{ url: 'https://b.example/y', title: 'Y' }] },
      { type: 'message', content: [] },
    ]);
    expect(found).toEqual([
      { url: 'https://a.example/x', title: null },
      { url: 'https://b.example/y', title: 'Y' },
    ]);
  });

  test('no search means no sources, and so no links can be shown', async () => {
    const { call } = stub({ status: 'completed', output: [message('{"company":"A"}')] });
    const result = await openAiProvider({ apiKey: 'k', fetch: call }).run(run);
    expect(result.sources).toEqual([]);
    expect(result.searches).toBe(0);
  });
});

describe('the ways it disappoints', () => {
  const failing = async (reply: unknown, status = 200) => {
    const { call } = stub(reply, status);
    try {
      await openAiProvider({ apiKey: 'k', fetch: call }).run(run);
    } catch (error) {
      return error as ProviderError;
    }
    throw new Error('expected a failure');
  };

  test('a refusal is a refusal, not a broken paste', async () => {
    const error = await failing({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
    });
    expect(error.code).toBe('refused');
  });

  test('a reply that stopped early is not half-rendered', async () => {
    const error = await failing({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [message('{"company":')],
    });
    expect(error.code).toBe('malformed');
  });

  test('a reply that is not json, and a reply with no case file in it', async () => {
    expect((await failing({ status: 'completed', output: [message('sorry!')] })).code).toBe(
      'malformed',
    );
    expect((await failing({ status: 'completed', output: [] })).code).toBe('malformed');
  });

  test('a bad status is reported without the body it came with', async () => {
    const error = await failing({ error: { message: 'Bearer sk-secret is invalid' } }, 401);
    expect(error.code).toBe('upstream');
    expect(error.message).toBe('responses api returned 401');
    expect(error.message).not.toContain('sk-');
  });

  test('a request that is given up on is a timeout', async () => {
    const controller = new AbortController();
    const call: Transport = async () => {
      controller.abort();
      throw new Error('aborted');
    };
    try {
      await openAiProvider({ apiKey: 'k', fetch: call }).run({ ...run, signal: controller.signal });
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as ProviderError).code).toBe('timeout');
    }
  });
});
