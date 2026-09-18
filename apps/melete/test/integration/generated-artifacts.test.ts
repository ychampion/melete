import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Action, type Receipt, receipt as receiptContract } from '@melete/contracts';
import { createInternalServer } from '../../src/broker/internal-server.ts';
import { recordId } from '../../src/broker/records.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { connectorsFromEnv } from '../../src/connectors/configured.ts';
import { scriptFromWav } from '../../src/connectors/wav.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-generated-artifacts-'));
const env = loadEnv({
  MELETE_SPACES_DIR: root,
  MELETE_WORK_DIR: root,
  MELETE_ENABLE_FAKE_PROVIDER: 'true',
});
const app = createApp({ env, db: fixture?.db ?? null, checkDatabase: async () => 'ok' });
let cookie = '';
let generated: Action;
let proof: Receipt;
let bytes: Buffer;
let spaceId = '';
let artifactId = '';
let file = '';
const script = 'This episode is delivered through the authenticated artifact endpoint.';
if (fixture) {
  const seed = await seedJob(fixture.sql, { provider: 'generation', scopes: ['audio.synthesize'] });
  spaceId = seed.claims.space_id;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'audio@example.test', password: 'playback-password' }),
  });
  if (setup.status !== 201) throw new Error('Session setup failed');
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  const internal = createInternalServer({
    sql: fixture.sql,
    connectors: await connectorsFromEnv(fixture.sql, env),
    capabilityKey: 'c'.repeat(32),
    approvalKey: 'a'.repeat(32),
    resolveTrust: createTableTrustResolver({}, { fallback: 'owner' }),
  });
  const request = {
    connection_id: seed.connectionId,
    kind: 'audio.synthesize',
    payload: { script, path: 'episode.wav' },
  };
  const proposal = await internal.broker.propose(seed.claims, request);
  await internal.broker.decide(proposal.action_id, {
    decision: 'approved',
    payload_hash: proposal.payload_hash,
  });
  await internal.broker.propose(seed.claims, request);
  generated = await internal.broker.get(seed.claims, proposal.action_id);
  proof = receiptContract.parse(generated.receipt);
  artifactId = `art_${generated.id.slice(4)}`;
  file = join(root, spaceId, 'artifacts', 'episode.wav');
  bytes = await readFile(file);
}
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

const content = (id = artifactId, headers: Record<string, string> = {}) =>
  app.request(`/artifacts/${id}/content`, { headers: { cookie, ...headers } });

databaseTest(
  'successful broker synthesis persists the artifact identity named by its receipt',
  async () => {
    expect(proof.detail.artifact_id).toBe(artifactId);
    if (!fixture) return;
    const [stored] = await fixture.sql`select * from artifact where id = ${artifactId}`;
    expect(stored).toMatchObject({
      space_id: spaceId,
      job_id: generated.job_id,
      path: 'artifacts/episode.wav',
      mime: 'audio/wav',
      size: bytes.length,
    });
    expect(stored?.content_hash).toBe(proof.external_ref);
  },
);

databaseTest('authenticated playback returns generated WAV bytes and byte ranges', async () => {
  const response = await content();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('audio/wav');
  expect(response.headers.get('accept-ranges')).toBe('bytes');
  expect(response.headers.get('cache-control')).toContain('no-store');
  const received = new Uint8Array(await response.arrayBuffer());
  expect(received).toEqual(new Uint8Array(bytes));
  expect(scriptFromWav(received)).toBe(script);
  const partial = await content(artifactId, { range: 'bytes=0-43' });
  expect(partial.status).toBe(206);
  expect(partial.headers.get('content-range')).toBe(`bytes 0-43/${bytes.length}`);
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(
    new Uint8Array(bytes.subarray(0, 44)),
  );
  expect((await content(artifactId, { range: `bytes=${bytes.length}-` })).status).toBe(416);
});

databaseTest('artifact bytes require a session and matching artifact and job spaces', async () => {
  expect((await app.request(`/artifacts/${artifactId}/content`)).status).toBe(401);
  if (!fixture) return;
  const foreign = await seedJob(fixture.sql);
  const hiddenId = recordId('art');
  await fixture.sql`insert into artifact (id, space_id, job_id, path, content_hash, mime, size) values
    (${hiddenId}, ${foreign.claims.space_id}, ${foreign.claims.job_id}, 'artifacts/episode.wav', ${proof.external_ref ?? ''}, 'audio/wav', ${bytes.length})`;
  expect((await content(hiddenId, { 'x-melete-space': foreign.claims.space_id })).status).toBe(404);
  await fixture.sql`update artifact set space_id = ${spaceId} where id = ${hiddenId}`;
  expect((await content(hiddenId)).status).toBe(404);
  expect((await content(recordId('art'))).status).toBe(404);
});

databaseTest('artifact retrieval refuses traversal metadata and changed file bytes', async () => {
  if (!fixture) return;
  const invalidId = recordId('art');
  await fixture.sql`insert into artifact (id, space_id, job_id, path, content_hash, mime, size) values
    (${invalidId}, ${spaceId}, ${generated.job_id}, 'artifacts/../../outside.wav', ${proof.external_ref ?? ''}, 'audio/wav', ${bytes.length})`;
  expect((await content(invalidId)).status).toBe(404);
  try {
    await writeFile(file, 'unrelated replacement bytes');
    expect((await content()).status).toBe(404);
  } finally {
    await writeFile(file, bytes);
  }
});

databaseTest(
  'reconciliation restores the same retrievable artifact after a lost database receipt',
  async () => {
    if (!fixture) return;
    await fixture.sql`delete from artifact where id = ${artifactId}`;
    await fixture.sql`update action set status = 'unknown', receipt = null, resolved_at = null where id = ${generated.id}`;
    const restarted = createInternalServer({
      sql: fixture.sql,
      connectors: await connectorsFromEnv(fixture.sql, env),
      capabilityKey: 'c'.repeat(32),
      approvalKey: 'a'.repeat(32),
    });
    const recovered = await restarted.broker.verify(generated.id);
    expect(recovered.status).toBe('succeeded');
    expect(receiptContract.parse(recovered.receipt).detail.artifact_id).toBe(artifactId);
    expect(await fixture.sql`select id from artifact where id = ${artifactId}`).toHaveLength(1);
    expect(new Uint8Array(await (await content()).arrayBuffer())).toEqual(new Uint8Array(bytes));
  },
);
