import { describe, expect, test } from 'bun:test';
import {
  type ComposeFile,
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

  test('assigning the owner API alias to the runtime network is rejected', () => {
    const broken = structuredClone(compose);
    const networks = broken.services?.melete?.networks;
    if (networks && !Array.isArray(networks)) networks.internal = { aliases: ['melete-api'] };
    expect(failures(broken)).toContain('the owner API binds only to its edge network address');
  });
});
