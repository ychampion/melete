import type { ExtractionProposal } from '@melete/contracts';
import { gatewayChatClient } from '../../src/memory/extract.ts';
import type { ExtractionBatch } from '../../src/memory/work.ts';

export function tripProposal(batch: ExtractionBatch, content = 'July'): ExtractionProposal {
  const current = batch.claims.find((c) => c.domain_key === 'trip.month');
  const proposed = {
    domain_key: 'trip.month',
    content,
    kind:
      batch.source.source_type === 'document'
        ? ('document_assertion' as const)
        : ('user_statement' as const),
    factual_status: 'attributed' as const,
    valid_from: batch.source.event_at,
    valid_until: null,
    sources: [
      {
        source_id: batch.source.source_id,
        source_version: batch.source.source_version,
        start: batch.work.segment_start,
        end: batch.work.segment_end,
        quote: batch.text,
      },
    ],
  };
  return current
    ? {
        op: 'supersede',
        claim_id: current.id,
        expected_revision: current.head_revision,
        ...proposed,
      }
    : { op: 'add', expected_revision: null, ...proposed };
}
/** The HTTP boundary is real; responses are scripted and no external provider is contacted. */
export function fakeProvider(reply: () => Promise<ExtractionProposal[]> | ExtractionProposal[]) {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 3120,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (
        new URL(request.url).pathname !== '/v1/chat/completions' ||
        request.headers.get('authorization') !== 'Bearer scripted-test'
      )
        return new Response(null, { status: 403 });
      requests.push(await request.json());
      return Response.json({
        choices: [
          { message: { role: 'assistant', content: JSON.stringify({ proposals: await reply() }) } },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
    },
  });
  return {
    gateway: gatewayChatClient(
      'http://127.0.0.1:3120/v1/chat/completions',
      'scripted-test',
      'scripted-memory-v1',
    ),
    requests,
    close: () => server.stop(true),
  };
}
