import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  type ExtractionProposal,
  memoryKnowledgeFrontmatter,
  ownerKnowledgeEdit,
} from '@melete/contracts';
import {
  ProposalStore,
  parseRecord,
  SpaceIndex,
  serializeRecord,
  spacePaths,
} from '@melete/knowledge';
import { type ClaimHead, correctClaim, eligibleRevision, getHead } from './claims.ts';
import { commitExtraction } from './commit.ts';
import {
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  stableEntityId,
  stableId,
} from './db.ts';
import { type ExtractionBatch, finishWork } from './work.ts';

const exec = promisify(execFile);
const identity = [
  '-c',
  'user.name=ychampion',
  '-c',
  'user.email=68075205+ychampion@users.noreply.github.com',
];
const pathFor = (id: string) => `knowledge/${id}.md`;
type ReviewPayload = { batch: ExtractionBatch; proposals: ExtractionProposal[] };

/** Legacy day-level fields coexist with the exact revision and source-version mapping. */
export function claimFrontmatter(head: ClaimHead) {
  const revision = head.current;
  const day = (value: string) => value.slice(0, 10);
  return memoryKnowledgeFrontmatter.parse({
    id: head.id,
    title: head.domain_key.slice(0, 200),
    space: head.space_id,
    audience: head.audience,
    type: revision.kind === 'preference' ? 'preference' : 'fact',
    status: revision.status === 'historical' ? 'superseded' : revision.status,
    confidence: 'low',
    asserted_by: ['user_statement', 'preference', 'exception'].includes(revision.kind)
      ? 'user'
      : revision.kind === 'document_assertion'
        ? 'document'
        : revision.kind === 'checked_fact'
          ? 'tool'
          : 'agent',
    source: {
      kind: 'statement',
      ref: revision.sources
        .map((s) => `${s.source_id}@${s.source_version}:${s.start}-${s.end}`)
        .join(', '),
      quote: '',
      sha256: null,
    },
    observed_at: day(revision.recorded_at),
    valid_from: day(revision.valid_from),
    valid_until: revision.valid_until ? day(revision.valid_until) : null,
    supersedes: [],
    superseded_by: null,
    created: day(revision.recorded_at),
    updated: day(revision.recorded_at),
    tags: [revision.kind, revision.factual_status, 'memory-view'],
    links: [],
    schema_version: 1,
    memory_revision: revision.revision,
    recorded_at: revision.recorded_at,
    exact_valid_from: revision.valid_from,
    exact_valid_until: revision.valid_until,
    superseded_at: revision.superseded_at,
    source_refs: revision.sources,
    supersedes_revisions: Array.from({ length: revision.revision - 1 }, (_, index) => index + 1),
  });
}

/** Only server-configured roots and server-derived space/claim IDs can name files. */
export class MarkdownViews {
  constructor(
    readonly sql: MemorySql,
    readonly spacesRoot: string,
  ) {}

  private async paths(spaceId: string) {
    if (!/^sp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(spaceId)) throw new MemoryError('scope_denied');
    const paths = spacePaths(resolve(this.spacesRoot), spaceId);
    for (const path of [
      paths.root,
      join(paths.root, '.git'),
      paths.knowledge,
      paths.proposed,
      paths.indexDb,
    ]) {
      const back = relative(resolve(this.spacesRoot), resolve(path));
      if (back.startsWith('..') || back === '') throw new MemoryError('unsafe_view_path');
      let cursor = resolve(this.spacesRoot);
      await this.rejectLink(cursor);
      for (const segment of back.split(sep)) {
        cursor = join(cursor, segment);
        await this.rejectLink(cursor);
      }
    }
    const gitRoot = (await this.git(paths.root, ['rev-parse', '--show-toplevel'])).trim();
    if (resolve(gitRoot).toLowerCase() !== resolve(paths.root).toLowerCase())
      throw new MemoryError('unsafe_view_repository');
    return paths;
  }
  private async rejectLink(path: string) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat?.isSymbolicLink()) throw new MemoryError('unsafe_view_path');
  }
  private async git(root: string, args: string[]) {
    return (await exec('git', ['-C', root, ...args], { timeout: 15000, windowsHide: true })).stdout;
  }
  private async commitFiles(root: string, paths: string[], message: string) {
    if (!paths.length) return;
    await this.git(root, ['add', '--', ...paths]);
    if (!(await this.git(root, ['diff', '--cached', '--name-only', '--', ...paths])).trim()) return;
    // --only preserves unrelated staged work in an owner's space repository.
    await this.git(root, [
      ...identity,
      'commit',
      '--only',
      '-m',
      `${message}\n\nMelete-Proposed-By: view-builder`,
      '--',
      ...paths,
    ]);
  }

  async build(scope: MemoryScope) {
    const paths = await this.paths(scope.spaceId);
    return this.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const rows =
        await tx`select id from memory_claims where space_id = ${scope.spaceId} and not hidden order by id`;
      const changed: string[] = [];
      await mkdir(paths.knowledge, { recursive: true });
      for (const row of rows) {
        const head = await getHead(tx, scope, row.id);
        if (
          !head ||
          !['active', 'disputed'].includes(head.current.status) ||
          !(await eligibleRevision(tx, scope, head.id, head.head_revision))
        )
          continue;
        const path = pathFor(head.id);
        const absolute = join(paths.root, path);
        await this.rejectLink(absolute);
        const content = serializeRecord(claimFrontmatter(head), head.current.content ?? '');
        const previous = await readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (previous !== null && previous !== content) {
          const [known] =
            await tx`select output_version from memory_derivations where space_id = ${scope.spaceId} and output_kind = 'markdown' and output_id = ${path} order by input_version::int desc limit 1`;
          if (!known || known.output_version !== stableId(previous))
            throw new MemoryError('owner_edit_pending');
        }
        if (previous !== content) {
          const temporary = `${absolute}.tmp`;
          await this.rejectLink(temporary);
          await writeFile(temporary, content, { flag: 'w', mode: 0o600 });
          await rename(temporary, absolute);
        }
        changed.push(path);
        await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
          values (${scope.spaceId}, 'claim', ${head.id}, ${String(head.head_revision)}, 'markdown', ${path}, ${stableId(content)}) on conflict do nothing`;
      }
      await this.commitFiles(paths.root, changed, 'Refresh memory inspection records');
      await tx`update memory_outbox set completed_at = clock_timestamp() where space_id = ${scope.spaceId} and kind = 'markdown' and completed_at is null`;
      return changed.length;
    });
  }

  async edit(scope: MemoryScope, id: string, raw: unknown) {
    const input = ownerKnowledgeEdit.parse(raw);
    if (input.frontmatter.id !== id || input.frontmatter.space !== scope.spaceId)
      throw new MemoryError('scope_denied');
    const head = await this.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return getHead(tx, scope, id);
    });
    if (!head) throw new MemoryError('claim_not_found');
    if (input.frontmatter.audience !== head.audience || input.frontmatter.status !== 'active')
      throw new MemoryError('scope_denied');
    const revision = await correctClaim(
      this.sql,
      scope,
      {
        claim_id: id,
        expected_revision: input.expected_revision,
        content: input.body,
        text: input.body,
        valid_from: `${input.frontmatter.valid_from}T00:00:00Z`,
        valid_until: input.frontmatter.valid_until
          ? `${input.frontmatter.valid_until}T00:00:00Z`
          : null,
        idempotency_key: input.idempotency_key,
      },
      true,
    );
    const paths = await this.paths(scope.spaceId);
    const path = pathFor(id);
    await this.rejectLink(join(paths.root, path));
    const file = await readFile(join(paths.root, path), 'utf8').catch(() => null);
    const parsed = file === null ? null : parseRecord(file);
    if (
      file !== null &&
      parsed?.ok &&
      parsed.record.body === input.body.trim() &&
      parsed.record.frontmatter.id === id &&
      parsed.record.frontmatter.space === scope.spaceId
    ) {
      // Only the file body explicitly submitted by the owner may replace an unimported edit.
      await this
        .sql`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'claim', ${id}, ${String(revision.revision)}, 'markdown', ${path}, ${stableId(file)}) on conflict do nothing`;
    }
    return revision;
  }

  async proposals(scope: MemoryScope) {
    const paths = await this.paths(scope.spaceId);
    return this.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const rows =
        await tx`select id, payload, created_at from memory_proposals where space_id = ${scope.spaceId} and status = 'pending' order by created_at limit 100`;
      const proposals = [];
      for (const row of rows) {
        const payload = row.payload as ReviewPayload;
        const store = new ProposalStore({
          paths,
          spacesRoot: resolve(this.spacesRoot),
          knownIds: new Set(payload.batch.claims.map((c) => c.id)),
          now: () => new Date(row.created_at),
        });
        const diffs: string[] = [];
        const files: string[] = [];
        for (const proposal of payload.proposals) {
          if (proposal.op === 'no-op') continue;
          const old =
            proposal.op === 'add'
              ? null
              : payload.batch.claims.find((c) => c.id === proposal.claim_id);
          const id =
            proposal.op === 'add'
              ? stableEntityId('k', payload.batch.work.id, proposal.domain_key)
              : proposal.claim_id;
          const current =
            proposal.op === 'retract'
              ? old?.current
              : {
                  ...proposal,
                  claim_id: id,
                  revision: (proposal.expected_revision ?? 0) + 1,
                  status: 'active' as const,
                  protected: false,
                  data_revision: payload.batch.snapshot.data_revision + 1,
                  recorded_at: new Date(row.created_at).toISOString(),
                  superseded_at: null,
                };
          if (!current) throw new MemoryError('invalid_proposal');
          const head: ClaimHead = {
            id,
            space_id: scope.spaceId,
            domain_key: proposal.op === 'retract' ? (old?.domain_key ?? '') : proposal.domain_key,
            audience: payload.batch.source.audience,
            head_revision: current.revision,
            hidden: false,
            current: {
              ...current,
              status: proposal.op === 'retract' ? 'retracted' : 'active',
              sources: current.sources.map(({ source_id, source_version, start, end }) => ({
                source_id,
                source_version,
                start,
                end,
              })),
            },
          };
          const path = pathFor(id);
          await this.rejectLink(join(paths.root, path));
          const staged = store.propose({
            space: scope.spaceId,
            path,
            frontmatter: claimFrontmatter(head),
            body: current.content ?? '',
            rationale: `Pending memory work ${row.id}; publication revalidates its evidence and revisions.`,
          });
          if (!staged.ok) throw new MemoryError('invalid_view_proposal');
          files.push(path);
          diffs.push(staged.diff);
        }
        proposals.push({
          id: row.id as string,
          path: files.join(', '),
          diff: diffs.join('\n'),
          status: 'pending' as const,
        });
      }
      await tx`update memory_outbox set completed_at = clock_timestamp() where space_id = ${scope.spaceId} and kind = 'proposal' and completed_at is null`;
      return { proposals };
    });
  }

  async apply(scope: MemoryScope, id: string) {
    const payload = await this.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const [row] =
        await tx`select payload from memory_proposals where id = ${id} and space_id = ${scope.spaceId} and status = 'pending' for update`;
      if (!row?.payload) throw new MemoryError('proposal_not_found');
      const value = row.payload as ReviewPayload;
      const [prior] =
        await tx`select status from memory_work where id = ${value.batch.work.id} and space_id = ${scope.spaceId} for update`;
      if (prior?.status === 'done') return value;
      const [work] =
        await tx`update memory_work set status = 'leased', fence = fence + 1, lease_until = clock_timestamp() + interval '30 seconds'
        where id = ${value.batch.work.id} and space_id = ${scope.spaceId} and status = 'review' returning fence, lease_until`;
      if (!work) throw new MemoryError('stale_revision');
      value.batch.work = {
        ...value.batch.work,
        status: 'leased',
        fence: work.fence,
        lease_until: new Date(work.lease_until).toISOString(),
      };
      return value;
    });
    const result = await commitExtraction(
      this.sql,
      scope,
      payload.batch,
      { proposals: payload.proposals },
      true,
    );
    await this
      .sql`update memory_proposals set status = ${result.status === 'committed' || result.status === 'duplicate' ? 'applied' : 'discarded'}, payload = null where id = ${id} and space_id = ${scope.spaceId}`;
    await this.removeProposalFiles(scope.spaceId);
    return result;
  }

  async discard(scope: MemoryScope, id: string) {
    await this.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const [row] =
        await tx`select payload from memory_proposals where id = ${id} and space_id = ${scope.spaceId} and status = 'pending' for update`;
      if (!row?.payload) throw new MemoryError('proposal_not_found');
      const [work] =
        await tx`select status, fence from memory_work where id = ${(row.payload as ReviewPayload).batch.work.id} and space_id = ${scope.spaceId} for update`;
      if (
        work?.status !== 'review' ||
        work.fence !== (row.payload as ReviewPayload).batch.work.fence
      )
        throw new MemoryError('stale_revision');
      await finishWork(tx, (row.payload as ReviewPayload).batch, 'rejected', 'owner_discarded');
      await tx`update memory_proposals set status = 'discarded', payload = null where id = ${id} and space_id = ${scope.spaceId}`;
    });
    await this.removeProposalFiles(scope.spaceId);
    return { id, status: 'discarded' as const };
  }

  private async removeProposalFiles(spaceId: string) {
    const paths = await this.paths(spaceId);
    const store = new ProposalStore({
      paths,
      spacesRoot: resolve(this.spacesRoot),
      knownIds: new Set(),
    });
    // These are disposable previews. Pending ones are reconstructed from their Postgres proposal.
    for (const proposal of store.list()) {
      if (!/^k_[0-7][0-9A-HJKMNP-TV-Z]{25}-\d+$/.test(proposal.id))
        throw new MemoryError('unsafe_view_path');
      if (proposal.rationale.startsWith('Pending memory work ')) store.discard(proposal.id);
    }
  }
  async cleanup(spaceId: string, claimIds: string[]) {
    const paths = await this.paths(spaceId);
    const removed: string[] = [];
    for (const id of claimIds) {
      if (!/^k_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)) throw new MemoryError('unsafe_view_path');
      const path = pathFor(id);
      await this.rejectLink(join(paths.root, path));
      await rm(join(paths.root, path), { force: true });
      const tracked = (await this.git(paths.root, ['ls-files', '--', path])).trim();
      if (tracked) removed.push(path);
    }
    if (await lstat(paths.indexDb).catch(() => null)) {
      const index = SpaceIndex.open(paths.indexDb);
      try {
        for (const id of claimIds) index.remove(id);
      } finally {
        index.close();
      }
    }
    await this.removeProposalFiles(spaceId);
    await this.commitFiles(paths.root, removed, 'Remove restricted memory inspection records');
  }
}
