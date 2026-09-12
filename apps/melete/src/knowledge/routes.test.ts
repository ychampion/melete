import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  applyProposal,
  commitRecord,
  DEFAULT_POLICY,
  getProposal,
  initSpace,
  knownIds,
  listProposals,
  loadSpace,
  proposalType,
  requiresApproval,
  type SpacePaths,
  serializeRecord,
  spacePaths,
} from '@melete/knowledge';
import { testDatabase } from '../../test/helpers/database.ts';
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
let templateRoot: string;

const handle = await testDatabase();
const serviceTest = handle ? test : test.skip;
const database = () => {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
};

afterAll(async () => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
  await handle?.close();
}, 15_000);

const app = () => knowledgeRoutes({ spaces: filesystemSpaces(root) });
const headers = () => ({ [SPACE_HEADER]: spaceId, 'content-type': 'application/json' });

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), 'melete-api-template-'));
  const templatePaths = await initSpace(templateRoot, 'personal');
  spaceId = spaceIdFor('personal');

  await commitRecord(
    templatePaths,
    'knowledge/prefers-bun.md',
    serializeRecord(record(), 'Zara uses bun for every package operation.'),
    { proposedBy: 'user' },
  );
  await commitRecord(
    templatePaths,
    'knowledge/landlord-contact.md',
    serializeRecord(
      record({ id: ID.landlord, title: 'Landlord contact', type: 'fact', tags: ['housing'] }),
      'The lease renews in March.',
    ),
    { proposedBy: 'user' },
  );
}, 20_000);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melete-api-'));
  // A closed, genuinely committed seed preserves independent files and Git
  // history without rebuilding identical commits under every fixture hook.
  cpSync(templateRoot, root, { recursive: true });
  paths = spacePaths(root, 'personal');
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
 * Empty, and meant to stay that way. Listing a space and applying a proposal are
 * both in the document now, and the apply operation is served by the memory
 * module under the path the document declares. An entry here would mean a route
 * exists that nothing describes.
 */
const PENDING_CONTRACT = new Set<string>([]);

/**
 * Knowledge operations the document declares that the memory module serves,
 * not this one. W7 owns proposal apply, proposal removal, and owner edits of a
 * record; this module owns search, listing, reading and retraction.
 */
const SERVED_BY_MEMORY = new Set([
  'GET /knowledge/proposals',
  'POST /knowledge/proposals/{id}/apply',
  'DELETE /knowledge/proposals/{id}',
  'POST /knowledge/{recordId}/edit',
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
    const missing = [...declaredOperations()].filter(
      (operation) => !served.has(operation) && !SERVED_BY_MEMORY.has(operation),
    );
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

  test('skills with required tools are hidden when no tool catalog is configured', async () => {
    const res = await app().request('/skills', { headers: headers() });
    const body = (await res.json()) as { skills: Array<{ space_id: string | null }> };
    expect(body.skills).toEqual([]);
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

  // Listing and applying moved to the memory module, which owns the review
  // surface because the Postgres claim store is the authority for it. The
  // mediator they call is still this package's, so these exercise it directly.
  const mediation = () => ({
    paths,
    knownIds: knownIds(loadSpace(paths)),
    policy: DEFAULT_POLICY,
  });

  test('a staged proposal says whether the space policy needs a person', async () => {
    await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: proposal(),
    });
    const staged = listProposals(paths);
    expect(staged).toHaveLength(1);
    const preference = staged[0];
    if (!preference) throw new Error('nothing staged');
    expect(requiresApproval(DEFAULT_POLICY, proposalType(preference))).toBe(false);
    expect(requiresApproval(DEFAULT_POLICY, 'decision')).toBe(true);
  });

  test('applying commits it and it becomes searchable', async () => {
    await app().request('/knowledge/proposals', {
      method: 'POST',
      headers: headers(),
      body: proposal(),
    });
    const staged = listProposals(paths)[0];
    if (!staged) throw new Error('nothing staged');
    const applied = await applyProposal(mediation(), staged, { approvedBy: 'zara' });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.commit.sha).toMatch(/^[0-9a-f]{40}$/);

    const found = (await (
      await app().request(`/knowledge/search?space_id=${spaceId}&q=departures`, {
        headers: headers(),
      })
    ).json()) as HitsBody;
    expect(found.hits[0]?.id).toBe(ID.fresh);
  });

  test('a proposal id that is not staged resolves to nothing', () => {
    expect(getProposal(paths, 'prop_nothing')).toBeFalsy();
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
  }, 15_000);
});

// --------------------------------------------------------------------------
// the service as a whole
// --------------------------------------------------------------------------

describe('the knowledge module inside the service', () => {
  const service = () =>
    createApp({
      env: loadEnv({ MELETE_SPACES_DIR: root }),
      db: database().db,
      checkDatabase: async () => 'ok',
      knowledge: { spaces: filesystemSpaces(root) },
    });

  /**
   * W1 puts everything but /health and /setup|/login behind a single-owner
   * session. These tests ask what the service does for the owner, so they sign
   * in first rather than assert the gate, which auth.test.ts already covers.
   */
  async function signIn(api: ReturnType<typeof createApp>): Promise<string> {
    await database().sql`truncate "principal", "owner", "space" cascade`;
    const response = await api.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'my-test-password' }),
    });
    const value = response.headers.get('set-cookie')?.split(';')[0];
    if (!value) throw new Error(`setup issued no session cookie (${response.status})`);
    await database()
      .sql`insert into space (id, name, git_path, owner_principal_id) values (${spaceId}, 'personal', ${paths.root}, (select id from owner limit 1))`;
    return value;
  }

  serviceTest('health still answers, and the knowledge routes are mounted', async () => {
    const api = service();
    const session = await signIn(api);

    const health = await api.request('/health');
    expect(((await health.json()) as HealthBody).version).toBe(VERSION);

    const search = await api.request(`/knowledge/search?space_id=${spaceId}&q=bun`, {
      headers: { ...headers(), Cookie: session },
    });
    expect(search.status).toBe(200);
  });

  serviceTest('a module that is still a README says so instead of pretending', async () => {
    const api = service();
    const session = await signIn(api);
    const res = await api.request('/jobs', { headers: { Cookie: session } });
    expect(res.status).toBe(404);
  });

  serviceTest(
    'setup makes the catalog space usable without a provisional ID or header',
    async () => {
      const api = createApp({
        env: loadEnv({ MELETE_SPACES_DIR: root }),
        db: database().db,
        checkDatabase: async () => 'ok',
      });
      const cookie = await signIn(api);
      const catalog = (await (
        await api.request('/spaces', { headers: { Cookie: cookie } })
      ).json()) as { spaces: Array<{ id: string; git_path: string }> };
      const personal = catalog.spaces[0];
      if (!personal) throw new Error('Setup did not create a personal space');
      const search = await api.request(`/knowledge/search?space_id=${personal.id}&q=anything`, {
        headers: { Cookie: cookie },
      });
      expect(search.status).toBe(200);
      expect(await search.json()).toEqual({ hits: [] });
      expect(existsSync(join(personal.git_path, '.git', 'HEAD'))).toBe(true);

      const listing = await api.request('/knowledge', { headers: { Cookie: cookie } });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toEqual({ records: [] });
      const unauthenticated = await api.request(`/knowledge?space_id=${personal.id}`, {
        headers: { [SPACE_HEADER]: personal.id },
      });
      expect(unauthenticated.status).toBe(401);
      const mismatch = await api.request(`/knowledge/search?space_id=${spaceId}&q=anything`, {
        headers: { Cookie: cookie, [SPACE_HEADER]: personal.id },
      });
      expect(mismatch.status).toBe(403);
    },
  );
});
