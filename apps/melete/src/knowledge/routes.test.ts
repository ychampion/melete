import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOpenApiDocument,
  type KnowledgeFrontmatter,
  knowledgeRecordResponse,
  knowledgeSearchResponse,
  proposeKnowledgeResponse,
  skillListResponse,
} from '@melete/contracts';
import { commitRecord, initSpace, type SpacePaths, serializeRecord } from '@melete/knowledge';
import { loadEnv } from '../env.ts';
import { createApp, VERSION } from '../index.ts';
import { knowledgeRoutes, SPACE_HEADER } from './routes.ts';
import { filesystemSpaces, spaceIdFor } from './spaces.ts';

const ID = {
  bun: 'k_01J8ZP3QWABCDEFGHJKMNPQRST',
  landlord: 'k_01J8ZP3QWABCDEFGHJKMNPQRSW',
  fresh: 'k_01J8ZP3QWABCDEFGHJKMNPQRSX',
};

const record = (over: Partial<KnowledgeFrontmatter> = {}): KnowledgeFrontmatter => ({
  id: ID.bun,
  title: 'Prefers bun over npm for all package management',
  space: 'personal',
  audience: 'private',
  type: 'preference',
  status: 'active',
  confidence: 'high',
  asserted_by: 'user',
  source: { kind: 'statement', ref: 'session:1', quote: 'always use bun', sha256: null },
  observed_at: '2026-09-10',
  valid_from: '2026-07-10',
  valid_until: null,
  supersedes: [],
  superseded_by: null,
  created: '2026-09-10',
  updated: '2026-09-10',
  tags: ['tooling'],
  links: [],
  schema_version: 1,
  ...over,
});

/** What the tests read out of a response, stated once rather than at each site. */
type ErrorBody = { error: { code: string; detail: { findings: Array<{ check: string }> } } };
type HitsBody = { hits: Array<{ id: string }> };
type RecordBody = { id: string; frontmatter: { status: string }; body: string };
type StagedBody = { proposal_id: string; diff: string };
type HealthBody = { version: string };

let root: string;
let paths: SpacePaths;
let spaceId: string;

const app = () => knowledgeRoutes({ spaces: filesystemSpaces(root) });
const headers = () => ({ [SPACE_HEADER]: spaceId, 'content-type': 'application/json' });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-api-'));
  paths = await initSpace(root, 'personal');
  spaceId = spaceIdFor('personal');

  await commitRecord(
    paths,
    'knowledge/prefers-bun.md',
    serializeRecord(record(), 'Zara uses bun for every package operation.'),
    { proposedBy: 'user' },
  );
  await commitRecord(
    paths,
    'knowledge/landlord-contact.md',
    serializeRecord(
      record({ id: ID.landlord, title: 'Landlord contact', type: 'fact', tags: ['housing'] }),
      'The lease renews in March.',
    ),
    { proposedBy: 'user' },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// the contract
// --------------------------------------------------------------------------

/** Hono names a parameter `:id`; OpenAPI names it `{id}`. */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';

/**
 * Routes this module serves that the OpenAPI document does not describe yet.
 * Each one is a contract change proposed in
 * .agents/notes/proposed/2026-09-11-knowledge-api-gaps.md, not an accident.
 */
const PENDING_CONTRACT = new Set([
  'GET /knowledge',
  'GET /knowledge/proposals',
  'POST /knowledge/proposals/{proposalId}/apply',
]);

const declaredOperations = (): Set<string> => {
  const document = buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { tags?: string[] }>>;
  };
  const wanted = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const tags = operation.tags ?? [];
      if (tags.includes('knowledge') || tags.includes('skills')) {
        wanted.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return wanted;
};

const servedOperations = (): Set<string> =>
  new Set(
    app()
      .routes.filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${toOpenApiPath(r.path)}`),
  );

describe('the routes and the OpenAPI document agree', () => {
  test('every knowledge and skills operation in the document is served', () => {
    const served = servedOperations();
    const missing = [...declaredOperations()].filter((operation) => !served.has(operation));
    expect(missing).toEqual([]);
  });

  test('every route served is either in the document or a proposed addition', () => {
    const declared = declaredOperations();
    const undeclared = [...servedOperations()].filter(
      (operation) => !declared.has(operation) && !PENDING_CONTRACT.has(operation),
    );
    expect(undeclared).toEqual([]);
  });

  test('a search response is the shape the document promises', async () => {
    const res = await app().request(`/knowledge/search?space_id=${spaceId}&q=bun`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    expect(knowledgeSearchResponse.safeParse(await res.json()).success).toBe(true);
  });

  test('a record response is the shape the document promises', async () => {
    const res = await app().request(`/knowledge/${ID.bun}`, { headers: headers() });
    expect(res.status).toBe(200);
    expect(knowledgeRecordResponse.safeParse(await res.json()).success).toBe(true);
  });

  test('a skills response is the shape the document promises', async () => {
    const res = await app().request('/skills', { headers: headers() });
    expect(res.status).toBe(200);
    expect(skillListResponse.safeParse(await res.json()).success).toBe(true);
  });
});

// --------------------------------------------------------------------------
// isolation
// --------------------------------------------------------------------------

describe('a request is bound to one space', () => {
  test('with no space at all, nothing is served', async () => {
    const res = await app().request(`/knowledge/search?space_id=${spaceId}&q=bun`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe('no_space');
  });

  test('a space id that names nothing is a 404, not an empty result', async () => {
    const res = await app().request(`/knowledge/search?space_id=${spaceId}&q=bun`, {
      headers: { [SPACE_HEADER]: 'sp_01J8ZP3QWABCDEFGHJKMNPQRST' },
    });
    expect(res.status).toBe(404);
  });

  test('asking for a different space than the session holds is refused', async () => {
    const res = await app().request(
      '/knowledge/search?space_id=sp_01J8ZP3QWABCDEFGHJKMNPQRST&q=bun',
      { headers: headers() },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe('wrong_space');
  });

  test('a proposal naming a different space is refused', async () => {
    const res = await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        space: 'team-acme',
        path: 'knowledge/x.md',
        frontmatter: record({ id: ID.fresh, space: 'team-acme' }),
        body: 'x',
        rationale: 'x',
      }),
    });
    expect(res.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// reading
// --------------------------------------------------------------------------

describe('reading a space', () => {
  test('search finds a record by a word from its body', async () => {
    const res = await app().request(`/knowledge/search?space_id=${spaceId}&q=lease`, {
      headers: headers(),
    });
    const body = (await res.json()) as HitsBody;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]?.id).toBe(ID.landlord);
  });

  test('listing gives one line per record', async () => {
    const res = await app().request('/knowledge', { headers: headers() });
    const body = (await res.json()) as { records: Array<{ id: string }> };
    expect(body.records.map((r) => r.id).sort()).toEqual([ID.bun, ID.landlord].sort());
  });

  test('a record edited on disk is what a search returns', async () => {
    // The files are the system of record and a person edits them directly, so
    // the search has to answer from what is on disk rather than from whatever
    // the index last happened to hold.
    await app().request(`/knowledge/search?space_id=${spaceId}&q=lease`, { headers: headers() });

    writeFileSync(
      join(paths.knowledge, 'landlord-contact.md'),
      serializeRecord(
        record({ id: ID.landlord, title: 'Landlord contact', type: 'fact' }),
        'The lease renews in September now, and the agency handles it.',
      ),
      'utf8',
    );

    const res = await app().request(`/knowledge/search?space_id=${spaceId}&q=September`, {
      headers: headers(),
    });
    const body = (await res.json()) as HitsBody;
    expect(body.hits[0]?.id).toBe(ID.landlord);
  });

  test('a record that is not there is a 404', async () => {
    const res = await app().request('/knowledge/k_01J8ZP3QWZZZZZZZZZZZZZZZZZ', {
      headers: headers(),
    });
    expect(res.status).toBe(404);
  });

  test('skills list the built-ins and the space has none of its own', async () => {
    const res = await app().request('/skills', { headers: headers() });
    const body = (await res.json()) as { skills: Array<{ space_id: string | null }> };
    expect(body.skills).toHaveLength(6);
    expect(body.skills.every((s) => s.space_id === null)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// writing
// --------------------------------------------------------------------------

describe('proposing and applying a write', () => {
  const proposal = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      space: 'personal',
      path: 'knowledge/prefers-morning-flights.md',
      frontmatter: record({ id: ID.fresh, title: 'Prefers morning flights', tags: ['travel'] }),
      body: 'Books departures before eleven.',
      rationale: 'The owner said so while booking.',
      ...over,
    });

  test('a proposal is staged and diffed, and the space is untouched', async () => {
    const res = await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: proposal(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as StagedBody;
    expect(proposeKnowledgeResponse.safeParse(body).success).toBe(true);
    expect(body.diff).toContain('+Books departures before eleven.');
    expect(existsSync(join(paths.knowledge, 'prefers-morning-flights.md'))).toBe(false);
  });

  test('a proposal that fails lint says which check failed', async () => {
    const res = await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: proposal({ path: '../leak.md' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('lint_failed');
    expect(body.error.detail.findings[0]?.check).toBe('path-inside-space');
  });

  test('staged proposals are listed with whether they need a person', async () => {
    await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: proposal(),
    });
    const res = await app().request('/knowledge/proposals', { headers: headers() });
    const body = (await res.json()) as { proposals: Array<{ requires_approval: boolean }> };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]?.requires_approval).toBe(false);
  });

  test('applying commits it and it becomes searchable', async () => {
    const staged = (await (
      await app().request('/knowledge/proposals', {
        method: 'POST',
        headers: headers(),
        body: proposal(),
      })
    ).json()) as StagedBody;

    const applied = await app().request(`/knowledge/proposals/${staged.proposal_id}/apply`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ approved_by: 'zara' }),
    });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);

    const found = (await (
      await app().request(`/knowledge/search?space_id=${spaceId}&q=departures`, {
        headers: headers(),
      })
    ).json()) as HitsBody;
    expect(found.hits[0]?.id).toBe(ID.fresh);
  });

  test('a type the space does not auto-apply needs a named person', async () => {
    const staged = (await (
      await app().request('/knowledge/proposals', {
        method: 'POST',
        headers: headers(),
        body: proposal({ frontmatter: record({ id: ID.fresh, type: 'decision' }) }),
      })
    ).json()) as StagedBody;

    const applied = await app().request(`/knowledge/proposals/${staged.proposal_id}/apply`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });
    expect(applied.status).toBe(409);
    expect(((await applied.json()) as ErrorBody).error.code).toBe('approval_required');
  });

  test('applying a proposal that is not staged is a 404', async () => {
    const res = await app().request('/knowledge/proposals/prop_nothing/apply', {
      method: 'POST',
      headers: headers(),
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------
// taking it back
// --------------------------------------------------------------------------

describe('retracting and deleting', () => {
  const remove = (id: string, body: Record<string, unknown>) =>
    app().request(`/knowledge/${id}`, {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify(body),
    });

  test('a retracted record keeps its text and leaves retrieval', async () => {
    const res = await remove(ID.landlord, { reason: 'the lease was renewed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecordBody;
    expect(body.frontmatter.status).toBe('retracted');
    expect(body.body).toContain('the lease was renewed');

    const found = (await (
      await app().request(`/knowledge/search?space_id=${spaceId}&q=lease`, { headers: headers() })
    ).json()) as HitsBody;
    expect(found.hits).toEqual([]);
  });

  test('the owner can still see a retracted record when they ask for it', async () => {
    await remove(ID.landlord, { reason: 'the lease was renewed' });
    const found = (await (
      await app().request(`/knowledge/search?space_id=${spaceId}&q=lease&include_retracted=true`, {
        headers: headers(),
      })
    ).json()) as HitsBody;
    expect(found.hits.map((h) => h.id)).toContain(ID.landlord);
  });

  test('a hard delete removes the file and returns what was deleted', async () => {
    const res = await remove(ID.landlord, { reason: 'gone please', hard_delete: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RecordBody).id).toBe(ID.landlord);
    expect(existsSync(join(paths.knowledge, 'landlord-contact.md'))).toBe(false);
  });

  test('a retraction with no reason is refused', async () => {
    const res = await remove(ID.landlord, {});
    expect(res.status).toBe(400);
  });

  test('retracting twice says so rather than pretending', async () => {
    await remove(ID.landlord, { reason: 'the lease was renewed' });
    const res = await remove(ID.landlord, { reason: 'again' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe('cannot_retract');
  });
});

// --------------------------------------------------------------------------
// the service as a whole
// --------------------------------------------------------------------------

describe('the knowledge module inside the service', () => {
  test('health still answers, and the knowledge routes are mounted', async () => {
    const service = createApp({
      env: loadEnv({ MELETE_SPACES_DIR: root }),
      db: null,
      checkDatabase: async () => 'not_configured',
      knowledge: { spaces: filesystemSpaces(root) },
    });

    const health = await service.request('/health');
    expect(((await health.json()) as HealthBody).version).toBe(VERSION);

    const search = await service.request(`/knowledge/search?space_id=${spaceId}&q=bun`, {
      headers: headers(),
    });
    expect(search.status).toBe(200);
  });

  test('a module that is still a README says so instead of pretending', async () => {
    const service = createApp({
      env: loadEnv({ MELETE_SPACES_DIR: root }),
      db: null,
      checkDatabase: async () => 'not_configured',
    });
    const res = await service.request('/jobs');
    expect(res.status).toBe(404);
  });
});
