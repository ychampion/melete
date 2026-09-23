import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ATTEMPT_LOG_CONFIG } from '../../apps/melete/src/runtime/docker.ts';
import {
  type ComposeFile,
  type ComposeLogging,
  checkCellConfig,
  checkCompose,
  defaultComposePath,
  loadCompose,
} from './compose-check.ts';

const compose = loadCompose(defaultComposePath());

const failures = (file: ComposeFile) =>
  checkCompose(file)
    .filter((r) => !r.ok)
    .map((r) => r.name);

describe('the shipped compose file', () => {
  test('requires an explicit Docker socket group without a root default', () => {
    const service = compose.services?.melete;
    expect(service?.group_add?.some((entry) => /^\$\{DOCKER_GID:\?/.test(entry))).toBe(true);
  });
  test('passes every boundary check', () => {
    expect(failures(compose)).toEqual([]);
  });

  test('declares the internal network as internal', () => {
    expect(compose.networks?.internal?.internal).toBe(true);
  });
});

describe('the check catches the mistakes that would matter', () => {
  test('selecting the stub for ordinary deployments', () => {
    const broken = structuredClone(compose);
    if (broken.services?.melete?.environment)
      broken.services.melete.environment.MELETE_RUNTIME_ADAPTER = 'stub';
    expect(failures(broken)).toContain('the default service supervises attempts itself');
  });
  test('leaving the service to read its catalog from a port nothing binds', () => {
    const name = 'the service reads its tool catalog from the broker it binds';
    expect(compose.services?.melete?.environment?.MELETE_BROKER_URL).toBe('http://melete:8788');
    const unset = structuredClone(compose);
    delete unset.services?.melete?.environment?.MELETE_BROKER_URL;
    expect(failures(unset)).toContain(name);
    const moved = structuredClone(compose);
    if (moved.services?.melete?.environment)
      moved.services.melete.environment.MELETE_BROKER_BIND = '0.0.0.0:8799';
    expect(failures(moved)).toContain(name);
    const loopback = structuredClone(compose);
    if (loopback.services?.melete?.environment)
      loopback.services.melete.environment.MELETE_BROKER_BIND = '127.0.0.1:8788';
    expect(failures(loopback)).toContain(name);
    const split = structuredClone(compose);
    if (split.services?.runtime?.environment)
      split.services.runtime.environment.MELETE_BROKER_URL = 'http://melete:3112';
    expect(failures(split)).toContain(name);
  });
  test('giving the runtime an edge network', () => {
    const broken: ComposeFile = structuredClone(compose);
    const runtime = broken.services?.runtime;
    if (runtime) runtime.networks = ['internal', 'edge'];
    expect(failures(broken)).toContain('the runtime is on the internal network only');
  });

  test('dropping internal: true from the network', () => {
    const broken: ComposeFile = structuredClone(compose);
    if (broken.networks?.internal) broken.networks.internal.internal = false;
    expect(failures(broken)).toContain('the internal network has no route out');
  });

  test('a network name shared by every installation on the host', () => {
    const name = 'every network belongs to this Compose project';
    expect(compose.networks?.internal?.name).toBeUndefined();
    const fixed: ComposeFile = structuredClone(compose);
    if (fixed.networks?.internal) fixed.networks.internal.name = 'melete_internal';
    expect(failures(fixed)).toContain(name);
    const scoped: ComposeFile = structuredClone(compose);
    if (scoped.networks?.internal)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expands this variable.
      scoped.networks.internal.name = '${COMPOSE_PROJECT_NAME:-melete}_internal';
    expect(failures(scoped)).not.toContain(name);
  });

  test('publishing a runtime port', () => {
    const broken: ComposeFile = structuredClone(compose);
    const runtime = broken.services?.runtime;
    if (runtime) runtime.ports = ['8790:8790'];
    expect(failures(broken)).toContain('the runtime publishes no ports');
  });

  test('mounting the host into the runtime', () => {
    const broken: ComposeFile = structuredClone(compose);
    const runtime = broken.services?.runtime;
    if (runtime)
      runtime.volumes = [
        'spaces:/work',
        'runtime-home:/var/lib/hermes',
        '/var/run/docker.sock:/var/run/docker.sock',
      ];
    expect(failures(broken)).toContain('the runtime mounts nothing but /work and /var/lib/hermes');
  });

  test('taking away the runtime writable Hermes home', () => {
    // Without it the run-idempotency store degrades to process memory,
    // /v1/capabilities reports durable=false, and the adapter refuses to start.
    const broken: ComposeFile = structuredClone(compose);
    const runtime = broken.services?.runtime;
    if (runtime) runtime.volumes = ['work:/work'];
    expect(failures(broken)).toContain('the runtime has a writable Hermes home');
  });

  test('letting the runtime keep its capabilities', () => {
    const broken: ComposeFile = structuredClone(compose);
    const runtime = broken.services?.runtime;
    if (runtime) runtime.cap_drop = [];
    expect(failures(broken)).toContain('the runtime drops every capability');
  });

  test('publishing the Postgres port to the host', () => {
    const broken: ComposeFile = structuredClone(compose);
    const postgres = broken.services?.postgres;
    if (postgres) postgres.ports = ['5432:5432'];
    expect(failures(broken)).toContain('postgres is internal and unpublished');
  });

  test('putting Postgres on the runtime network', () => {
    const broken = structuredClone(compose);
    if (broken.services?.postgres) broken.services.postgres.networks = ['internal'];
    expect(failures(broken)).toContain('postgres is internal and unpublished');
    expect(failures(broken)).toContain("the broker is the runtime network's only peer");
  });

  test('mounting the entire work volume exposes sibling jobs', () => {
    const broken = structuredClone(compose);
    if (broken.services?.runtime)
      broken.services.runtime.volumes = ['work:/work', 'runtime-home:/var/lib/hermes'];
    expect(failures(broken)).toContain(
      'the runtime sees one workspace subdirectory, never the work volume root',
    );
  });

  test('internal without isolated gateway mode exposes host listeners', () => {
    const broken = structuredClone(compose);
    if (broken.networks?.internal) delete broken.networks.internal.driver_opts;
    expect(failures(broken)).toContain('the runtime network has no host bridge address');
  });

  test('host namespaces and privileged mode are rejected', () => {
    for (const field of ['network_mode', 'pid', 'ipc', 'privileged'] as const) {
      const broken = structuredClone(compose);
      if (broken.services?.runtime)
        Object.assign(broken.services.runtime, { [field]: field === 'privileged' ? true : 'host' });
      expect(failures(broken)).toContain(
        'the runtime cannot join host namespaces or run privileged',
      );
    }
  });

  test('depending on a service that is not in the file', () => {
    // The landed file once depended on a runtime-image service it no longer
    // declared; Compose refuses such a project before anything starts.
    const broken = structuredClone(compose);
    if (broken.services) delete broken.services['runtime-image'];
    expect(failures(broken)).toContain('every dependency names a service in the file');
    expect(failures(broken)).toContain('the supervisor image is built without a running engine');
  });

  test('building the supervisor image on a network, or with the engine running', () => {
    const networked = structuredClone(compose);
    const image = networked.services?.['runtime-image'];
    if (image) image.network_mode = 'bridge';
    expect(failures(networked)).toContain('the supervisor image is built without a running engine');
    const running = structuredClone(compose);
    const build = running.services?.['runtime-image'];
    if (build) delete build.entrypoint;
    expect(failures(running)).toContain('the supervisor image is built without a running engine');
  });

  test.each([
    { environment: { MELETE_MASTER_KEY: 'dummy-master-key' } },
    { environment: { OPENAI_API_KEY: 'dummy-provider-key' } },
    { environment: { MELETE_ATTEMPT_TOKEN: 'dummy-attempt-token' } },
    { environment: { MELETE_MASTER_KEY: null } },
    { environment: ['MELETE_MASTER_KEY=dummy-master-key'] },
    { environment: ['MELETE_MASTER_KEY'] },
    { env_file: './build.env' },
    { env_file: ['./build.env'] },
    { env_file: [{ path: './build.env', required: false }] },
    { secrets: ['master-key'] },
    { secrets: [{ source: 'master-key', target: 'credentials' }] },
    { volumes: ['./master-key:/run/secrets/master-key:ro'] },
    { volumes: [{ type: 'bind', source: './build.env', target: '/credentials', read_only: true }] },
  ])('giving the build-only service credentials through %j', (credentials) => {
    const broken = structuredClone(compose);
    const image = broken.services?.['runtime-image'];
    if (!image) throw new Error('Expected build-only service');
    Object.assign(image, credentials);
    expect(failures(broken)).toContain('the build-only service carries no credentials');
  });

  test('handing the warm cell a service secret or a substituted attempt credential', () => {
    const withSecret = structuredClone(compose);
    if (withSecret.services?.runtime?.environment)
      withSecret.services.runtime.environment.MELETE_CAPABILITY_KEY = [
        '$',
        '{MELETE_CAPABILITY_KEY}',
      ].join('');
    expect(failures(withSecret)).toContain('the warm cell carries no attempt authority');
    const withToken = structuredClone(compose);
    if (withToken.services?.runtime?.environment)
      withToken.services.runtime.environment.MELETE_ATTEMPT_TOKEN = [
        '$',
        '{MELETE_ATTEMPT_TOKEN:?set}',
      ].join('');
    expect(failures(withToken)).toContain('the warm cell carries no attempt authority');
    const withSigned = structuredClone(compose);
    if (withSigned.services?.runtime?.environment)
      withSigned.services.runtime.environment.MELETE_ATTEMPT_TOKEN =
        'eyJhbGciOiJIUzI1NiJ9.eyJqb2IiOiJqb2JfMSJ9.c2lnbmF0dXJl';
    expect(failures(withSigned)).toContain('the warm cell carries no attempt authority');
  });

  test('every shipped service keeps bounded json-file logs', () => {
    const services = Object.entries(compose.services ?? {});
    expect(services.map(([name]) => name).sort()).toEqual([
      'melete',
      'postgres',
      'runtime',
      'runtime-image',
      'web',
    ]);
    for (const [, service] of services)
      expect(service.logging).toEqual({
        driver: 'json-file',
        options: { 'max-size': '10m', 'max-file': '5' },
      });
  });

  test('attempt containers get the same limits as the services', () => {
    expect(compose.services?.runtime?.logging).toEqual({
      driver: ATTEMPT_LOG_CONFIG.Type,
      options: { ...ATTEMPT_LOG_CONFIG.Config },
    });
  });

  test.each(['postgres', 'melete', 'runtime-image', 'runtime', 'web'])(
    'leaving %s with the unbounded default log',
    (name) => {
      const broken = structuredClone(compose);
      if (broken.services?.[name]) delete broken.services[name].logging;
      const failed = checkCompose(broken).find(
        (result) => result.name === 'every service has bounded logs',
      );
      expect(failed?.ok).toBe(false);
      expect(failed?.detail).toContain(name);
    },
  );

  test.each<ComposeLogging>([
    { driver: 'json-file' },
    { driver: 'json-file', options: { 'max-file': '5' } },
    { driver: 'json-file', options: { 'max-size': '10m' } },
    { driver: 'json-file', options: { 'max-size': '0', 'max-file': '5' } },
    { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '0' } },
    { driver: 'json-file', options: { 'max-size': 'unlimited', 'max-file': '5' } },
    { driver: 'syslog', options: { 'max-size': '10m', 'max-file': '5' } },
    { options: { 'max-size': '10m', 'max-file': '5' } },
  ])('a log configuration without a real bound: %j', (logging) => {
    const broken = structuredClone(compose);
    if (broken.services?.web) broken.services.web.logging = logging;
    expect(failures(broken)).toContain('every service has bounded logs');
  });

  test('removing the runtime service altogether', () => {
    const broken: ComposeFile = structuredClone(compose);
    if (broken.services) delete broken.services.runtime;
    expect(failures(broken)).toContain('the runtime service exists');
  });

  test('binding the owner API to every interface is rejected', () => {
    const broken = structuredClone(compose);
    if (broken.services?.melete?.environment)
      broken.services.melete.environment.MELETE_API_BIND = '0.0.0.0';
    expect(failures(broken)).toContain('the owner API binds only to its edge network address');
  });

  test('trusting any peer but the edge-only web proxy for browser addresses is rejected', () => {
    const check = 'only the web proxy may state a browser address to the owner API';
    const renamed = structuredClone(compose);
    if (renamed.services?.melete?.environment)
      renamed.services.melete.environment.MELETE_TRUSTED_PROXY = 'runtime';
    expect(failures(renamed)).toContain(check);
    const unset = structuredClone(compose);
    delete unset.services?.melete?.environment?.MELETE_TRUSTED_PROXY;
    expect(failures(unset)).toContain(check);
    const widened = structuredClone(compose);
    if (widened.services?.web) widened.services.web.networks = ['edge', 'internal'];
    expect(failures(widened)).toContain(check);
  });

  test('assigning the owner API alias to the runtime network is rejected', () => {
    const broken = structuredClone(compose);
    const networks = broken.services?.melete?.networks;
    if (networks && !Array.isArray(networks)) networks.internal = { aliases: ['melete-api'] };
    expect(failures(broken)).toContain('the owner API binds only to its edge network address');
  });
});

describe('the engine configuration the attempt image carries', () => {
  const repositoryRoot = join(import.meta.dir, '..', '..');
  const configPath = join(repositoryRoot, 'packages', 'runtime-hermes', 'config', 'config.yaml');

  test('passes as it stands', () => {
    expect(checkCellConfig(repositoryRoot).filter((result) => !result.ok)).toEqual([]);
  });

  test.each([
    // The engine reads neither of these; a store built from either default
    // reloads what an owner asked to forget.
    ['memory', { enabled: false }],
    ['memory', { memory_enabled: false, user_profile_enabled: true, provider: '' }],
    // Unset means unlimited, which is a loop nobody stops.
    ['agent', {}],
    // Off, and a long conversation is refused instead of summarized.
    ['compression', { enabled: false, in_place: true, threshold_tokens: 200000 }],
    ['compression', { enabled: true, in_place: true }],
    ['checkpoints', { enabled: true }],
    // A terminal the image selects would run in every cell, sandbox or not.
    ['terminal', { backend: 'local', cwd: '/work' }],
    ['platform_toolsets', { api_server: ['melete', 'terminal'] }],
    ['platform_toolsets', { api_server: ['melete', 'terminal_tools'] }],
  ])('catches %s set to %o', (section, replacement) => {
    const directory = mkdtempSync(join(tmpdir(), 'melete-cell-config-'));
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config[section] = replacement;
    mkdirSync(join(directory, 'packages', 'runtime-hermes', 'config'), { recursive: true });
    writeFileSync(
      join(directory, 'packages', 'runtime-hermes', 'config', 'config.yaml'),
      stringify(config),
    );
    try {
      expect(checkCellConfig(directory).filter((result) => !result.ok)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
