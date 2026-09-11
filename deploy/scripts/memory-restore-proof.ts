/**
 * Three phases around an operator-owned pg_dump/restore of the Compose stack:
 *
 *   bun deploy/scripts/memory-restore-proof.ts seed <unique-run-id>
 *   # Take pg_dump now, preserving /data/restrictions independently.
 *   bun deploy/scripts/memory-restore-proof.ts forget <unique-run-id>
 *   # Stop services, restore that dump into an empty database, then start Melete normally.
 *   bun deploy/scripts/memory-restore-proof.ts verify <unique-run-id>
 *
 * DATABASE_URL and MELETE_RESTRICTIONS_DIR come from the service environment.
 * The verify phase never runs recovery or changes readiness: only normal
 * service startup can make an old snapshot pass it.
 */
import { join } from 'node:path';
import { openDatabase } from '../../apps/melete/src/db/client.ts';
import { listClaims } from '../../apps/melete/src/memory/claims.ts';
import { commitExtraction } from '../../apps/melete/src/memory/commit.ts';
import {
  type MemoryScope,
  type MemorySql,
  stableEntityId,
} from '../../apps/melete/src/memory/db.ts';
import { ingest } from '../../apps/melete/src/memory/evidence.ts';
import { forgetMemory } from '../../apps/melete/src/memory/forget.ts';
import { recall } from '../../apps/melete/src/memory/recall.ts';
import { FileRestrictionJournal } from '../../apps/melete/src/memory/restore.ts';
import { observationProposals } from '../../apps/melete/src/memory/tier0.ts';
import { buildViews } from '../../apps/melete/src/memory/views.ts';
import { claimWork } from '../../apps/melete/src/memory/work.ts';

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function scopeFor(sql: MemorySql, id: string): Promise<MemoryScope> {
  const [row] = await sql`select owner_id, restore_ready, revoked
    from memory_spaces where space_id = ${id}`;
  requireThat(row, 'The restore fixture does not exist in this database.');
  requireThat(row.restore_ready && !row.revoked, 'Memory startup has not opened the restore gate.');
  return {
    ownerId: row.owner_id,
    spaceId: id,
    publisher: 'w6-restore-proof',
    audience: 'private',
    role: 'owner',
  };
}

async function assertRecall(sql: MemorySql, scope: MemoryScope, forgotten: boolean) {
  const clinic = await recall(sql, scope, { query: 'clinic' });
  const dentist = await recall(sql, scope, { query: 'dentist' });
  requireThat(
    clinic.status !== 'unavailable' && dentist.status !== 'unavailable',
    'An unavailable memory response cannot establish that a fact was forgotten.',
  );
  requireThat(
    forgotten
      ? clinic.items.length === 0
      : clinic.items.length === 1 && clinic.items[0]?.content === 'clinic@example.test',
    forgotten
      ? 'The forgotten clinic address was served.'
      : 'The positive clinic fixture is absent.',
  );
  requireThat(
    dentist.items.length === 1 && dentist.items[0]?.content === 'dentist@example.test',
    'The unrelated dentist address was lost or unavailable.',
  );
  return { forgotten_items: clinic.items.length, retained_items: dentist.items.length };
}

async function seed(sql: MemorySql, journal: FileRestrictionJournal, runId: string, id: string) {
  const [owner] = await sql`select id from owner limit 1`;
  requireThat(owner, 'Complete owner setup before preparing the restore fixture.');
  const records = await journal.read();
  requireThat(
    !records.some((record) => record.space_id === id),
    'This run id already has retained restrictions; choose a new run id.',
  );
  await sql.begin(async (tx) => {
    const existing = await tx`select id from space where id = ${id}`;
    requireThat(existing.length === 0, 'This run id already exists; choose a new run id.');
    await tx`insert into space (id, name, git_path)
      values (${id}, ${`W6 restore proof ${runId}`}, ${`/data/spaces/${id}`})`;
    await tx`insert into memory_spaces (space_id, owner_id, restore_ready)
      values (${id}, ${owner.id}, true)`;
    await tx`insert into memory_index_manifest (space_id) values (${id})`;
  });
  const scope = await scopeFor(sql, id);
  for (const slug of ['clinic', 'dentist']) {
    const source = await ingest(sql, scope, {
      stream: 'contacts',
      source_identity: `${runId}-${slug}`,
      source_version: '1',
      source_type: 'observation',
      event_at: '2026-09-11T00:00:00Z',
      text: JSON.stringify({ kind: 'contact', slug, email: `${slug}@example.test` }),
    });
    const [work] =
      await sql`select id from memory_work where source_id = ${source.source.source_id}`;
    requireThat(work, 'The fixture observation did not create durable extraction work.');
    const batch = await claimWork(sql, scope, { workId: work.id });
    if (batch) {
      const result = await commitExtraction(sql, scope, batch, {
        proposals: observationProposals(batch.source, batch.text),
      });
      requireThat(
        result.status === 'committed',
        'The fixture observation was not validated and committed.',
      );
    } else {
      // The running deployment may have claimed the same durable work first.
      const deadline = Date.now() + 7000;
      let committed = false;
      while (!committed && Date.now() < deadline) {
        committed = (await listClaims(sql, scope)).claims.some(
          (claim) => claim.current.content === `${slug}@example.test`,
        );
        if (!committed) await Bun.sleep(50);
      }
      requireThat(committed, 'The deployment worker did not finish the fixture observation.');
    }
  }
  await buildViews(sql, scope);
  return assertRecall(sql, scope, false);
}

export async function runMemoryRestoreProof(
  phase: 'seed' | 'forget' | 'verify',
  runId: string,
  env: Record<string, string | undefined> = process.env,
) {
  requireThat(
    /^[A-Za-z0-9_-]{1,80}$/.test(runId),
    'Use a unique run id of 1–80 letters, digits, _ or -.',
  );
  requireThat(env.DATABASE_URL, 'DATABASE_URL is required.');
  const handle = openDatabase(env.DATABASE_URL, 2);
  const id = stableEntityId('sp', 'w6-restore-proof', runId);
  const journal = new FileRestrictionJournal(
    join(env.MELETE_RESTRICTIONS_DIR ?? '/data/restrictions', 'restrictions.jsonl'),
  );
  const started = performance.now();
  try {
    if (phase === 'seed') {
      const counts = await seed(handle.sql, journal, runId, id);
      return {
        phase,
        run_id: runId,
        space_id: id,
        ...counts,
        duration_ms: performance.now() - started,
      };
    }
    const scope = await scopeFor(handle.sql, id);
    if (phase === 'forget') {
      const claims = (await listClaims(handle.sql, scope)).claims;
      const clinic = claims.find((claim) => claim.current.content === 'clinic@example.test');
      requireThat(clinic, 'The clinic address is not available to forget.');
      await forgetMemory(handle.sql, scope, { claim_id: clinic.id }, journal);
    }
    const retainedRestrictions = (await journal.read()).filter((record) => record.space_id === id);
    requireThat(
      retainedRestrictions.length > 0,
      'The independent journal has no fixture restriction.',
    );
    const [replayed] = await handle.sql`select count(*)::int as count from memory_suppressions
      where space_id = ${id} and id = any(${retainedRestrictions.map((record) => record.id)})`;
    requireThat(
      replayed?.count === retainedRestrictions.length,
      'The retained restriction has not been replayed into this database.',
    );
    const counts = await assertRecall(handle.sql, scope, true);
    return {
      phase,
      run_id: runId,
      space_id: id,
      journal_restrictions: retainedRestrictions.length,
      replayed_restrictions: replayed.count,
      ...counts,
      duration_ms: performance.now() - started,
    };
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  const [phase, runId] = process.argv.slice(2);
  requireThat(
    (phase === 'seed' || phase === 'forget' || phase === 'verify') && runId,
    'Usage: bun deploy/scripts/memory-restore-proof.ts seed|forget|verify <unique-run-id>',
  );
  process.stdout.write(`${JSON.stringify(await runMemoryRestoreProof(phase, runId))}\n`);
}
