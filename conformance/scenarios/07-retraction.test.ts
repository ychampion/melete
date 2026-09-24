import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { newId } from '../../apps/melete/src/ids.ts';
import {
  api,
  approveJob,
  composeEnabled,
  createApprovalJob,
  docker,
  ensureTestConnection,
  ownerSpace,
  restartStack,
  serviceId,
  sql,
  waitForStack,
} from '../helpers/compose.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(7);
const withCompose = composeEnabled ? describe : describe.skip;
type PhysicalRecord = { records: number; fts: number; head: string; history: string };

// Run in the deployed image against its real named volume. Seed through the
// production writer, then inspect SQLite directly instead of filtering search.
const seedRecord = `
import { databaseSpaces } from './apps/melete/src/knowledge/spaces.ts';
import { openDatabase } from './apps/melete/src/db/client.ts';
import { commitRecord, serializeRecord } from '@melete/knowledge';
const data = JSON.parse(process.env.MELETE_RETRACTION_FIXTURE);
const handle = openDatabase(process.env.DATABASE_URL);
try {
  const ref = await databaseSpaces(handle.db, process.env.MELETE_SPACES_DIR).byId(data.spaceId);
  if (!ref) throw new Error('The catalog space is unavailable');
  const day = new Date().toISOString().slice(0, 10);
  const frontmatter = {
    id: data.recordId, title: data.marker, space: ref.name, audience: 'private',
    type: 'fact', status: 'active', confidence: 'high', asserted_by: 'user',
    source: { kind: 'statement', ref: 'compose-conformance:7', quote: data.marker, sha256: null },
    observed_at: day, valid_from: day, valid_until: null, supersedes: [], superseded_by: null,
    created: day, updated: day, tags: ['conformance'], links: [], schema_version: 1,
  };
  await commitRecord(ref.paths, data.path, serializeRecord(frontmatter, data.marker), {
    proposedBy: 'owner', approvedBy: 'owner', subject: 'Record the retraction conformance fixture',
  });
} finally { await handle.close(); }
`;

const inspectRecord = `
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { git } from '@melete/knowledge';
const data = JSON.parse(process.env.MELETE_RETRACTION_FIXTURE);
const root = join(process.env.MELETE_SPACES_DIR, data.spaceId);
const index = new Database(join(root, '.index/fts.sqlite'), { readonly: true });
try {
  const records = index.query('select count(*) as count from record where id = ?').get(data.recordId).count;
  const fts = index.query('select count(*) as count from record_fts where id = ?').get(data.recordId).count;
  const head = await git(root, ['show', 'HEAD:' + data.path]);
  const history = await git(root, ['log', '-1', '--format=%B', '--', data.path]);
  console.log(JSON.stringify({ records, fts, head, history }));
} finally { index.close(); }
`;

withCompose(`conformance 7: ${s.title}`, () => {
  let database: Awaited<ReturnType<typeof sql>> | undefined;
  let spaceId = '';
  let jobId = '';
  const recordId = newId('k');
  const marker = `w6retraction${randomBytes(12).toString('hex')}`;
  const reason = 'This fixture was explicitly retracted during the approval wait.';
  const path = `knowledge/${marker}.md`;
  let before: PhysicalRecord;
  let after: PhysicalRecord;
  let afterRestart: PhysicalRecord;
  let beforeHits: string[] = [];
  let afterHits: string[] = [];
  let restartHits: string[] = [];
  let resumedHits: string[] = [];
  let attempts = 0;
  let restartMs = 0;

  const headers = () => ({ 'x-melete-space': spaceId });
  const search = async (): Promise<string[]> => {
    const response = await api(`/knowledge/search?space_id=${spaceId}&q=${marker}`, {
      headers: headers(),
    });
    if (!response.ok) throw new Error(`Knowledge search answered ${response.status}`);
    const body = (await response.json()) as { hits: { id: string }[] };
    return body.hits.map((hit) => hit.id);
  };
  const insideService = async (script: string) =>
    docker(
      'exec',
      '-e',
      `MELETE_RETRACTION_FIXTURE=${JSON.stringify({ spaceId, recordId, marker, path })}`,
      await serviceId('melete'),
      'bun',
      '-e',
      script,
    );
  const physical = async () => JSON.parse(await insideService(inspectRecord)) as PhysicalRecord;

  beforeAll(async () => {
    await waitForStack();
    await ensureTestConnection();
    spaceId = await ownerSpace();
    database = await sql();
    await insideService(seedRecord);
    beforeHits = await search();
    before = await physical();
    const job = await createApprovalJob({
      title: 'Retract knowledge during a durable approval wait',
      objective: `Use ${marker} as background and send the scripted test message once.`,
    });
    jobId = job.jobId;
    expect(job.spaceId).toBe(spaceId);
    const retracted = await api(`/knowledge/${recordId}`, {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ reason, hard_delete: false }),
    });
    expect(retracted.status).toBe(200);
    expect(await retracted.json()).toMatchObject({
      id: recordId,
      frontmatter: { status: 'retracted' },
    });
    afterHits = await search();
    after = await physical();
    const started = performance.now();
    await restartStack();
    restartMs = Math.round(performance.now() - started);
    // The old pool knows the database at the address it had before the restart.
    await database?.end();
    database = await sql();
    restartHits = await search();
    afterRestart = await physical();
    const [parked] = await database`select state from job where id = ${jobId}`;
    expect(parked?.state).toBe('waiting_for_approval');
    await approveJob(jobId);
    attempts = (await database`select id from attempt where job_id = ${jobId}`).length;
    resumedHits = await search();
    console.log(JSON.stringify({ scenario: 7, job_id: jobId, restart_ms: restartMs, attempts }));
  }, 300_000);

  afterAll(async () => {
    await database?.end();
  });

  test(s.assertions[0] ?? '', async () => {
    if (!database) throw new Error('The Compose database is unavailable');
    expect(beforeHits).toContain(recordId);
    expect(afterHits).not.toContain(recordId);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(resumedHits).not.toContain(recordId);
    const contexts = await database<{ attempt_id: string; record_ids: string[] }[]>`
      select attempt_id, payload->'record_ids' as record_ids from event
      where job_id = ${jobId} and type = 'notice'
        and payload->>'kind' = 'legacy_knowledge_context' order by seq`;
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(contexts[0]?.record_ids).toContain(recordId);
    for (const context of contexts.slice(1)) expect(context.record_ids).not.toContain(recordId);
    // Context preparation alone is insufficient: the corresponding runtime
    // attempts must have actually started consuming their prepared bundles.
    for (const context of contexts) {
      const started = await database`select seq from event
        where attempt_id = ${context.attempt_id} and type = 'turn_started'`;
      expect(started.length).toBeGreaterThan(0);
    }
  });
  test(s.assertions[1] ?? '', () => {
    expect(before.records).toBe(1);
    expect(before.fts).toBe(1);
    expect(after.records).toBe(0);
    expect(after.fts).toBe(0);
  });
  test(s.assertions[2] ?? '', () => {
    expect(restartHits).not.toContain(recordId);
    expect(afterRestart.records).toBe(0);
    expect(afterRestart.fts).toBe(0);
  });
  test(s.assertions[3] ?? '', () => {
    for (const snapshot of [after, afterRestart]) {
      expect(snapshot.head).toContain('status: retracted');
      expect(snapshot.head).toContain(marker);
      expect(snapshot.head).toContain(reason);
      expect(snapshot.history).toContain('Retract');
      expect(snapshot.history).toContain('Melete-Proposed-By: owner');
    }
  });
});
