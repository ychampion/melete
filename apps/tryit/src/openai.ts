/**
 * The live path: one call to the Responses API, structured output, web search
 * the only tool, nothing kept on OpenAI's side.
 *
 * Parameter names follow the current docs rather than memory: the structured
 * output goes in `text.format` (not `response_format`), the built-in search is
 * `{ type: 'web_search' }`, and the list of pages the search actually returned
 * only comes back when `web_search_call.action.sources` is asked for in
 * `include`. That list is the whole point of the call for the link gate:
 * without it there is no way to tell a page the model read from one it
 * remembered, so the gate would have nothing to check against.
 *
 * `store: false` keeps the pasted text out of OpenAI's dashboard, which is the
 * same promise the page makes about this Worker.
 */

import { systemPrompt, userPrompt } from './prompt.ts';
import type { CaseFileProvider, ProviderResult, ProviderRun } from './provider.ts';
import { ProviderError } from './provider.ts';
import { CASE_FILE_SCHEMA } from './schema.ts';
import type { SearchSource } from './validate.ts';

export const MODEL = 'gpt-6-astra';
const ENDPOINT = 'https://api.openai.com/v1/responses';

export type OpenAiOptions = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Passed straight through, so a slow day can be traded for a cheaper one. */
  effort?: 'low' | 'medium' | 'high';
  fetch?: typeof fetch;
};

type Unknowns = Record<string, unknown>;

const record = (value: unknown): Unknowns | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Unknowns) : null;

/**
 * Pull the list of retrieved pages out of the reply. Two shapes are read
 * because the docs describe `sources` as belonging to the search call and name
 * the include key `web_search_call.action.sources`; taking both costs nothing
 * and means a shape change upstream loses links rather than inventing them.
 */
export function collectSources(output: unknown[]): SearchSource[] {
  const found: SearchSource[] = [];
  const push = (entry: unknown) => {
    if (typeof entry === 'string') {
      found.push({ url: entry, title: null });
      return;
    }
    const item = record(entry);
    if (!item || typeof item.url !== 'string') return;
    found.push({ url: item.url, title: typeof item.title === 'string' ? item.title : null });
  };
  for (const entry of output) {
    const item = record(entry);
    if (item?.type !== 'web_search_call') continue;
    const action = record(item.action);
    for (const list of [action?.sources, item.sources]) {
      if (Array.isArray(list)) for (const source of list) push(source);
    }
  }
  return found;
}

/** How many searches the model ran. A count, never the queries. */
const countSearches = (output: unknown[]): number =>
  output.filter((entry) => record(entry)?.type === 'web_search_call').length;

/**
 * The case file is the text of the last assistant message. A refusal arrives
 * as its own content part and is reported as one, so the page can say the
 * model declined rather than blaming the paste.
 */
function readMessage(output: unknown[]): string {
  let text = '';
  for (const entry of output) {
    const item = record(entry);
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const piece = record(part);
      if (!piece) continue;
      if (piece.type === 'refusal' && typeof piece.refusal === 'string')
        throw new ProviderError('refused', piece.refusal);
      if (piece.type === 'output_text' && typeof piece.text === 'string') text += piece.text;
    }
  }
  return text.trim();
}

export function openAiProvider(options: OpenAiOptions): CaseFileProvider {
  const call = options.fetch ?? fetch;
  const model = options.model ?? MODEL;
  const endpoint = options.endpoint ?? ENDPOINT;

  return {
    name: model,
    async run({ pasted, today, signal }: ProviderRun): Promise<ProviderResult> {
      const body = {
        model,
        instructions: systemPrompt(today),
        input: [{ role: 'user', content: userPrompt(pasted) }],
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
        text: {
          format: {
            type: 'json_schema',
            name: 'case_file',
            strict: true,
            schema: CASE_FILE_SCHEMA,
          },
        },
        reasoning: { effort: options.effort ?? 'medium' },
        max_output_tokens: 6000,
        store: false,
      };

      let response: Response;
      try {
        response = await call(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new ProviderError('timeout', 'the model took too long');
        throw new ProviderError('upstream', describe(error));
      }

      if (!response.ok) {
        // An error body can echo the request back, key included, so only the status travels.
        await response.body?.cancel();
        throw new ProviderError('upstream', `responses api returned ${response.status}`);
      }

      const payload = record(await response.json());
      if (!payload) throw new ProviderError('malformed', 'the reply was not an object');
      if (payload.status === 'incomplete') {
        const reason = record(payload.incomplete_details)?.reason;
        throw new ProviderError('malformed', `the reply stopped early: ${String(reason)}`);
      }
      const output = Array.isArray(payload.output) ? payload.output : [];
      const text = readMessage(output);
      if (!text) throw new ProviderError('malformed', 'the reply had no case file in it');

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('malformed', 'the case file was not valid json');
      }

      return { json, sources: collectSources(output), searches: countSearches(output) };
    },
  };
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'the request did not complete';
