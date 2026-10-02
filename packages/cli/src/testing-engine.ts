/**
 * A fake Docker engine, registry, git checkout and database for the deploy and
 * rollback tests. Unlike the prefix table in testing.ts it keeps state: a pull
 * puts the registry's image on the engine and takes disk, `up` and `restart`
 * are counted, and `git checkout` moves HEAD. Every command is recorded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import type { Check } from '../../../deploy/scripts/status.ts';
import { fileReplacer } from '../../../deploy/scripts/tailscale-origin.ts';
import type { DeployDependencies } from './commands/deploy.ts';
import type { Context } from './context.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { REAL_DEPLOY_DIR, type TestContext, testContext, writeEnv } from './testing.ts';

const MB = 1024 ** 2;
export const POSTGRES =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
export const REGISTRY = 'ghcr.io/ychampion';
export const RELEASES = ['melete-service', 'melete-runtime', 'melete-web'] as const;

/** The journal times of a release with this many migrations: one per index, in order. */
export const whens = (count: number) =>
  Array.from({ length: count }, (_, index) => 1_789_232_400_000 + index);

export const OLD = 'a'.repeat(40);
export const NEW = 'b'.repeat(40);

export type Image = {
  id: string;
  repoDigests: string[];
  layers: string[];
  revision: string | null;
};
export type Published = {
  digest: string;
  revision: string;
  layers: { diffId: string; size: number }[];
};

export type Engine = {
  local: Map<string, Image>;
  registry: Map<string, Published>;
  /** Images no tag names, by id. */
  dangling: Image[];
  freeBytes: number;
  /** Disk a pull takes, per compressed byte. */
  pullCost: number;
  head: string;
  branch: string | null;
  /** Commits the checkout has, with their journal's migration count. */
  commits: Map<string, number>;
  dirty: string[];
  /** Journal times of the migrations the database records. */
  recorded: number[];
  databaseBytes: number;
  /** A pull of a reference starting with one of these fails. */
  failPulls: string[];
  failUp: boolean;
  /** Whether starting the service records its journal's migrations. */
  migrateOnUp: boolean;
  ups: number;
  restarts: number;
  pulls: string[];
  removed: string[];
  tagged: string[][];
  /** Migrations `up` records: the journal count of HEAD. */
  calls: string[];
};

/** The image a commit's release publishes: three layers, one shared by every image. */
export function release(name: string, revision: string, sizeMb = 100): Published {
  return {
    digest: `sha256:${name}-${revision.slice(0, 7)}`,
    revision,
    layers: [
      { diffId: 'sha256:base', size: 30 * MB },
      { diffId: `sha256:${name}-deps`, size: 20 * MB },
      { diffId: `sha256:${name}-${revision.slice(0, 7)}`, size: sizeMb * MB },
    ],
  };
}

const asLocal = (ref: string, published: Published): Image => ({
  id: published.digest,
  repoDigests: [`${ref.split(':').slice(0, -1).join(':')}@${published.digest}`],
  layers: published.layers.map((layer) => layer.diffId),
  revision: published.revision,
});

/** An engine running `main` built from OLD, with NEW published as main and as its commit tag. */
export function engine(overrides: Partial<Engine> = {}): Engine {
  const registry = new Map<string, Published>();
  const local = new Map<string, Image>();
  for (const name of RELEASES) {
    const old = release(name, OLD);
    const next = release(name, NEW);
    registry.set(`${REGISTRY}/${name}:${OLD.slice(0, 7)}`, old);
    registry.set(`${REGISTRY}/${name}:${NEW.slice(0, 7)}`, next);
    registry.set(`${REGISTRY}/${name}:main`, next);
    local.set(`${REGISTRY}/${name}:main`, asLocal(`${REGISTRY}/${name}:main`, old));
  }
  local.set(POSTGRES, { id: 'sha256:pg', repoDigests: [], layers: ['sha256:pg'], revision: null });
  return {
    local,
    registry,
    dangling: [],
    freeBytes: 2000 * MB,
    pullCost: 1,
    head: OLD,
    branch: 'main',
    commits: new Map([
      [OLD, 68],
      [NEW, 68],
    ]),
    dirty: [],
    recorded: whens(68),
    databaseBytes: 40 * MB,
    failPulls: [],
    failUp: false,
    migrateOnUp: true,
    ups: 0,
    restarts: 0,
    pulls: [],
    removed: [],
    tagged: [],
    calls: [],
    ...overrides,
  };
}

const ok = (stdout = ''): CommandOutput => ({ code: 0, stdout, stderr: '' });
const no = (stderr = 'not found'): CommandOutput => ({ code: 1, stdout: '', stderr });

/** The command without Compose's -f and --profile pairs, as one line. */
export function line(command: readonly string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index] ?? '';
    if (
      (part === '-f' || part === '--profile') &&
      command[0] === 'docker' &&
      command[1] === 'compose'
    ) {
      index += 1;
      continue;
    }
    parts.push(part);
  }
  return parts.join(' ');
}

function inspectJson(image: Image) {
  return JSON.stringify({
    Id: image.id,
    RepoDigests: image.repoDigests,
    RootFS: { Layers: image.layers },
    Config: {
      Labels: image.revision ? { 'org.opencontainers.image.revision': image.revision } : {},
    },
  });
}

export function engineRun(state: Engine, root: string) {
  return (command: readonly string[]): CommandOutput => {
    const text = line(command);
    state.calls.push(text);
    if (text === 'docker info --format {{json .}}')
      return ok(JSON.stringify({ Architecture: 'x86_64', DockerRootDir: '/no/such/docker-root' }));
    if (text === 'docker info --format {{.DockerRootDir}}') return ok('/no/such/docker-root\n');
    if (text.startsWith('docker run --rm --network none -v /no/such/docker-root:/docker-root:ro'))
      return ok(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000000 1 ${Math.floor(state.freeBytes / 1024)} 99% /docker-root\n`,
      );
    if (text.startsWith('docker image inspect --format {{json .}} ')) {
      const ref = text.slice('docker image inspect --format {{json .}} '.length);
      const image =
        state.local.get(ref) ??
        [...state.local.values(), ...state.dangling].find((candidate) => candidate.id === ref);
      return image ? ok(inspectJson(image)) : no();
    }
    if (text.startsWith('docker image inspect --format {{.Id}} ')) {
      const image = state.local.get(text.split(' ').at(-1) ?? '');
      return image ? ok(image.id) : no();
    }
    if (text.startsWith('docker buildx imagetools inspect ')) {
      const ref = command[4] ?? '';
      const published = state.registry.get(ref);
      if (!published) return no(`ERROR: ${ref}: not found`);
      if (text.endsWith('{{json .Manifest}}'))
        return ok(
          JSON.stringify({
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: published.digest,
            layers: published.layers.map((layer) => ({ size: layer.size })),
          }),
        );
      return ok(
        JSON.stringify({
          config: { Labels: { 'org.opencontainers.image.revision': published.revision } },
          rootfs: { diff_ids: published.layers.map((layer) => layer.diffId) },
        }),
      );
    }
    if (text.startsWith('docker images --no-trunc --format {{.ID}} ')) {
      const repository = text.split(' ').at(-1) ?? '';
      return ok(
        [...state.local.entries()]
          .filter(([ref]) => ref.startsWith(`${repository}:`))
          .map(([, image]) => image.id)
          .join('\n'),
      );
    }
    if (text === 'docker images --filter dangling=true --no-trunc --format {{.ID}}')
      return ok(state.dangling.map((image) => image.id).join('\n'));
    if (text.startsWith('docker image rm ')) {
      const id = text.split(' ').at(-1) ?? '';
      state.removed.push(id);
      state.dangling = state.dangling.filter((image) => image.id !== id);
      return ok();
    }
    if (text.startsWith('docker pull --quiet ')) {
      const ref = text.split(' ').at(-1) ?? '';
      state.pulls.push(ref);
      if (state.failPulls.some((prefix) => ref.startsWith(prefix)))
        return no('pull failed: unexpected EOF');
      const published = state.registry.get(ref);
      if (!published) return no('manifest unknown');
      const known = new Set([...state.local.values()].flatMap((image) => image.layers));
      const bytes = published.layers
        .filter((layer) => !known.has(layer.diffId))
        .reduce((total, layer) => total + layer.size, 0);
      state.freeBytes -= Math.ceil(bytes * state.pullCost);
      state.local.set(ref, asLocal(ref, published));
      return ok(ref);
    }
    if (text.startsWith('docker tag ')) {
      state.tagged.push(command.slice(2) as string[]);
      return ok();
    }
    if (text.startsWith('docker compose ') && text.includes(' up -d ')) {
      state.ups += 1;
      if (state.failUp)
        return no('dependency failed to start: container melete-melete-1 is unhealthy');
      if (state.migrateOnUp)
        state.recorded = [
          ...new Set([...state.recorded, ...whens(state.commits.get(state.head) ?? 0)]),
        ];
      return ok();
    }
    if (text.startsWith('docker compose restart melete')) {
      state.restarts += 1;
      return ok();
    }
    if (text.includes('select created_at from drizzle.__drizzle_migrations'))
      return ok(`${[...state.recorded].sort((a, b) => a - b).join('\n')}\n`);
    if (text.includes('select pg_database_size')) return ok(`${state.databaseBytes}\n`);
    if (text.startsWith(`git -C ${root} `)) return gitRun(state, command.slice(3));
    return no('no such command in this test');
  };
}

function gitRun(state: Engine, args: readonly string[]): CommandOutput {
  const [verb, ...rest] = args;
  const text = args.join(' ');
  if (text === 'rev-parse HEAD') return ok(`${state.head}\n`);
  if (verb === 'cat-file')
    return state.commits.has((rest[1] ?? '').replace('^{commit}', '')) ? ok() : no();
  if (verb === 'fetch') return ok();
  if (verb === 'status') return ok(state.dirty.map((path) => ` M ${path}`).join('\n'));
  if (text === 'symbolic-ref --quiet --short HEAD')
    return state.branch ? ok(`${state.branch}\n`) : no();
  if (verb === 'show') {
    const [commit, path] = (rest[0] ?? '').split(':');
    if (!commit || !state.commits.has(commit)) return no('bad revision');
    if (path === 'apps/melete/drizzle/meta/_journal.json')
      return ok(
        JSON.stringify({
          entries: whens(state.commits.get(commit) ?? 0).map((when) => ({ when })),
        }),
      );
    if (path?.startsWith('deploy/'))
      return ok(readFileSync(join(REAL_DEPLOY_DIR, path.slice(7)), 'utf8'));
    return no('no such path');
  }
  if (verb === 'rev-parse' && rest[0] === '--verify')
    // The checkout has one branch, main, at OLD.
    return rest.at(-1) === 'refs/heads/main' ? ok(`${OLD}\n`) : no();
  if (verb === 'checkout' || verb === '-c') {
    const target = args.at(-1) ?? '';
    if (state.commits.has(target)) {
      state.head = target;
      state.branch = null;
    } else if (target === 'main') {
      state.head = OLD;
      state.branch = 'main';
    } else return no('pathspec did not match');
    return ok();
  }
  return no(`git ${text} is not faked`);
}

export type DeployRig = {
  state: Engine;
  context: TestContext;
  dependencies: DeployDependencies;
  /** Status checks before the deploy and after it. */
  statusBefore: Check[];
  statusAfter: Check[];
  envBefore: string;
};

/** A deploy/ directory running `main` from OLD with a contract, and a fake engine around it. */
export function deployRig(
  deployDir: string,
  overrides: Partial<Engine> = {},
  contract: object = {},
): DeployRig {
  const envBefore = writeEnv(deployDir);
  writeFileSync(
    join(deployDir, DEPLOY_FILE),
    JSON.stringify({ contract: 1, disk: { min_free_mb: 600, pull_margin_mb: 200 }, ...contract }),
  );
  const state = engine(overrides);
  const base = testContext(deployDir);
  const health = { status: 'ok', database: 'ok' };
  const context: TestContext = {
    ...base,
    run: engineRun(state, base.root),
    fetch: async () => Response.json(health),
  };
  let calls = 0;
  const rig: DeployRig = {
    state,
    context,
    statusBefore: [{ level: 'ok', name: 'Services', detail: 'healthy' }],
    statusAfter: [{ level: 'ok', name: 'Services', detail: 'healthy' }],
    envBefore,
    dependencies: {
      file: fileReplacer,
      status: async (_context: Context) => {
        calls += 1;
        return calls === 1 ? rig.statusBefore : rig.statusAfter;
      },
    },
  };
  return rig;
}
