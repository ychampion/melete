/**
 * Whose budget a live scan spends.
 *
 * The extractor's gateway admits a fixed number of calls. If that number
 * belonged to the process, one person scanning often enough would use it up
 * and every later scan, anyone's, would quietly find nothing. Each scan gets a
 * gateway and a budget of its own instead, and these tests hold that.
 */

import { describe, expect, test } from 'bun:test';
import type { GatewayProvider } from '../gateway/types.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { DEFAULT_EXTRACTION_MODEL } from './gateway.ts';
import { fixtureMailbox } from './mailbox.ts';
import { MemoryCompanyStore, type Owner } from './repository.ts';
import { runScan } from './scan.ts';
import { gatewayExtractor, SCAN_CALL_CEILING } from './service.ts';

const provider: GatewayProvider = {
  name: 'openai',
  baseUrl: 'https://api.openai.com/v1/',
  apiKey: 'a-key-that-stays-inside-the-gateway',
  protocols: ['chat/completions', 'responses'],
};

/** Stands in for the provider at the socket, and counts what reached it. */
function upstream() {
  const seen = { calls: 0 };
  const fetch = async (_request: Request): Promise<Response> => {
    seen.calls += 1;
    return Response.json({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: DEFAULT_EXTRACTION_MODEL,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify({ items: [] }) }],
        },
      ],
      usage: { input_tokens: 400, output_tokens: 10, total_tokens: 410 },
    });
  };
  return { seen, fetch };
}

const now = new Date(FIXTURE_REFERENCE);
const first: Owner = {
  spaceId: 'sp_01J000000000000000000000AA',
  principalId: 'own_01J00000000000000000000AA',
};
const second: Owner = {
  spaceId: 'sp_01J000000000000000000000BB',
  principalId: 'own_01J00000000000000000000BB',
};

describe('the live extractor’s budget', () => {
  test('belongs to one scan, so one person’s scans cannot spend another’s', async () => {
    const { seen, fetch } = upstream();
    const extractor = gatewayExtractor({
      provider: 'openai',
      model: DEFAULT_EXTRACTION_MODEL,
      providers: [provider],
      fetch,
    });
    const store = new MemoryCompanyStore();
    const scan = (owner: Owner) =>
      runScan({
        store,
        mailbox: fixtureMailbox(fixtureMessages()),
        extractor,
        owner,
        now,
      });

    // The first person scans until they have asked for more than any one scan may.
    // Each round is another of their spaces: a mailbox already read is not asked
    // about twice, so rescanning one space would spend nothing.
    let scans = 0;
    while (seen.calls <= SCAN_CALL_CEILING && scans < 20) {
      const before = seen.calls;
      expect((await scan({ ...first, spaceId: `${first.spaceId}${scans}` })).status).toBe('done');
      expect(seen.calls - before).toBeGreaterThan(0);
      scans += 1;
    }
    expect(seen.calls).toBeGreaterThan(SCAN_CALL_CEILING);

    // The second person's scan still reaches the model, message by message.
    const before = seen.calls;
    expect((await scan(second)).status).toBe('done');
    expect(seen.calls - before).toBeGreaterThan(0);
  }, 60_000);

  test('closes the gateway a scan opened when that scan ends', async () => {
    const { seen, fetch } = upstream();
    const live = gatewayExtractor({
      provider: 'openai',
      model: DEFAULT_EXTRACTION_MODEL,
      providers: [provider],
      fetch,
    });
    let session: Awaited<ReturnType<NonNullable<typeof live.forScan>>> | undefined;
    await runScan({
      store: new MemoryCompanyStore(),
      mailbox: fixtureMailbox(fixtureMessages()),
      extractor: {
        extract: live.extract,
        async forScan() {
          session = await live.forScan?.();
          if (!session) throw new Error('the live extractor has no scan session');
          return session;
        },
      },
      owner: first,
      now,
    });
    expect(session).toBeDefined();
    // Closed with its scan: the gateway it held forwards nothing further.
    const before = seen.calls;
    await session?.extract({
      messageId: '<1@example.test>',
      companyName: 'Example',
      domain: 'example.test',
      from: 'Example <billing@example.test>',
      subject: 'Receipt',
      receivedAt: now.toISOString(),
      text: 'Subject: Receipt\n\nThank you for your payment.',
    });
    expect(seen.calls).toBe(before);
  });
});
