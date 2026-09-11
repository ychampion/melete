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
  test('passes every boundary check', () => {
    expect(failures(compose)).toEqual([]);
  });

  test('declares the internal network as internal', () => {
    expect(compose.networks?.internal?.internal).toBe(true);
  });
});

describe('the check catches the mistakes that would matter', () => {
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

  test('removing the runtime service altogether', () => {
    const broken: ComposeFile = structuredClone(compose);
    if (broken.services) delete broken.services.runtime;
    expect(failures(broken)).toContain('the runtime service exists');
  });
});
