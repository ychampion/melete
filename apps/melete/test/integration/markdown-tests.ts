import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  claimRevision,
  errorResponse,
  ingestSourceResponse,
  knowledgeProposalList,
  knowledgeProposalView,
  memoryKnowledgeFrontmatter,
  sourceEvidenceResponse,
} from '@melete/contracts';
import { parseRecord, serializeRecord } from '@melete/knowledge';
import { listClaims } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { type MemoryScope, newId } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { cleanupMemory } from '../../src/memory/forget.ts';
import { claimFrontmatter, MarkdownViews } from '../../src/memory/markdown.ts';
import { createMemoryRouter } from '../../src/memory/routes.ts';
import { claimWork } from '../../src/memory/work.ts';
import { tripProposal } from './fake-provider.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';

const exec = promisify(execFile);
const source = (identity = 'first', text = 'our trip is in July') => ({
  stream: 'chat',
  source_identity: identity,
  source_version: '1',
  source_type: 'message',
  event_at: '2026-07-01T00:00:00Z',
  text,
});
async function fixture(db: TestDatabase) {
  const scope = await createScope(db);
  const root = await mkdtemp(join(tmpdir(), 'melete-w7-spaces-'));
  const space = join(root, scope.spaceId);
  await mkdir(space);
  await exec('git', ['-C', space, 'init', '-b', 'memory-view'], { windowsHide: true });
  const journal = await createJournal();
  const markdown = new MarkdownViews(db.sql, root, {
    name: 'ychampion',
    email: '68075205+ychampion@users.noreply.github.com',
  });
  const readers = new Map<string, MemoryScope>([
    ['owner', scope],
    ['reader', { ...scope, role: 'reader' }],
  ]);
  const app = createMemoryRouter({
    sql: db.sql,
    journal: journal.journal,
    markdown,
    resolveScope: async (request) =>
      readers.get(request.headers.get('authorization') ?? '') ?? null,
  });
  const request = (path: string, method = 'GET', value?: unknown, auth = 'owner') =>
    app.request(path, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  return {
    scope,
    root,
    space,
    journal,
    markdown,
    request,
    readers,
    async close() {
      await journal.close();
      if (
        resolve(root).startsWith(
          `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}melete-w7-spaces-`,
        )
      )
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
async function extract(db: TestDatabase, scope: MemoryScope, identity = 'first') {
  await ingest(db.sql, scope, source(identity));
  const batch = await claimWork(db.sql, scope);
  if (!batch) throw new Error('missing work');
  return {
    batch,
    result: await commitExtraction(db.sql, scope, batch, { proposals: [tripProposal(batch)] }),
  };
}
export function registerMarkdownTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('memory inspection routes', () => {
    test('authenticated routes reject body scope, foreign claim IDs, and reader writes', async () => {
      if (!db) return;
      const f = await fixture(db);
      try {
        const unauthenticated = await f.request('/memory/claims', 'GET', undefined, '');
        expect(unauthenticated.status).toBe(401);
        expect(errorResponse.parse(await unauthenticated.json()).error.code).toBe(
          'unauthenticated',
        );
        expect((await f.request('/memory/forget', 'POST', {})).status).toBe(400);
        expect(
          (await f.request('/memory/sources', 'POST', source('oversized', 'x'.repeat(1048576))))
            .status,
        ).toBe(400);
        for (const key of ['space_id', 'owner_id', 'publisher', 'metadata', 'audience']) {
          expect(
            (await f.request('/memory/sources', 'POST', { ...source(key), [key]: newId('sp') }))
              .status,
          ).toBe(400);
        }
        expect(
          (await f.request('/memory/recall', 'POST', { query: 'trip', space_id: newId('sp') }))
            .status,
        ).toBe(400);
        expect((await f.request('/memory/sources', 'POST', source(), 'reader')).status).toBe(403);
        const admitted = await f.request('/memory/sources', 'POST', source());
        expect(admitted.status).toBe(201);
        const accepted = ingestSourceResponse.parse(await admitted.json());
        expect(accepted.committed_sequence).toBe(1);
        const support = await f.request(`/memory/sources/${accepted.source.source_id}`);
        expect(sourceEvidenceResponse.parse(await support.json()).text).toBe(source().text);
        expect(
          (
            await f.request(
              `/memory/sources/${accepted.source.source_id}`,
              'GET',
              undefined,
              'reader',
            )
          ).status,
        ).toBe(404);
        const batch = await claimWork(db.sql, f.scope);
        if (!batch) throw new Error('missing work');
        const published = await commitExtraction(db.sql, f.scope, batch, {
          proposals: [tripProposal(batch)],
        });
        const id = published.claim_ids[0];
        expect((await f.request(`/memory/claims/${id}/history`)).status).toBe(200);
        f.readers.set('foreign', await createScope(db));
        expect(
          (
            await f.request(
              `/memory/sources/${accepted.source.source_id}`,
              'GET',
              undefined,
              'foreign',
            )
          ).status,
        ).toBe(404);
        expect(
          (await f.request(`/memory/claims/${id}/history`, 'GET', undefined, 'foreign')).status,
        ).toBe(404);
        expect(
          (await f.request('/memory/forget', 'POST', { claim_id: id }, 'foreign')).status,
        ).toBe(404);
        expect((await f.request('/memory/forget', 'POST', { claim_id: id }, 'reader')).status).toBe(
          403,
        );
      } finally {
        await f.close();
      }
    });
    test('Markdown round trips support, preserves local edits, and owner edits become protected revisions', async () => {
      if (!db) return;
      const f = await fixture(db);
      try {
        const { result } = await extract(db, f.scope);
        const id = result.claim_ids[0];
        await f.markdown.build(f.scope);
        const path = join(f.space, 'knowledge', `${id}.md`);
        const original = await readFile(path, 'utf8');
        const parsed = parseRecord(original);
        if (!parsed.ok) throw new Error(parsed.issues.join(', '));
        const frontmatter = memoryKnowledgeFrontmatter.parse(parsed.record.frontmatter);
        expect(frontmatter.memory_revision).toBe(1);
        expect(frontmatter.source_refs).toHaveLength(1);
        expect(frontmatter.exact_valid_from).toBe('2026-07-01T00:00:00.000Z');
        expect((await exec('git', ['-C', f.space, 'log', '-1', '--format=%B'])).stdout).toContain(
          'Melete-Proposed-By: view-builder',
        );
        const before = (await exec('git', ['-C', f.space, 'rev-parse', 'HEAD'])).stdout;
        await f.markdown.build(f.scope);
        expect((await exec('git', ['-C', f.space, 'rev-parse', 'HEAD'])).stdout).toBe(before);
        await writeFile(path, serializeRecord(frontmatter, 'August'));
        expect(await f.markdown.build(f.scope).catch((error: Error) => error.message)).toBe(
          'owner_edit_pending',
        );
        expect((await listClaims(db.sql, f.scope)).claims[0]?.current.content).toBe('July');
        const edit = {
          frontmatter: { ...frontmatter, valid_from: '2026-08-01' },
          body: 'August',
          expected_revision: 1,
          idempotency_key: 'edit-1',
        };
        expect(
          (
            await f.request(`/knowledge/${id}/edit`, 'POST', {
              ...edit,
              frontmatter: { ...edit.frontmatter, space: newId('sp') },
            })
          ).status,
        ).toBe(403);
        const corrected = await f.request(`/knowledge/${id}/edit`, 'POST', edit);
        expect(corrected.status).toBe(200);
        expect(claimRevision.parse(await corrected.json()).protected).toBe(true);
        await f.markdown.build(f.scope);
        const next = parseRecord(await readFile(path, 'utf8'));
        if (!next.ok) throw new Error('bad projection');
        expect(next.record.body).toBe('August');
        expect(
          memoryKnowledgeFrontmatter.parse(next.record.frontmatter).supersedes_revisions,
        ).toEqual([1]);
        const [evidence] =
          await db.sql`select source_type from memory_sources where space_id = ${f.scope.spaceId} and source_identity = 'edit-1'`;
        expect(evidence?.source_type).toBe('owner_edit');
        await writeFile(join(f.space, 'personal.txt'), 'preserve this staged edit');
        await exec('git', ['-C', f.space, 'add', '--', 'personal.txt']);
        const forgotten = await f.request('/memory/forget', 'POST', { claim_id: id });
        expect(forgotten.status).toBe(200);
        await cleanupMemory(db.sql, f.scope.spaceId, (spaceId, ids) =>
          f.markdown.cleanup(spaceId, ids),
        );
        expect(await Bun.file(path).exists()).toBe(false);
        expect(
          (await exec('git', ['-C', f.space, 'diff', '--cached', '--name-only'])).stdout.trim(),
        ).toBe('personal.txt');
      } finally {
        await f.close();
      }
    });
    test('review mediation stages diffs and revalidates apply against authoritative evidence', async () => {
      if (!db) return;
      const f = await fixture(db);
      try {
        await db.sql`update memory_spaces set require_review = true where space_id = ${f.scope.spaceId}`;
        const first = await extract(db, f.scope);
        expect(first.result.status).toBe('review');
        expect((await listClaims(db.sql, f.scope)).claims).toHaveLength(0);
        const listing = await f.request('/knowledge/proposals');
        expect(listing.status).toBe(200);
        const pending = knowledgeProposalList.parse(await listing.json()).proposals[0];
        if (!pending) throw new Error('missing pending proposal');
        expect(pending.diff).toContain('+July');
        const staged = (await readdir(join(f.space, '.proposed')))[0];
        expect(staged).toBeDefined();
        const apply = await f.request(`/knowledge/proposals/${pending.id}/apply`, 'POST');
        expect(apply.status).toBe(200);
        expect(knowledgeProposalView.parse(await apply.json()).status).toBe('applied');
        const head = (await listClaims(db.sql, f.scope)).claims[0];
        if (!head) throw new Error('missing applied claim');
        expect(pending.path).toBe(`knowledge/${head.id}.md`);
        await f.markdown.build(f.scope);
        await extract(db, f.scope, 'second');
        const second = knowledgeProposalList.parse(
          await (await f.request('/knowledge/proposals')).json(),
        ).proposals[0];
        if (!second) throw new Error('missing second proposal');
        const frontmatter = claimFrontmatter(head);
        expect(
          (
            await f.request(`/knowledge/${head.id}/edit`, 'POST', {
              frontmatter,
              body: 'August',
              expected_revision: 1,
              idempotency_key: 'while-reviewing',
            })
          ).status,
        ).toBe(200);
        expect((await f.request(`/knowledge/proposals/${second.id}/apply`, 'POST')).status).toBe(
          409,
        );
        expect((await listClaims(db.sql, f.scope)).claims[0]?.current.content).toBe('August');
        const retry = await claimWork(db.sql, f.scope, { workId: second.id });
        if (!retry) throw new Error('missing retried review');
        expect(
          (await commitExtraction(db.sql, f.scope, retry, { proposals: [tripProposal(retry)] }))
            .status,
        ).toBe('review');
        expect((await f.request(`/knowledge/proposals/${second.id}`, 'DELETE')).status).toBe(200);
        expect(
          knowledgeProposalList.parse(await (await f.request('/knowledge/proposals')).json())
            .proposals,
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    });
    test('view paths reject directory links before any claim content is written', async () => {
      if (!db) return;
      const f = await fixture(db);
      try {
        await extract(db, f.scope);
        const outside = join(f.root, 'outside');
        await mkdir(outside);
        await symlink(
          outside,
          join(f.space, 'knowledge'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        expect(await f.markdown.build(f.scope).catch((error: Error) => error.message)).toBe(
          'unsafe_view_path',
        );
        expect(await readdir(outside)).toHaveLength(0);
      } finally {
        await f.close();
      }
    });
  });
}
