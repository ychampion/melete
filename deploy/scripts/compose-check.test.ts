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
    if (runtime) runtime.volumes = ['spaces:/work', '/var/run/docker.sock:/var/run/docker.sock'];
    expect(failures(broken)).toContain('the runtime mounts nothing but /work');
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

  test('removing the runtime service altogether', () => {
    const broken: ComposeFile = structuredClone(compose);
    if (broken.services) delete broken.services.runtime;
    expect(failures(broken)).toContain('the runtime service exists');
  });
});
