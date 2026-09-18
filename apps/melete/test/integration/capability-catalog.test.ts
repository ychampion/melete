import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spacePaths } from '@melete/knowledge';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { loadEnv } from '../../src/env.ts';
import { bootstrap } from '../../src/index.ts';
import { knowledgeRoutes, SPACE_HEADER, skillsForObjective } from '../../src/knowledge/routes.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-capability-catalog-'));
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

async function setup(fake: boolean, grants = ['audio.synthesize', 'web.fetch', 'files.write']) {
  if (!fixture) throw new Error('Missing database');
  const seed = await seedJob(fixture.sql, { provider: 'generation', scopes: grants });
  for (const [provider, scopes] of [
    ['web', ['web.fetch']],
    ['files', ['files.write']],
  ] as const) {
    await fixture.sql`insert into connection (id, space_id, provider, label, scopes) values
      (${recordId('conn')}, ${seed.claims.space_id}, ${provider}, ${provider}, ${JSON.stringify(scopes)}::jsonb)`;
  }
  const connectors = await configuredConnectors({
    sql: fixture.sql,
    spacesRoot: root,
    workRoot: root,
    env: { MELETE_ENABLE_FAKE_PROVIDER: String(fake) },
  });
  const broker = new BrokerService({ sql: fixture.sql, connectors });
  const space = {
    id: seed.claims.space_id,
    name: seed.claims.space_id,
    paths: spacePaths(root, seed.claims.space_id),
  };
  const app = knowledgeRoutes({
    spaces: {
      byId: async (id) => (id === space.id ? space : null),
      byName: async () => space,
      list: async () => [space],
    },
    toolsForSpace: async () => broker.catalog(seed.claims),
  });
  const listed = async () => {
    const response = await app.request('/skills', { headers: { [SPACE_HEADER]: space.id } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skills: { frontmatter: { name: string } }[] };
    return body.skills.map((s) => s.frontmatter.name);
  };
  return { ...seed, broker, listed };
}

databaseTest('the production catalog omits synthesis when no provider is configured', async () => {
  const s = await setup(false);
  expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).not.toContain(
    'audio.synthesize',
  );
});

databaseTest(
  'the skill HTTP service and selection omit podcasts without an available granted tool',
  async () => {
    for (const [fake, grants] of [
      [false, ['audio.synthesize', 'web.fetch', 'files.write']],
      [true, ['web.fetch', 'files.write']],
    ] as const) {
      const s = await setup(fake, [...grants]);
      expect(await s.listed()).not.toContain('make-a-podcast');
      const catalog = await s.broker.catalog(s.claims);
      expect(
        skillsForObjective('Make a podcast about rivers', '', undefined, catalog).map(
          (m) => m.skill.frontmatter.name,
        ),
      ).not.toContain('make-a-podcast');
    }
  },
);

databaseTest(
  'the skill service offers a podcast only with its provider and all grants',
  async () => {
    const s = await setup(true);
    expect(await s.listed()).toContain('make-a-podcast');
    const catalog = await s.broker.catalog(s.claims);
    expect(
      skillsForObjective('Make a podcast about rivers', '', undefined, catalog).map(
        (m) => m.skill.frontmatter.name,
      ),
    ).toContain('make-a-podcast');
    if (!fixture) return;
    await fixture.sql`update connection set status = 'disabled' where id = ${s.connectionId}`;
    expect(await s.listed()).not.toContain('make-a-podcast');
  },
);

databaseTest('objective selection cannot offer a podcast when its catalog lacks speech', () => {
  expect(
    skillsForObjective('Make a podcast about rivers', '', undefined, []).map(
      (m) => m.skill.frontmatter.name,
    ),
  ).not.toContain('make-a-podcast');
});

databaseTest(
  'production attempt bundles select skills from the available job-scoped catalog',
  async () => {
    if (!fixture) return;
    const seed = await setup(true);
    const service = await bootstrap({
      workers: false,
      env: loadEnv({
        DATABASE_URL: fixture.url,
        MELETE_CAPABILITY_KEY: 'catalog-attempt-key'.repeat(3),
        MELETE_RUNTIME_ADAPTER: 'stub',
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_SPACES_DIR: root,
        MELETE_WORK_DIR: root,
      }),
    });
    try {
      if (!service.jobs || !service.runner) throw new Error('Missing runtime service');
      for (const enabled of [true, false]) {
        service.runner.options.scopes = enabled
          ? ['audio.synthesize', 'web.fetch', 'files.write']
          : ['web.fetch', 'files.write'];
        const row = await service.jobs.create({
          space_id: seed.claims.space_id,
          title: 'Podcast',
          objective: 'Make a podcast about rivers',
        });
        const claimed = await service.runner.claim({
          job_id: row.id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'created',
        });
        expect(claimed).not.toBeNull();
        expect(claimed?.bundle.tools.some((tool) => tool.name === 'audio.synthesize')).toBe(
          enabled,
        );
        expect(claimed?.bundle.skills.some((skill) => skill.name === 'make-a-podcast')).toBe(
          enabled,
        );
      }
    } finally {
      await service.close();
    }
  },
  60_000,
);
