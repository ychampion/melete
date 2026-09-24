import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prefixedId } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { SESSION_COOKIE } from '../api/auth.ts';
import { startChatCapture } from './capture.ts';
import { MemoryError, type MemoryScope, type MemorySql, provisionMemorySpace } from './db.ts';
import type { ExtractionGateway } from './extract.ts';
import { applyRestriction } from './forget.ts';
import { lockEventOrder } from './invalidate.ts';
import { MarkdownViews } from './markdown.ts';
import { startJobRecompute } from './recompute.ts';
import { FileRestrictionJournal, type RestrictionJournal } from './restore.ts';
import { startMemoryService } from './service.ts';

/** New HTTP-created spaces need their own repository before views can commit. */
async function prepareSpaceRepository(spacesRoot: string, spaceId: string) {
  prefixedId('sp').parse(spaceId);
  await mkdir(spacesRoot, { recursive: true });
  const root = await realpath(spacesRoot);
  const directory = join(root, spaceId);
  let initialized = false;
  for (const path of [directory, join(directory, '.git')]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new MemoryError('unsafe_view_path');
    if (path === join(directory, '.git') && stat) initialized = true;
  }
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== resolve(directory)) throw new MemoryError('unsafe_view_path');
  if (initialized) return;
  await promisify(execFile)(
    'git',
    ['-C', directory, '-c', 'init.defaultBranch=memory', 'init', '--quiet'],
    {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
}

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
  automatic: { gateway?: ExtractionGateway; captureChat?: boolean } = {},
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

  async function scopeForSpace(principalId: string, spaceId: string): Promise<MemoryScope> {
    const [authorized] = await sql`select s.kind,
      coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id,
      m.role, m.generation from space s left join space_membership m
      on m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null
      where s.id = ${spaceId}`;
    const isOwner = authorized?.owner_id === principalId;
    if (!authorized || (authorized.kind === 'personal' ? !isOwner : !authorized.role))
      throw new MemoryError('scope_denied');
    const ownerId = authorized.owner_id as string;
    await prepareSpaceRepository(spacesRoot, spaceId);
    // The storage owner is not the reader. Retaining the reader's identity and
    // membership generation lets every memory transaction fence later revocation.
    const scope: MemoryScope = {
      ownerId,
      principalId,
      membershipGeneration: Number(authorized.generation ?? 0),
      spaceId,
      publisher: 'authenticated-principal',
      audience: isOwner ? 'private' : 'space',
      role: isOwner ? 'owner' : 'reader',
    };
    const [known] = await sql`select space_id from memory_spaces where space_id = ${spaceId}`;
    if (!known) {
      await provisionMemorySpace(sql, ownerId, spaceId);
      await replayForNewMemory(sql, journal, ownerId, spaceId);
    }
    return scope;
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
    ? startChatCapture({ sql, boss, journal, scopeForJob, onError })
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
