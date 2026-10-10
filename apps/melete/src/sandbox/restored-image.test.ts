/**
 * The image a default computer is made from is the one the operator configures
 * now, the only one melete-cells lets an agent's computer run. A space's
 * default sandbox connection was stored with the image of the release that
 * furnished it; restored onto a machine installed at another release, or
 * after an update that named another image, the computers it opens, and the
 * ones made again on their kept volumes, must ask for the current image.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { type CellsLookup, type CellsPolicyConfig, judge } from '../cells/policy.ts';
import { builtinEnvironment, ensureBuiltinConnections } from '../connectors/builtin.ts';
import { DockerError } from '../runtime/docker.ts';
import {
  DOCKER_SANDBOX_DEFAULTS,
  type DockerSandboxApi,
  DockerSandboxHost,
} from './adapters/docker.ts';
import { SandboxEgressGuard } from './adapters/docker-egress.ts';
import { FakeDocker } from './adapters/docker-fixtures.ts';
import { sandboxSpecFor, storedSandboxConnection } from './connection.ts';
import { seedSessionScope } from './session-fixtures.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const signal = () => AbortSignal.timeout(10_000);
const PROJECT = 'melete-ab12cd34';
const OLD = 'ghcr.io/ychampion/melete-sandbox:0.2.10';
const NEW = 'ghcr.io/ychampion/melete-sandbox:0.2.15';
const OLD_ID = `sha256:${'1'.repeat(64)}`;
const NEW_ID = `sha256:${'2'.repeat(64)}`;

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close());

/** The in-memory engine behind melete-cells: every request is judged by its policy first. */
function throughCells(engine: FakeDocker, sandboxImage: string): DockerSandboxApi {
  const config: CellsPolicyConfig = {
    project: 'melete',
    sandboxProject: PROJECT,
    runtimeImage: 'melete-runtime:local',
    sandboxImage,
    mcpImages: [],
    workVolume: 'melete_work',
  };
  const lookup: CellsLookup = {
    async container(id) {
      const found =
        engine.containers.get(id) ?? [...engine.containers.values()].find((each) => each.id === id);
      return found
        ? {
            Id: found.id ?? `${found.name}-id`,
            Name: `/${found.name}`,
            Config: { Labels: found.labels },
          }
        : null;
    },
    async network(id) {
      const found = engine.networks.get(id);
      return found ? { Id: id, Name: id, Internal: true, Labels: found.labels } : null;
    },
    async volume(name) {
      const labels = engine.volumes.get(name);
      return labels ? { Name: name, Labels: labels } : null;
    },
    async image(reference) {
      return engine.images.has(reference)
        ? { Id: engine.imageIds.get(reference) ?? 'sha256:image', RepoDigests: [] }
        : null;
    },
    async exec(id) {
      const found = engine.execs.get(id);
      return found ? { ContainerID: found.container } : null;
    },
  };
  return {
    async request(method, path, body) {
      const [route = '', query = ''] = path.split('?');
      const verdict = await judge(
        { method, path: route, query: new URLSearchParams(query), body },
        config,
        lookup,
      );
      if (!verdict.allow)
        throw new DockerError(verdict.status, method, `${route} (${verdict.reason})`);
      return engine.request(method, path, body);
    },
    startExec: (id, s) => engine.startExec(id, s),
    putArchive: (container, path, tar) => engine.putArchive(container, path, tar),
  };
}

withDb("a default computer and the operator's image", () => {
  const environment = (image: string) =>
    builtinEnvironment({
      MELETE_RUNTIME_ADAPTER: 'docker',
      MELETE_RUNTIME_SUPERVISOR: 'docker',
      MELETE_SANDBOX_PROVIDER: 'docker',
      MELETE_SANDBOX_PROJECT: PROJECT,
      MELETE_SANDBOX_DOCKER_IMAGE: image,
      MELETE_SANDBOX_DOCKER_EGRESS: 'deny_all',
    });
  /** The space's default sandbox connection, as the service opens it. */
  const stored = async (spaceId: string) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const [row] = await handle.sql`select id, configuration from connection
      where space_id = ${spaceId} and provider = 'sandbox'`;
    if (!row) throw new Error('the space has no default sandbox');
    return { id: String(row.id), config: storedSandboxConnection.parse(row.configuration).sandbox };
  };
  const host = (engine: FakeDocker, configured: string) => {
    const guard = new SandboxEgressGuard();
    guard.listen = async () => 0;
    return new DockerSandboxHost(
      { socket: '/var/run/docker.sock', project: PROJECT, ...DOCKER_SANDBOX_DEFAULTS },
      throughCells(engine, configured),
      { guard },
    );
  };

  test('a computer restored onto a machine at another release is made again from its image, on its volumes', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    // The old machine furnished the space under the image it ran.
    await ensureBuiltinConnections(sql, environment(OLD), scope.spaceId);
    const before = await stored(scope.spaceId);
    expect(before.config.image).toBe(OLD);
    const engine = new FakeDocker();
    engine.images.add(OLD);
    engine.imageIds.set(OLD, OLD_ID);
    const spec = (config: typeof before.config, session: string) =>
      sandboxSpecFor(config, {
        project: PROJECT,
        connectionId: before.id,
        spaceId: scope.spaceId,
        session,
      });
    const made = await host(engine, OLD).create(spec(before.config, 'sbx_one'), signal());
    const name = made.providerSandboxId;
    const volumes = structuredClone([...engine.volumes]);

    // The new machine runs the next release; the restore brings back the
    // database and the computer's volumes, never its container. The old image
    // may still be on the engine (an update in place) or not (a new machine).
    for (const oldImageKept of [true, false]) {
      engine.containers.clear();
      if (!oldImageKept) engine.images.delete(OLD);
      engine.images.add(NEW);
      engine.imageIds.set(NEW, NEW_ID);
      const restored = host(engine, NEW);
      // The service starts: its defaults are brought up to this release.
      await ensureBuiltinConnections(sql, environment(NEW));
      const after = await stored(scope.spaceId);
      expect(after.config).toEqual({ ...before.config, image: NEW });
      const resumed = await restored.resume(name, spec(after.config, 'sbx_two'), signal());
      expect(resumed).toMatchObject({ providerSandboxId: name, imageDigest: NEW_ID });
      expect(engine.containers.get(name)).toMatchObject({ image: NEW_ID, running: true });
      expect([...engine.volumes]).toEqual(volumes);
    }
  });

  test("melete-cells refuses a computer made from any image but the operator's", async () => {
    // What the service sent before its default followed the configured image.
    const engine = new FakeDocker();
    for (const [image, id] of [
      [OLD, OLD_ID],
      [NEW, NEW_ID],
    ] as const) {
      engine.images.add(image);
      engine.imageIds.set(image, id);
    }
    const spec = sandboxSpecFor(
      {
        adapter: 'docker',
        image: OLD,
        egress: 'deny_all',
        persistence: 'pause',
        lifetime_seconds: 3600,
      },
      { project: PROJECT, connectionId: 'conn_one', spaceId: 'sp_one', session: 'sbx_one' },
    );
    await expect(host(engine, NEW).create(spec, signal())).rejects.toThrow(
      'the sandbox profile runs only the image the operator configured',
    );
    // The same name by its digest is the same image, and is accepted.
    engine.images.add(`ghcr.io/ychampion/melete-sandbox@${NEW_ID}`);
    engine.imageIds.set(`ghcr.io/ychampion/melete-sandbox@${NEW_ID}`, NEW_ID);
    const pinned = { ...spec, image: `ghcr.io/ychampion/melete-sandbox@${NEW_ID}` };
    await host(engine, NEW).create(pinned, signal());
  });

  test('a default someone revoked, or a sandbox a person added, keeps the image it names', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    await ensureBuiltinConnections(sql, environment(OLD), scope.spaceId);
    const { id } = await stored(scope.spaceId);
    await sql`update connection set status = 'revoked' where id = ${id}`;
    await ensureBuiltinConnections(sql, environment(NEW));
    expect((await stored(scope.spaceId)).config.image).toBe(OLD);
    // A connection a person made is theirs, whatever image it names.
    await sql`update connection set status = 'active',
        configuration = configuration - 'builtin' where id = ${id}`;
    await ensureBuiltinConnections(sql, environment(NEW));
    expect((await stored(scope.spaceId)).config.image).toBe(OLD);
  });
});
