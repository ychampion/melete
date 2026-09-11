/** A separate, deliberately killed process. Its database and journal are disposable test fixtures. */
import postgres from 'postgres';
import { commitExtraction } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { cleanupMemory } from '../../src/memory/forget.ts';
import { claimWork } from '../../src/memory/work.ts';
import { fakeProvider, tripProposal } from './fake-provider.ts';

const sql = postgres(process.env.W7_FAULT_DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
const phase = process.argv[2];
const spaceId = process.argv[3] ?? '';
const [space] = await sql`select owner_id from memory_spaces where space_id = ${spaceId}`;
if (!space) throw new Error('fault fixture space missing');
const scope: MemoryScope = {
  ownerId: space.owner_id,
  spaceId,
  publisher: 'authenticated-owner',
  audience: 'private',
  role: 'owner',
};
const park = async (detail: Record<string, unknown> = {}): Promise<never> => {
  process.stdout.write(`${JSON.stringify({ ready: phase, ...detail })}\n`);
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
  throw new Error('unreachable');
};
if (phase === 'during-cleanup') {
  await cleanupMemory(sql, scope.spaceId, async () => park());
} else {
  await ingest(sql, scope, {
    stream: 'faults',
    source_identity: phase ?? '',
    source_version: '1',
    source_type: 'message',
    event_at: '2026-07-01T00:00:00Z',
    text: 'our trip is in July',
  });
  if (phase === 'after-input') await park();
  const batch = await claimWork(sql, scope);
  if (!batch) throw new Error('fault fixture work missing');
  if (phase === 'after-claim') await park({ batch });
  const provider = fakeProvider(() => [tripProposal(batch)]);
  const proposals = await proposeExtraction(sql, scope, batch, provider.gateway);
  await provider.close();
  if (phase === 'after-proposal') await park({ batch, proposals });
  const result = await commitExtraction(
    sql,
    scope,
    batch,
    { proposals },
    false,
    phase === 'before-publication' ? { beforePublication: () => park({ batch, proposals }) } : {},
  );
  if (result.status !== 'committed') throw new Error(`fault publication ${result.reason}`);
  await park({ batch, proposals, result });
}
