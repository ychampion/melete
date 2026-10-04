import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { prefixedId } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { SESSION_COOKIE } from '../api/auth.ts';
import { type CaptureOptions, startChatCapture } from './capture.ts';
import { MemoryError, type MemoryScope, type MemorySql, provisionMemorySpace } from './db.ts';
import type { ExtractionGateway } from './extract.ts';
import { applyRestriction } from './forget.ts';
import { lockEventOrder } from './invalidate.ts';
import { MarkdownViews, prepareSpaceRepository } from './markdown.ts';
import { startJobRecompute } from './recompute.ts';
import { FileRestrictionJournal, type RestrictionJournal } from './restore.ts';
import { startMemoryService } from './service.ts';

/** The retained restriction log is never silently recreated over existing memory. */
/**
 * A space's memory, provisioned for the first time, also crosses the restore
 * gate: a retained restriction on a restored space cannot disappear just
 * because its memory row was absent.
 */
export async function replayForNewMemory(
  sql: MemorySql,
  journal: RestrictionJournal,
  ownerId: string,
  spaceId: string,
) {
  const restrictions = await journal.read();
  await sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    for (const restriction of restrictions) {
      // A removal record is the startup replay's to act on, by the space's
      // epoch. Applied here, it would suppress memory made after it: an emptied
      // space provisions its memory afresh the first time it is used again.
      if (restriction.operation === 'remove_space') continue;
      if (restriction.owner_id === ownerId && restriction.space_id === spaceId)
        await applyRestriction(tx, restriction);
    }
    await tx`update memory_spaces set restore_ready = true where space_id = ${spaceId} and not revoked`;
  });
}

export async function startServiceMemory(
  sql: MemorySql,
  boss: PgBoss,
  spacesRoot: string,
  onJobRecompute?: (jobId: string) => Promise<void>,
  automatic:
    | { gateway?: ExtractionGateway; captureChat?: false }
    | {
        gateway?: ExtractionGateway;
        captureChat: true;
        /** Why a chat message is private, recorded on what memory learns from it. */
        privacyOrigin: CaptureOptions['privacyOrigin'];
        /** Why a message said in a room is private; left out, nothing said in a room is kept. */
        roomPrivacyOrigin?: CaptureOptions['roomPrivacyOrigin'];
      } = {},
) {
  const journal = new FileRestrictionJournal(join(spacesRoot, '.memory', 'restrictions.jsonl'));
  try {
    await access(journal.path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const [existing] = await sql`select space_id from memory_spaces limit 1`;
    if (existing)
      throw new Error(
        'The memory restriction journal is missing. Restore it before starting Melete.',
      );
    await journal.initializeNew();
  }
  const markdown = new MarkdownViews(sql, spacesRoot, {
    name: 'Owner',
    email: 'owner@localhost',
  });
  const existingSpaces = await sql`select space_id from memory_spaces where not revoked`;
  for (const row of existingSpaces)
    await prepareSpaceRepository(spacesRoot, row.space_id as string);
  const onError = (code: string) => process.stderr.write(`memory: ${code}\n`);
  const service = await startMemoryService({
    sql,
    boss,
    journal,
    markdown,
    gateway: automatic.gateway,
    onError,
  });
  const recompute = onJobRecompute ? startJobRecompute(sql, onJobRecompute) : undefined;

  /**
   * A space's memory as the service itself holds it, provisioned the first
   * time it is used: the installation owner stores every space's memory, as
   * the deployment path does, whoever the space belongs to. Room memory is
   * written, and a shared detail read, through it.
   */
  async function storageScope(spaceId: string): Promise<MemoryScope> {
    const [row] = await sql`select s.kind, s.removed_at, m.owner_id as memory_owner_id, m.revoked,
      (select id from owner limit 1) as installation_owner_id
      from space s left join memory_spaces m on m.space_id = s.id where s.id = ${spaceId}`;
    if (!row || row.removed_at || row.revoked) throw new MemoryError('scope_denied');
    const ownerId = (row.memory_owner_id ?? row.installation_owner_id) as string | null;
    if (!ownerId) throw new MemoryError('scope_denied');
    if (!row.memory_owner_id) {
      await prepareSpaceRepository(spacesRoot, spaceId);
      await provisionMemorySpace(sql, ownerId, spaceId);
      await replayForNewMemory(sql, journal, ownerId, spaceId);
    }
    return {
      ownerId,
      spaceId,
      publisher: 'service',
      audience: row.kind === 'personal' ? 'private' : 'space',
      role: 'owner',
    };
  }
  async function scopeForSpace(principalId: string, spaceId: string): Promise<MemoryScope> {
    const [authorized] = await sql`select s.kind,
      coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id,
      m.role, m.generation from space s left join space_membership m
      on m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null
        and m.role <> 'guest' and (m.expires_at is null or m.expires_at > now())
      where s.id = ${spaceId}`;
    const isOwner = authorized?.owner_id === principalId;
    if (!authorized || (authorized.kind === 'personal' ? !isOwner : !authorized.role))
      throw new MemoryError('scope_denied');
    await prepareSpaceRepository(spacesRoot, spaceId);
    // The storage owner is not the reader. Retaining the reader's identity and
    // membership generation lets every memory transaction fence later revocation.
    const stored = await storageScope(spaceId);
    return {
      ownerId: stored.ownerId,
      principalId,
      membershipGeneration: Number(authorized.generation ?? 0),
      spaceId,
      publisher: 'authenticated-principal',
      audience: isOwner ? 'private' : 'space',
      role: isOwner ? 'owner' : 'reader',
    };
  }
  async function scopeForJob(jobId: string): Promise<MemoryScope> {
    const [row] =
      await sql`select j.space_id, coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
        from job j where j.id = ${jobId}`;
    if (!row) throw new MemoryError('scope_denied');
    return scopeForSpace(row.principal_id as string, row.space_id as string);
  }
  // What a person says in chat is offered to their memory with no step of theirs.
  const stopCapture = automatic.captureChat
    ? startChatCapture({
        sql,
        boss,
        journal,
        scopeForJob,
        onError,
        privacyOrigin: automatic.privacyOrigin,
        ...(automatic.roomPrivacyOrigin
          ? { roomScope: storageScope, roomPrivacyOrigin: automatic.roomPrivacyOrigin }
          : {}),
      })
    : undefined;
  return {
    async stop() {
      await recompute?.stop();
      await stopCapture?.();
      await service.stop();
    },
    sql,
    journal,
    markdown,
    scopeForJob,
    storageScope,
    async provision(spaceId: string, principalId: string) {
      await scopeForSpace(principalId, spaceId);
    },
    async resolveScope(request: Request): Promise<MemoryScope | null> {
      const cookies = request.headers.get('cookie') ?? '';
      const token = cookies
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
        ?.slice(SESSION_COOKIE.length + 1);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const digest = createHash('sha256').update(token).digest('hex');
      const [authenticated] = await sql`select coalesce(principal_id, owner_id) as principal_id
          from session where token_hash = ${digest} and expires_at > now()`;
      if (!authenticated) return null;
      const requested = prefixedId('sp').safeParse(request.headers.get('x-melete-space'));
      if (!requested.success) throw new MemoryError('scope_denied');
      return scopeForSpace(authenticated.principal_id as string, requested.data);
    },
  };
}
