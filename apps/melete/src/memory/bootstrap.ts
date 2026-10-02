import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { prefixedId } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { SESSION_COOKIE } from '../api/auth.ts';
import { type CaptureOptions, startChatCapture } from './capture.ts';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import type { ExtractionGateway } from './extract.ts';
import { applyRestriction } from './forget.ts';
import { lockEventOrder } from './invalidate.ts';
import { MarkdownViews } from './markdown.ts';
import { startJobRecompute } from './recompute.ts';
import { FileRestrictionJournal, restoreMemory } from './restore.ts';
import type { MemoryRouteOptions } from './routes.ts';
import { startMemoryService } from './service.ts';

type DeploymentMemoryOptions = {
  sql: MemorySql;
  boss: PgBoss;
  /** Retain this directory independently of Postgres backups. */
  restrictionsDir: string;
  /**
   * The spaces' git repositories, where memory is written out as knowledge
   * files and the review queue reads its proposals. Left out, neither runs.
   */
  spacesDir?: string;
  workers?: boolean;
  /** Wakes a job memory invalidated; left out, invalidations wait for the runner's scan. */
  onJobRecompute?: (jobId: string) => Promise<void>;
  /** Reads what people say in chat; without one, structured observations only. */
  gateway?: ExtractionGateway;
  /** Why a chat message is private, recorded on what memory learns from it. */
  privacyOrigin: CaptureOptions['privacyOrigin'];
  /** Why a message said in a room is private; left out, nothing said in a room is kept. */
  roomPrivacyOrigin?: CaptureOptions['roomPrivacyOrigin'];
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
      m.owner_id as memory_owner_id, m.revoked,
      s.id = auth.space_id as session_space,
      s.kind = 'personal' and coalesce(s.owner_principal_id, o.id) = coalesce(auth.principal_id, o.id) as personal
      from session auth join owner o on o.id = auth.owner_id cross join space s
      left join memory_spaces m on m.space_id = s.id
      where auth.token_hash = ${hash} and auth.expires_at > clock_timestamp()
        and (${selected}::text is null or s.id = ${selected})
      order by s.id limit 500`;
    // A selected space is used as selected. Without one, memory follows the rest
    // of the API: the session's space, else the person's personal space.
    const personal = rows.filter((r) => r.personal);
    const row =
      rows.length <= 1
        ? rows[0]
        : (rows.find((r) => r.session_space) ?? (personal.length === 1 ? personal[0] : undefined));
    if (!row) {
      if (rows.length > 1) throw new MemoryError('space_required');
      return null;
    }
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

/**
 * Job workers derive ownership from durable catalog rows, never bundle metadata.
 * The job's principal is the reader: the space's owner reads its private
 * memory, and a member of a shared space reads what the space shares, fenced by
 * their current membership generation. A job that names no principal
 * predates principals and belongs to the setup owner.
 */
function resolveJobScope(sql: MemorySql, journal: FileRestrictionJournal) {
  return async (jobId: string): Promise<MemoryScope> => {
    const [row] = await sql`select o.id as owner_id, s.id as space_id, s.kind,
      coalesce(s.owner_principal_id, o.id) as space_owner_id,
      coalesce(j.principal_id, o.id) as principal_id,
      ms.role as membership_role, ms.generation as membership_generation,
      m.owner_id as memory_owner_id, m.revoked
      from job j join space s on s.id = j.space_id cross join owner o
      left join space_membership ms on ms.space_id = s.id
        and ms.principal_id = coalesce(j.principal_id, o.id) and ms.revoked_at is null
      left join memory_spaces m on m.space_id = s.id where j.id = ${jobId}`;
    if (!row || row.revoked || (row.memory_owner_id && row.memory_owner_id !== row.owner_id))
      throw new MemoryError('scope_denied');
    const isOwner = row.space_owner_id === row.principal_id;
    if (row.kind === 'personal' ? !isOwner : !row.membership_role)
      throw new MemoryError('scope_denied');
    const scope: MemoryScope = {
      ownerId: row.owner_id,
      principalId: row.principal_id,
      membershipGeneration: Number(row.membership_generation ?? 0),
      spaceId: row.space_id,
      publisher: 'job-worker',
      audience: isOwner ? 'private' : 'space',
      role: isOwner ? 'owner' : 'reader',
    };
    if (!row.memory_owner_id) await provisionNewSpace(sql, journal, scope);
    return scope;
  };
}

/**
 * A space's memory as the service itself holds it, provisioned the first time
 * it is used: room memory is written, and a shared detail read, through it.
 */
function resolveStorageScope(sql: MemorySql, journal: FileRestrictionJournal) {
  return async (spaceId: string): Promise<MemoryScope> => {
    const [row] = await sql`select s.kind, s.removed_at, o.id as owner_id,
      m.owner_id as memory_owner_id, m.revoked
      from space s cross join owner o left join memory_spaces m on m.space_id = s.id
      where s.id = ${spaceId}`;
    if (
      !row ||
      row.removed_at ||
      row.revoked ||
      (row.memory_owner_id && row.memory_owner_id !== row.owner_id)
    )
      throw new MemoryError('scope_denied');
    const scope: MemoryScope = {
      ownerId: row.owner_id,
      spaceId,
      publisher: 'service',
      audience: row.kind === 'personal' ? 'private' : 'space',
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
  const scopeForJob = resolveJobScope(options.sql, journal);
  const storageScope = resolveStorageScope(options.sql, journal);
  let stopCapture: (() => Promise<void>) | undefined;
  const markdown = options.spacesDir
    ? new MarkdownViews(options.sql, options.spacesDir, { name: 'Owner', email: 'owner@localhost' })
    : undefined;
  if (options.workers === false) await restoreMemory(options.sql, journal);
  else {
    const onError = (code: string) => process.stderr.write(`memory: ${code}\n`);
    service = await startMemoryService({
      sql: options.sql,
      boss: options.boss,
      journal,
      markdown,
      gateway: options.gateway,
      onError,
    });
    // What a person says in chat is offered to their memory with no step of theirs.
    stopCapture = startChatCapture({
      sql: options.sql,
      boss: options.boss,
      journal,
      privacyOrigin: options.privacyOrigin,
      scopeForJob,
      onError,
      ...(options.roomPrivacyOrigin
        ? { roomScope: storageScope, roomPrivacyOrigin: options.roomPrivacyOrigin }
        : {}),
    });
  }
  const recompute = options.onJobRecompute
    ? startJobRecompute(options.sql, options.onJobRecompute)
    : undefined;
  const routes: MemoryRouteOptions = {
    sql: options.sql,
    journal,
    markdown,
    // The installation owner holds every space's memory on this path; the
    // space's own person is who may have it provisioned.
    async provision(spaceId, principalId) {
      const [row] = await options.sql`select m.owner_id as memory_owner_id,
          coalesce(s.owner_principal_id, o.id) as space_owner_id
        from space s cross join owner o left join memory_spaces m on m.space_id = s.id
        where s.id = ${spaceId}`;
      if (!row || row.space_owner_id !== principalId || row.memory_owner_id) return;
      await storageScope(spaceId);
    },
    resolveScope: resolveOwnerScope(options.sql, journal),
    storageScope,
  };
  return {
    routes,
    scopeForJob,
    close: async () => {
      await recompute?.stop();
      await stopCapture?.();
      await service?.stop();
    },
  };
}
