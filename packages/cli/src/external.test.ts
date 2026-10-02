// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose substitutions and shell lines, not templates.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeStatus, SERVICES, type StatusFacts } from '../../../deploy/scripts/status.ts';
import { takeBackup } from './commands/backup.ts';
import { judgeCheck } from './commands/check.ts';
import { databaseBytes, recordedMigrations } from './commands/deploy.ts';
import { gatherDoctor, judgeDatabase, parseDatabaseAnswer } from './commands/doctor.ts';
import { adoptedConfig } from './commands/init.ts';
import { statusServices } from './commands/status.ts';
import {
  BLOBS_S3_FILE,
  composeCommand,
  type DeployConfig,
  deployConfigSchema,
  EXTERNAL_DB_FILE,
} from './deploy-config.ts';
import { parseCompose, readInstallation } from './installation.ts';
import { restoreSteps } from './plan.ts';
import { ok, REAL_DEPLOY_DIR, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const PASSWORD = 'e'.repeat(32);
const EXTERNAL_URL = `postgres://melete:${PASSWORD}@db.example.net:5432/melete?sslmode=require`;
const S3_ENV = {
  MELETE_BLOB_S3_ENDPOINT: 'https://s3.example.net',
  MELETE_BLOB_S3_BUCKET: 'melete-blobs',
  MELETE_BLOB_S3_ACCESS_KEY_ID: 'access-id',
  MELETE_BLOB_S3_SECRET_ACCESS_KEY: 's3-secret-value',
};

const contract = (deployDir: string, value: object) =>
  writeFileSync(join(deployDir, 'melete.deploy.json'), JSON.stringify({ contract: 1, ...value }));
const config = (value: object): DeployConfig => deployConfigSchema.parse({ contract: 1, ...value });
const external = config({ database: { external: true } });

const judge = (deployDir: string) => judgeCheck(readInstallation(deployDir, 'linux'));
const levels = (deployDir: string, prefix: string) =>
  Object.fromEntries(
    judge(deployDir)
      .filter((result) => result.id.startsWith(prefix))
      .map((result) => [result.id, result.level]),
  );
const failed = (deployDir: string) =>
  judge(deployDir)
    .filter((result) => result.level === 'fail')
    .map((result) => result.id);

type Service = {
  image?: string;
  profiles?: string[];
  depends_on?: Record<string, unknown>;
  networks?: Record<string, unknown> | string[];
  environment?: Record<string, string>;
  ports?: unknown[];
};
const services = (file: string) =>
  (
    parseCompose(readFileSync(join(REAL_DEPLOY_DIR, file), 'utf8')) as {
      services: Record<string, Service>;
    }
  ).services;

describe('the external database file', () => {
  const base = services('docker-compose.yml');
  const overlay = services(EXTERNAL_DB_FILE);

  test('keeps the bundled postgres off and the service off its private network, and changes nothing else about how it starts', () => {
    expect(overlay.postgres?.profiles).toEqual(['bundled-database']);
    const { postgres: _bundled, ...dependsWithout } = base.melete?.depends_on ?? {};
    expect(overlay.melete?.depends_on).toEqual({
      ...dependsWithout,
      'database-client': { condition: 'service_completed_successfully' },
    });
    const { database: _private, ...networksWithout } = (base.melete?.networks ?? {}) as Record<
      string,
      unknown
    >;
    expect(overlay.melete?.networks).toEqual(networksWithout);
    // Only the merge of networks and depends_on is replaced; the service's own settings stay the base file's.
    expect(Object.keys(overlay.melete ?? {}).sort()).toEqual(['depends_on', 'networks']);
  });

  test('reaches the database from the stack own pinned Postgres image, with the URL only in its environment', () => {
    const client = overlay['database-client'];
    expect(client?.image).toBe(base.postgres?.image);
    expect(client?.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(client?.environment?.DATABASE_URL).toBe(
      '${DATABASE_URL:?run bun run deploy/scripts/configure.ts}',
    );
    expect(client?.networks).toEqual(['edge']);
    expect(client?.ports).toBeUndefined();
    expect(JSON.stringify(overlay)).not.toContain('ports');
  });

  test('the melete command adds the file after the overlays, and the S3 file last', () => {
    const command = composeCommand(
      '/srv/melete/deploy',
      config({
        overlays: ['browser'],
        database: { external: true },
        blobs: { store: 's3', bucket: 'b' },
        profiles: ['sandbox'],
      }),
    ).join(' ');
    expect(command).toMatch(
      /docker-compose\.yml -f \S+docker-compose\.browser\.yml -f \S+docker-compose\.external-db\.yml -f \S+docker-compose\.blobs-s3\.yml --profile sandbox$/,
    );
    expect(composeCommand('/srv/melete/deploy', config({})).join(' ')).not.toMatch(
      /external-db|blobs-s3/,
    );
  });
});

describe('melete check with an external database', () => {
  test('a database URL that asks for TLS passes', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    contract(deployDir, { database: { external: true } });
    expect(failed(deployDir)).toEqual([]);
    expect(levels(deployDir, 'database.')).toEqual({
      'database.supported': 'ok',
      'database.external_url': 'ok',
      'database.tls': 'ok',
    });
  });

  test('a database URL that would let the connection go unencrypted fails, and the URL is never shown', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL.replace('?sslmode=require', '') });
    contract(deployDir, { database: { external: true } });
    expect(failed(deployDir)).toEqual(['database.tls']);
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL.replace('require', 'prefer') });
    expect(failed(deployDir)).toEqual(['database.tls']);
    expect(JSON.stringify(judge(deployDir))).not.toContain(PASSWORD);
  });

  test('an external database whose URL still names the bundled postgres fails', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    contract(deployDir, { database: { external: true } });
    expect(failed(deployDir)).toEqual(['database.external_url']);
  });

  test('a URL naming another server while the bundled database runs is a warning', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    contract(deployDir, {});
    expect(levels(deployDir, 'database.')).toEqual({ 'database.external_url': 'warn' });
  });
});

describe('melete check with an S3-compatible blob store', () => {
  const s3 = { store: 's3', endpoint: 'https://s3.example.net', bucket: 'melete-blobs' };

  test('a bucket the contract and deploy/.env agree on passes', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, S3_ENV);
    contract(deployDir, { blobs: s3 });
    expect(failed(deployDir)).toEqual([]);
    expect(levels(deployDir, 'blobs.')).toEqual({
      'blobs.supported': 'ok',
      'blobs.matches_env': 'ok',
    });
  });

  test('the bucket keys are required, and named without their values', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { ...S3_ENV, MELETE_BLOB_S3_SECRET_ACCESS_KEY: '' });
    contract(deployDir, { blobs: s3 });
    expect(failed(deployDir)).toEqual(['env.blob_s3_secret_access_key']);
  });

  test('a contract and deploy/.env that name different buckets fail', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { ...S3_ENV, MELETE_BLOB_S3_BUCKET: 'another' });
    contract(deployDir, { blobs: s3 });
    expect(failed(deployDir)).toEqual(['blobs.matches_env']);
  });

  test('deploy/.env asking for S3 while the contract keeps blobs local fails', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { ...S3_ENV, MELETE_BLOB_STORE: 's3' });
    contract(deployDir, {});
    expect(failed(deployDir)).toEqual(['blobs.matches_env']);
  });

  test('a plain HTTP endpoint is a warning', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { ...S3_ENV, MELETE_BLOB_S3_ENDPOINT: 'http://10.0.0.5:9000' });
    contract(deployDir, { blobs: { ...s3, endpoint: 'http://10.0.0.5:9000' } });
    expect(levels(deployDir, 'blobs.')).toMatchObject({ 'blobs.tls': 'warn' });
  });

  test('the service is handed the S3 settings the blob store reads', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, S3_ENV);
    contract(deployDir, { blobs: s3 });
    const installation = readInstallation(deployDir, 'linux');
    const environment = Object.assign(
      {},
      ...installation.compose.map((read) => read.resolved?.services?.melete?.environment ?? {}),
    );
    expect(environment).toMatchObject({
      MELETE_BLOB_STORE: 's3',
      MELETE_BLOB_S3_ENDPOINT: 'https://s3.example.net',
      MELETE_BLOB_S3_BUCKET: 'melete-blobs',
      MELETE_BLOB_S3_ACCESS_KEY_ID: 'access-id',
      MELETE_BLOB_S3_SECRET_ACCESS_KEY: 's3-secret-value',
    });
  });
});

describe('reaching an external database', () => {
  test('backup dumps it from the client container, and the URL never reaches a command line', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    const context = testContext(deployDir);
    const outcome = await takeBackup(
      context,
      external,
      { kind: 'dir', dir: join(deployDir, '..', 'b') },
      false,
    );
    expect(outcome.ok).toBe(true);
    const dump = context.streams[0];
    const source = dump && 'command' in dump.source ? dump.source.command.join(' ') : '';
    expect(source).toContain(
      'run --rm --no-deps -T database-client sh -c exec pg_dump --dbname="$DATABASE_URL" --format=custom',
    );
    expect(source).not.toContain('exec -T postgres');
    const check = dump?.sinks.find((sink) => 'command' in sink);
    expect(check && 'command' in check ? check.command.slice(-4) : []).toEqual([
      '-T',
      'database-client',
      'pg_restore',
      '--list',
    ]);
    const lines = [
      ...context.docker.calls,
      ...context.streams.flatMap((stream) => [
        'command' in stream.source ? stream.source.command : [],
        ...stream.sinks.map((sink) => ('command' in sink ? sink.command : [])),
      ]),
    ].map((call) => call.join(' '));
    for (const line of lines) expect(line).not.toContain(PASSWORD);
  });

  test('deploy reads the recorded migrations and the size through the client container', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    const compose = composeCommand(deployDir, external);
    const client = `${compose.join(' ')} run --rm --no-deps -T database-client sh -c exec psql --dbname="$DATABASE_URL" -At -c`;
    const context = testContext(deployDir, [
      [`${client} "select created_at`, ok('1789232400049\n1789232400050\n')],
      [`${client} "select pg_database_size`, ok('81920000\n')],
    ]);
    expect(recordedMigrations(context, compose, external)).toEqual([1789232400049, 1789232400050]);
    expect(databaseBytes(context, compose, external)).toBe(81_920_000);
    // The bundled database is asked inside its own container, as before.
    const bundled = config({});
    expect(recordedMigrations(context, composeCommand(deployDir, bundled), bundled)).toBeNull();
    expect(context.docker.calls.at(-1)?.join(' ')).toContain(
      'exec -T postgres sh -c exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    );
  });

  test('the restore steps load the dump into the external database and leave every volume alone', () => {
    const steps = restoreSteps({
      root: '/srv/melete',
      project: 'melete',
      compose: composeCommand('/srv/melete/deploy', external),
      writers: ['melete', 'runtime', 'web'],
      backupDir: '/b/melete-20261002T024141Z',
      previous: null,
      freshHost: true,
      journalArchive: '/b/melete-20261002T024141Z/restrictions-20261002T024141Z.tar',
      externalDatabase: true,
    }).join('\n');
    expect(steps).not.toContain('docker volume rm');
    expect(steps).not.toContain('up -d --no-build --wait postgres');
    expect(steps).toContain(
      `run --rm --no-deps -T database-client sh -c 'exec pg_restore --dbname="$DATABASE_URL" --no-owner --no-privileges --exit-on-error' < /b/melete-20261002T024141Z/database.dump`,
    );
    // The journal still comes back before the service starts on a new machine.
    expect(steps.indexOf('cp -a - melete:/data')).toBeLessThan(
      steps.indexOf('up -d --no-build --wait\n'),
    );
  });

  test('status judges the services the installation runs, so a database elsewhere is not a missing postgres', () => {
    expect(statusServices(external)).toEqual(['melete', 'runtime', 'web']);
    expect(statusServices(config({}))).toEqual([...SERVICES]);
    const facts: StatusFacts = {
      docker: [],
      dockerVersions: '',
      env: {},
      freeBytes: 50 * 1024 ** 3,
      images: [],
      services: ['melete', 'runtime', 'web'].map((service) => ({
        service,
        state: 'running',
        health: 'healthy',
      })),
      health: { status: 'ok', database: 'ok' },
      setupNeeded: false,
    };
    const servicesCheck = (list?: readonly string[]) =>
      judgeStatus(facts, undefined, list).find((check) => check.name === 'Services');
    expect(servicesCheck(statusServices(external))?.level).toBe('ok');
    expect(servicesCheck()?.detail).toContain('postgres not started');
  });
});

describe('melete doctor with an external database', () => {
  test('judges the server version and that the connection is encrypted', () => {
    const level = (stdout: string) =>
      Object.fromEntries(judgeDatabase(parseDatabaseAnswer(stdout)).map((r) => [r.id, r.level]));
    expect(level('170004\nt\n')).toEqual({
      'database.reachable': 'ok',
      'database.version': 'ok',
      'database.tls': 'ok',
    });
    expect(level('160009\nt\n')['database.version']).toBe('fail');
    expect(level('180001\nt\n')['database.version']).toBe('warn');
    expect(level('170004\nf\n')['database.tls']).toBe('fail');
    expect(judgeDatabase({ answered: false, detail: 'timeout expired' })[0]?.level).toBe('fail');
  });

  const doctorSetup = (present: boolean) => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    contract(deployDir, { database: { external: true } });
    const installation = readInstallation(deployDir, 'linux');
    const compose = composeCommand(deployDir, installation.config).join(' ');
    const image =
      'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
    const context = testContext(deployDir, [
      [`${compose} config --images`, ok(`${image}\nghcr.io/ychampion/melete-service:main\n`)],
      [`docker image inspect --format {{.Id}} ${image}`, present ? ok('sha256:1') : { code: 1 }],
      ['docker image inspect', ok('sha256:2')],
      [`${compose} ps`, ok('')],
      [`${compose} run --rm --no-deps -T database-client`, ok('170004\nt\n')],
    ]);
    return { context, installation, compose };
  };

  test('asks the server from the client image already on the engine, and only when online', async () => {
    const { context, installation, compose } = doctorSetup(true);
    const facts = await gatherDoctor(context, installation, false);
    expect(facts.database).toEqual({ answered: true, versionNum: 170004, encrypted: true });
    const asked = context.docker.calls.filter((call) =>
      call.join(' ').startsWith(`${compose} run`),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.join(' ')).not.toContain(PASSWORD);
    const offline = doctorSetup(true);
    expect((await gatherDoctor(offline.context, offline.installation, true)).database).toBeNull();
    expect(offline.context.docker.calls.some((call) => call.join(' ').includes(' run '))).toBe(
      false,
    );
  });

  test('never pulls the client image: without it the database is reported, not asked', async () => {
    const { context, installation } = doctorSetup(false);
    const facts = await gatherDoctor(context, installation, false);
    expect(facts.database).toMatchObject({ answered: false });
    expect(context.docker.calls.some((call) => call.join(' ').includes(' run '))).toBe(false);
  });
});

describe('init --adopt with an external database or a bucket', () => {
  const container = (configFiles: string[], service = 'melete') => ({
    service,
    image: 'ghcr.io/ychampion/melete-service:main',
    configFiles,
    oneoff: false,
    running: true,
  });

  test('describes the stack Compose was given the files for', () => {
    const files = [
      '/srv/melete/deploy/docker-compose.yml',
      `/srv/melete/deploy/${EXTERNAL_DB_FILE}`,
      `/srv/melete/deploy/${BLOBS_S3_FILE}`,
    ];
    const adopted = adoptedConfig('melete', [container(files)], S3_ENV, {});
    expect(adopted.database).toEqual({ external: true });
    expect(adopted.blobs).toEqual({
      store: 's3',
      bucket: 'melete-blobs',
      endpoint: 'https://s3.example.net',
    });
    const plain = adoptedConfig(
      'melete',
      [container(['/srv/melete/deploy/docker-compose.yml'])],
      S3_ENV,
      {},
    );
    expect(plain.database).toEqual({ external: false });
    expect(plain.blobs).toEqual({ store: 'local' });
  });

  test('refuses a bucket stack whose deploy/.env does not name the bucket', () => {
    const files = ['/srv/melete/deploy/docker-compose.yml', `/srv/melete/deploy/${BLOBS_S3_FILE}`];
    expect(() => adoptedConfig('melete', [container(files)], {}, {})).toThrow(
      'MELETE_BLOB_S3_BUCKET',
    );
  });
});
