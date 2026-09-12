/**
 * The scripted model the memory runner talks to.
 *
 * One HTTP endpoint plays both model-shaped roles the suite needs, so the
 * boundary is real even though nothing leaves the machine and nothing is paid
 * for. As the Tier-1 extractor it returns proposals built from the request the
 * service actually sent: the source id and version, the segment bounds, and the
 * claims snapshot. As the assistant answering a question it may use only the
 * items recall delivered, which is what makes "unsupported claim" a thing the
 * runner can count rather than a thing it has to trust.
 */
import type { ExtractionProposal } from '@melete/contracts';
import { gatewayChatClient } from '../../apps/melete/src/memory/extract.ts';

/** Where a scripted proposal's span is read from. */
export type Citation = {
  source_id: string;
  source_version: string;
  /** The whole text those offsets are measured against. */
  text: string;
  /** Added to every offset, for a segment that does not start at zero. */
  offset: number;
};
export type ScriptEntry = {
  key: string;
  content: string;
  kind: string;
  factual_status: string;
  quote?: string;
  valid_from?: string;
  valid_until: string | null;
  /** `null` means cite the evidence this invocation was given. */
  cite: Citation | null;
};

export type DeliveredItem = {
  handle: string;
  key: string | null;
  content: string;
  origin_trust: string;
  disputed: boolean;
  status: string;
  valid_from: string;
  valid_until: string | null;
  superseded_at: string | null;
};
export type AskRequest = {
  question: string;
  key: string;
  mode: 'current' | 'historical';
  items: DeliveredItem[];
};
export type AskReply = {
  answer: string | null;
  uses: string[];
  disputed: boolean;
  question: string | null;
};

const ANSWER_INSTRUCTIONS =
  'Answer only from the supplied recall items. Cite the handle of every item you used. ' +
  'If nothing supplied answers the question, ask the owner instead of guessing.';

/**
 * The scripted assistant. It answers from the item that holds the key it was
 * asked about and cites that item's handle, and when recall delivered nothing
 * it asks rather than inventing a value. This is deliberately the most
 * charitable assistant possible: every failure the runner records is therefore
 * a failure of what memory served, not of how cleverly it was read.
 */
export function scriptedAnswer(request: AskRequest): AskReply {
  const matching = request.items.filter((item) => item.key === request.key);
  // Current work takes the head. A historical question is about the plan as it
  // stood, so a revision that was explicitly superseded answers it better than
  // one that was merely filed as history.
  const chosen =
    matching.find((item) => item.status === 'active' || item.status === 'disputed') ??
    (request.mode === 'historical'
      ? matching.find((item) => item.superseded_at !== null)
      : undefined) ??
    matching[0];
  if (!chosen)
    return {
      answer: null,
      uses: [],
      disputed: false,
      question: `I have nothing recorded for ${request.key}. What should it be?`,
    };
  return {
    answer: chosen.content,
    uses: [chosen.handle],
    disputed: chosen.disputed,
    question: null,
  };
}

function proposalFor(
  entry: ScriptEntry,
  evidence: { source: { source_id: string; source_version: string }; start: number; text: string },
): ExtractionProposal | null {
  const citation: Citation = entry.cite ?? {
    source_id: evidence.source.source_id,
    source_version: evidence.source.source_version,
    text: evidence.text,
    offset: evidence.start,
  };
  const quote = entry.quote ?? citation.text;
  const index = citation.text.indexOf(quote);
  if (index < 0) return null;
  return {
    op: 'add',
    expected_revision: null,
    domain_key: entry.key,
    key: entry.key,
    content: entry.content,
    kind: entry.kind,
    factual_status: entry.factual_status,
    valid_from: entry.valid_from ?? new Date().toISOString(),
    valid_until: entry.valid_until,
    sources: [
      {
        source_id: citation.source_id,
        source_version: citation.source_version,
        start: citation.offset + index,
        end: citation.offset + index + quote.length,
        quote,
      },
    ],
  } as ExtractionProposal;
}

export type ScriptedProvider = Awaited<ReturnType<typeof startScriptedProvider>>;

export async function startScriptedProvider(port = 3124) {
  const token = 'scripted-memory-conformance';
  const script = new Map<string, ScriptEntry>();
  const calls = { extraction: 0, answer: 0 };
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (
        new URL(request.url).pathname !== '/v1/chat/completions' ||
        request.headers.get('authorization') !== `Bearer ${token}`
      )
        return new Response(null, { status: 403 });
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const user = JSON.parse(body.messages[body.messages.length - 1]?.content ?? '{}');
      if (user.ask) {
        calls.answer++;
        return Response.json({
          choices: [
            { message: { role: 'assistant', content: JSON.stringify(scriptedAnswer(user.ask)) } },
          ],
          usage: { prompt_tokens: 60, completion_tokens: 20 },
        });
      }
      calls.extraction++;
      const entry = user.evidence ? script.get(user.evidence.source.source_id) : undefined;
      const proposal = entry ? proposalFor(entry, user.evidence) : null;
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ proposals: proposal ? [proposal] : [] }),
            },
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 40 },
      });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  return {
    calls,
    /** Register what the extractor will propose for one source, before it runs. */
    script: (sourceId: string, entry: ScriptEntry) => script.set(sourceId, entry),
    gateway: gatewayChatClient(endpoint, token, 'scripted-memory-conformance-v1'),
    async ask(request: AskRequest): Promise<AskReply> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'scripted-memory-conformance-v1',
          max_tokens: 400,
          messages: [
            { role: 'system', content: ANSWER_INSTRUCTIONS },
            { role: 'user', content: JSON.stringify({ ask: request }) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`scripted answer failed: ${response.status}`);
      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
      };
      return JSON.parse(data.choices[0]?.message.content ?? '{}') as AskReply;
    },
    close: () => server.stop(true),
  };
}
