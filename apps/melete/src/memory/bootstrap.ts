import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prefixedId } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { SESSION_COOKIE } from '../api/auth.ts';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { applyRestriction } from './forget.ts';
import { lockEventOrder } from './invalidate.ts';
import { startJobRecompute } from './recompute.ts';
import { FileRestrictionJournal, restoreMemory } from './restore.ts';
import type { MemoryRouteOptions } from './routes.ts';
import { startMemoryService } from './service.ts';

type DeploymentMemoryOptions = {
  sql: MemorySql;
  boss: PgBoss;
  /** Retain this directory independently of Postgres backups. */
  restrictionsDir: string;
  workers?: boolean;
  /** Wakes a job memory invalidated; left out, invalidations wait for the runner's scan. */
  onJobRecompute?: (jobId: string) => Promise<void>;
};

const spaceId = prefixedId('sp');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function openJournal(sql: MemorySql, journal: FileRestrictionJournal) {
  // Commit the gate separately: a missing or corrupt journal must leave memory
  // closed even when the following initialization transaction rolls back.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    await tx`update memory_spaces set restore_ready = false`;
  });
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    try {
      await journal.read();
    } catch (error) {
      if (!missing(error)) throw error;
      const [existing] = await tx`select exists(select 1 from memory_spaces) as present`;
      if (existing?.present) throw new MemoryError('restriction_journal_missing');
      // Only a database that has never provisioned memory can create a journal.
      // initializeNew uses exclusive creation, so it cannot replace a retained file.
      await journal.initializeNew();
    }
  });
}

/** The singleton owner owns the catalog; request metadata cannot add a space. */
async function provisionCatalog(sql: MemorySql) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    await tx`insert into memory_spaces (space_id, owner_id)
      select s.id, o.id from space s cross join owner o on conflict do nothing`;
    await tx`insert into memory_index_manifest (space_id)
      select space_id from memory_spaces on conflict do nothing`;
  });
}

function sessionToken(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0]?.slice(SESSION_COOKIE.length + 1) ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Provision a space created after boot without reopening any existing restore gate. */
async function provisionNewSpace(
  sql: MemorySql,
  journal: FileRestrictionJournal,
  scope: MemoryScope,
) {
  await sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    const inserted = await tx`insert into memory_spaces (space_id, owner_id)
      values (${scope.spaceId}, ${scope.ownerId}) on conflict do nothing returning space_id`;
    const [row] = await tx`select owner_id from memory_spaces where space_id = ${scope.spaceId}`;
    if (row?.owner_id !== scope.ownerId) throw new MemoryError('scope_denied');
    await tx`insert into memory_index_manifest (space_id) values (${scope.spaceId}) on conflict do nothing`;
    if (!inserted.length) return;
    // An old snapshot can predate memory provisioning. Its independently
    // retained restrictions still apply when the catalog space is reopened.
    for (const record of await journal.read()) {
      if (record.owner_id === scope.ownerId && record.space_id === scope.spaceId)
        await applyRestriction(tx, record);
    }
    await tx`update memory_spaces set restore_ready = true
      where space_id = ${scope.spaceId} and not revoked`;
  });
}

function resolveOwnerScope(sql: MemorySql, journal: FileRestrictionJournal) {
  return async (request: Request): Promise<MemoryScope | null> => {
    const token = sessionToken(request);
    if (!token) return null;
    const selected = request.headers.get('x-melete-space');
    if (selected !== null && !spaceId.safeParse(selected).success) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await sql`select o.id as owner_id, s.id as space_id,
      m.owner_id as memory_owner_id, m.revoked
      from session auth join owner o on o.id = auth.owner_id cross join space s
      left join memory_spaces m on m.space_id = s.id
      where auth.token_hash = ${hash} and auth.expires_at > clock_timestamp()
        and (${selected}::text is null or s.id = ${selected})
      order by s.id limit 2`;
    // A sole space is unambiguous; callers with more than one must select one.
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (!row || row.revoked || (row.memory_owner_id && row.memory_owner_id !== row.owner_id))
      return null;
    const scope: MemoryScope = {
      ownerId: row.owner_id,
      spaceId: row.space_id,
      publisher: 'authenticated-owner',
      audience: 'private',
      role: 'owner',
    };
    if (!row.memory_owner_id) await provisionNewSpace(sql, journal, scope);
    return scope;
  };
}

/** Job workers derive ownership from durable catalog rows, never bundle metadata. */
function resolveJobScope(sql: MemorySql, journal: FileRestrictionJournal) {
  return async (jobId: string): Promise<MemoryScope> => {
    const [row] = await sql`select o.id as owner_id, s.id as space_id,
      m.owner_id as memory_owner_id, m.revoked
      from job j join space s on s.id = j.space_id cross join owner o
      left join memory_spaces m on m.space_id = s.id where j.id = ${jobId}`;
    if (!row || row.revoked || (row.memory_owner_id && row.memory_owner_id !== row.owner_id))
      throw new MemoryError('scope_denied');
    const scope: MemoryScope = {
      ownerId: row.owner_id,
      spaceId: row.space_id,
      publisher: 'job-worker',
      audience: 'private',
      role: 'owner',
    };
    if (!row.memory_owner_id) await provisionNewSpace(sql, journal, scope);
    return scope;
  };
}

/** Complete restore before callers start job workers or bind public listeners. */
export async function startDeploymentMemory(options: DeploymentMemoryOptions) {
  const journal = new FileRestrictionJournal(join(options.restrictionsDir, 'restrictions.jsonl'));
  await openJournal(options.sql, journal);
  await provisionCatalog(options.sql);
  let service: Awaited<ReturnType<typeof startMemoryService>> | undefined;
  if (options.workers === false) await restoreMemory(options.sql, journal);
  else service = await startMemoryService({ sql: options.sql, boss: options.boss, journal });
  const recompute = options.onJobRecompute
    ? startJobRecompute(options.sql, options.onJobRecompute)
    : undefined;
  const routes: MemoryRouteOptions = {
    sql: options.sql,
    journal,
    resolveScope: resolveOwnerScope(options.sql, journal),
  };
  return {
    routes,
    scopeForJob: resolveJobScope(options.sql, journal),
    close: async () => {
      await recompute?.stop();
      await service?.stop();
    },
  };
}
