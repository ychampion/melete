import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  readdir,
  readFile,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AttemptBundle,
  EventSink,
  RuntimeAdapter,
  RuntimeEvent,
  WaitSpec,
} from '@melete/contracts';
import { stringify } from 'yaml';
import {
  brokerCatalogState,
  HermesRuntimeAdapter,
} from '../packages/runtime-hermes/src/adapter.ts';
import { renderEngineConfig } from '../packages/runtime-hermes/src/engine-config.ts';
import { HERMES_PINNED_COMMIT, RUNTIME_VERSION } from '../packages/runtime-hermes/src/version.ts';
import { LIGHT_ENGINE_VERSION, LightEngine } from './engine.ts';

export const ROOT = resolve(import.meta.dir, '..');
export const PRIVATE = resolve(ROOT, '.eval-state');
const savedDataRoot = resolve(PRIVATE, 'data-root');
export const DATA = resolve(
  process.env.EVALS_DATA_DIR ??
    (existsSync(savedDataRoot)
      ? readFileSync(savedDataRoot, 'utf8').trim()
      : resolve(PRIVATE, 'data')),
);
export const PROJECT = 'melete-evals';
export const DATABASE_CONTAINER = `${PROJECT}-database-1`;
// Separate checkouts may reuse the named eval Postgres without sharing jobs or recovery.
export const DATABASE_NAME = `melete_evals_${createHash('sha256').update(ROOT).digest('hex').slice(0, 12)}`;
export const API_PORT = 19187;
export const BROKER_PORT = 19188;
export type Secrets = {
  database: string;
  capability: string;
  approval: string;
  runtime: string;
  password: string;
};

export async function command(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`${args[0]} ${args[1] ?? ''} exited ${code}: ${err.slice(-1800)}`);
  return out.trim();
}
export async function diskGuard() {
  const stat = await statfs(DATA);
  if (Number(stat.bavail) * Number(stat.bsize) < 1024 ** 3)
    throw new Error('Less than 1 GiB free for evaluation data; stopped without pruning');
  const journal = await statfs(PRIVATE);
  if (Number(journal.bavail) * Number(journal.bsize) < 64 * 1024 ** 2)
    throw new Error('Less than 64 MiB free for the durable journal; stopped without pruning');
}
/** Stage public runtime assets with explicit modes, even under umask 077. */
export async function stageRuntimeAssets(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await chmod(target, 0o755);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const destination = resolve(target, entry.name);
    if (entry.isDirectory()) await stageRuntimeAssets(resolve(source, entry.name), destination);
    else if (entry.isFile()) {
      await copyFile(resolve(source, entry.name), destination);
      await chmod(destination, 0o644);
    } else throw new Error('Runtime assets must not contain symbolic links');
  }
}

/** Which loop executes each attempt: the pinned engine in a container, or the in-process light engine. */
export type EngineKind = 'hermes' | 'light';
export type Stack = {
  engine: EngineKind;
  secrets: Secrets;
  imageId: string;
  gateway: string;
  brokerUrl: string;
  databaseUrl: string;
  compose?: (args: string[], extra?: Record<string, string>) => Promise<string>;
  /** Whether the database outlives this process, so unfinished cells can resume. */
  durable: boolean;
  close?: () => Promise<void>;
};

async function readSecrets(): Promise<Secrets> {
  try {
    return JSON.parse(await readFile(resolve(PRIVATE, 'secrets.json'), 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const token = () => randomBytes(32).toString('hex');
    const secrets = {
      database: token(),
      capability: token(),
      approval: token(),
      runtime: token(),
      password: token(),
    };
    await writeFile(resolve(PRIVATE, 'secrets.json'), JSON.stringify(secrets), {
      mode: 0o600,
      flag: 'wx',
    });
    return secrets;
  }
}

/**
 * The stack without Docker: a disposable database on the repository's test
 * Postgres (DATABASE_URL when set, otherwise the embedded server) and the
 * broker on loopback. The database ends with the process, so a light campaign
 * resumes its finished cells from the journal and reruns unfinished ones.
 */
export async function openLightStack(): Promise<Stack> {
  await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
  const secrets = await readSecrets();
  const { testDatabase } = await import('../apps/melete/test/helpers/database.ts');
  const database = await testDatabase();
  if (!database)
    throw new Error(
      'No Postgres for the light engine: set DATABASE_URL or install embedded Postgres',
    );
  return {
    engine: 'light',
    secrets,
    imageId: LIGHT_ENGINE_VERSION,
    gateway: '127.0.0.1',
    brokerUrl: `http://127.0.0.1:${BROKER_PORT}`,
    databaseUrl: database.url,
    durable: false,
    close: () => database.close(),
  };
}

export async function openStack(): Promise<Stack> {
  await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
  await chmod(PRIVATE, 0o700);
  await mkdir(DATA, { recursive: true, mode: 0o700 });
  if (existsSync(savedDataRoot) && readFileSync(savedDataRoot, 'utf8').trim() !== DATA)
    throw new Error('Evaluation data directory changed; keep the journal and database together');
  await writeFile(savedDataRoot, DATA, { mode: 0o600 });
  let secrets: Secrets;
  try {
    secrets = JSON.parse(await readFile(resolve(PRIVATE, 'secrets.json'), 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const previous = await command([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
    ]);
    if (previous)
      throw new Error(
        'An evals stack exists without this checkout ownership record; refusing to touch it',
      );
    const token = () => randomBytes(32).toString('hex');
    secrets = {
      database: token(),
      capability: token(),
      approval: token(),
      runtime: token(),
      password: token(),
    };
    await writeFile(resolve(PRIVATE, 'secrets.json'), JSON.stringify(secrets), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  // The caller holds the checkout runner lock. Reap only abandoned attempts
  // carrying both this project label and this checkout's Compose ownership.
  const abandoned = await command([
    'docker',
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    `label=com.docker.compose.project.working_dir=${resolve(ROOT, 'evals')}`,
    '--format',
    '{{.Names}}',
  ]);
  for (const name of abandoned.split('\n').filter(Boolean)) {
    if (!/^melete-evals-att_[a-z0-9]+$/.test(name)) continue;
    await command(['docker', 'stop', '-t', '2', name]);
    await command(['docker', 'rm', name]);
  }
  await diskGuard();
  const buildRecord = resolve(PRIVATE, 'runtime-build.json');
  const priorBuild = existsSync(buildRecord)
    ? (JSON.parse(await readFile(buildRecord, 'utf8')) as {
        baseImageId: string;
        sourceHash: string;
        imageId: string;
      })
    : undefined;
  const image =
    process.env.EVALS_RUNTIME_IMAGE ?? priorBuild?.baseImageId ?? 'melete-runtime:local';
  const baseImageId = await command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image]);
  const commit = await command([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--label',
    `com.docker.compose.project=${PROJECT}`,
    '--entrypoint',
    'cat',
    baseImageId,
    '/opt/hermes/.melete-hermes-commit',
  ]);
  if (commit !== HERMES_PINNED_COMMIT)
    throw new Error('Runtime image does not match the pinned Hermes commit');
  const sourceFiles = ['evals/Dockerfile', 'packages/runtime-hermes/.dockerignore'];
  for (const pattern of [
    'packages/runtime-hermes/patches/*.py',
    'packages/runtime-hermes/runtime_support/*.py',
  ])
    for await (const path of new Bun.Glob(pattern).scan(ROOT)) sourceFiles.push(path);
  const sourceHash = createHash('sha256');
  for (const path of sourceFiles.sort())
    sourceHash.update(path).update(await readFile(resolve(ROOT, path)));
  const fingerprint = sourceHash.digest('hex');
  let imageId: string;
  if (priorBuild?.baseImageId === baseImageId && priorBuild.sourceHash === fingerprint) {
    imageId = await command([
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      priorBuild.imageId,
    ]);
  } else {
    const baseTag = `${PROJECT}-base:${baseImageId.slice(7, 19)}`;
    await command(['docker', 'tag', baseImageId, baseTag]);
    await command([
      'docker',
      'build',
      '-f',
      'evals/Dockerfile',
      '--build-arg',
      `EVALS_RUNTIME_BASE=${baseTag}`,
      '-t',
      `${PROJECT}-runtime:local`,
      'packages/runtime-hermes',
    ]);
    imageId = await command([
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      `${PROJECT}-runtime:local`,
    ]);
  }
  // Keep a live reference to the exact image between attempts and process restarts.
  // Rebuilding identical source after cache removal can still yield a new image ID.
  const holder = `${PROJECT}-image-pin`;
  const existingHolder = await command(['docker', 'ps', '-aq', '--filter', `name=^/${holder}$`]);
  if (existingHolder) {
    const info = JSON.parse(await command(['docker', 'inspect', holder]))[0];
    if (
      info.Config.Labels['com.docker.compose.project'] !== PROJECT ||
      info.Config.Labels['com.docker.compose.project.working_dir'] !== resolve(ROOT, 'evals')
    )
      throw new Error('Runtime image holder belongs to another checkout');
    if (info.Image !== imageId) {
      await command(['docker', 'stop', '-t', '2', holder]);
      await command(['docker', 'rm', holder]);
    } else if (!info.State.Running) await command(['docker', 'start', holder]);
  }
  if (!(await command(['docker', 'ps', '-aq', '--filter', `name=^/${holder}$`])))
    await command([
      'docker',
      'run',
      '-d',
      '--name',
      holder,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '32m',
      '--pids-limit',
      '8',
      '--label',
      `com.docker.compose.project=${PROJECT}`,
      '--label',
      `com.docker.compose.project.working_dir=${resolve(ROOT, 'evals')}`,
      '--entrypoint',
      '/bin/sleep',
      imageId,
      'infinity',
    ]);
  await writeFile(buildRecord, JSON.stringify({ baseImageId, sourceHash: fingerprint, imageId }), {
    mode: 0o600,
  });
  const baseEnv = {
    COMPOSE_PROJECT_NAME: PROJECT,
    EVALS_DB_PASSWORD: secrets.database,
    EVALS_RUNTIME_IMAGE: imageId,
    EVALS_DATA_DIR: DATA,
    EVALS_DATABASE_NAME: DATABASE_NAME,
  };
  const compose = (args: string[], extra: Record<string, string> = {}) =>
    command(['docker', 'compose', '-p', PROJECT, '-f', 'evals/compose.yml', ...args], {
      ...baseEnv,
      ...extra,
    });
  await mkdir(resolve(PRIVATE, 'runtime-home'), { recursive: true });
  await chown(resolve(PRIVATE, 'runtime-home'), 10001, 10001);
  await writeFile(
    resolve(PRIVATE, 'runtime-config.yaml'),
    await readFile(resolve(ROOT, 'packages/runtime-hermes/config/config.yaml')),
    { mode: 0o644 },
  );
  await chmod(resolve(PRIVATE, 'runtime-config.yaml'), 0o644);
  await stageRuntimeAssets(
    resolve(ROOT, 'packages/runtime-hermes/melete_plugin'),
    resolve(PRIVATE, 'runtime-assets/melete_plugin'),
  );
  await copyFile(
    resolve(ROOT, 'packages/runtime-hermes/entrypoint.sh'),
    resolve(PRIVATE, 'runtime-assets/entrypoint.sh'),
  );
  await chmod(resolve(PRIVATE, 'runtime-assets/entrypoint.sh'), 0o755);
  await compose(['up', '-d', '--wait', 'database']);
  await compose(['--profile', 'attempt', 'create', 'runtime']);
  const gateway = await command([
    'docker',
    'network',
    'inspect',
    `${PROJECT}_cell`,
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  const brokerUrl = `http://${gateway}:${BROKER_PORT}`;
  return {
    engine: 'hermes' as const,
    durable: true,
    secrets,
    imageId,
    compose,
    brokerUrl,
    gateway,
    databaseUrl: `postgres://evals:${secrets.database}@${await command(['docker', 'inspect', DATABASE_CONTAINER, '--format', `{{(index .NetworkSettings.Networks "${PROJECT}_database").IPAddress}}`])}:5432/${DATABASE_NAME}`,
  };
}

/**
 * Model turns one suite run allows, unless its scenario asks for more. A suite
 * run is short by design, so it keeps a low ceiling rather than the runaway one.
 */
export const DEFAULT_MAX_TURNS = 6;

/** One light engine per attempt, driven by the same adapter the container path uses. */
export class LightRuntime implements RuntimeAdapter {
  observe?: (bundle: AttemptBundle, event: RuntimeEvent) => Promise<void>;
  /** Each tool call an attempt made and its result, for the grader. */
  traceTool?: (
    bundle: AttemptBundle,
    call: { tool: string; args: Record<string, unknown>; result: Record<string, unknown> },
  ) => Promise<void>;
  /** Model turns for the scenario running now; the lab sets it per scenario. */
  maxTurns = DEFAULT_MAX_TURNS;
  constructor(
    readonly stack: Stack,
    readonly parked: (bundle: AttemptBundle) => Promise<string[]>,
    readonly pendingWait?: (bundle: AttemptBundle) => Promise<WaitSpec | null>,
  ) {}
  async capabilities() {
    return { streaming: true, tools: true, interrupt: true, version: LIGHT_ENGINE_VERSION };
  }
  async start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) {
    const serverKey = randomBytes(32).toString('hex');
    const engine = new LightEngine({
      brokerUrl: this.stack.brokerUrl,
      attemptToken: bundle.attempt.token,
      attemptId: bundle.attempt.id,
      jobId: bundle.attempt.job_id,
      provider: bundle.model.provider,
      model: bundle.model.model,
      serverKey,
      // The same per-run ceilings the container path renders for a suite run.
      maxTurns: this.maxTurns,
      maxTokens: 4096,
      ...(this.traceTool ? { onTool: (call) => this.traceTool?.(bundle, call) } : {}),
    });
    const baseUrl = engine.start();
    try {
      const adapter = new HermesRuntimeAdapter({
        baseUrl,
        token: serverKey,
        parkedActions: this.parked,
        pendingWait: this.pendingWait,
        catalogState: brokerCatalogState({ brokerUrl: this.stack.brokerUrl }),
      });
      await adapter.capabilities();
      return await adapter.start(
        bundle,
        {
          emit: async (event) => {
            await this.observe?.(bundle, event);
            await sink.emit(event);
          },
        },
        signal,
      );
    } finally {
      await engine.stop();
    }
  }
}

/** Lifecycle glue: every model turn is executed by the pinned engine and checked observer bridge. */
export class ContainerRuntime implements RuntimeAdapter {
  last: { job: string; events: unknown[]; output: string } | null = null;
  observe?: (bundle: AttemptBundle, event: RuntimeEvent) => Promise<void>;
  /** Model turns for the scenario running now; the lab sets it per scenario. */
  maxTurns = DEFAULT_MAX_TURNS;
  constructor(
    readonly stack: Stack,
    readonly parked: (bundle: AttemptBundle) => Promise<string[]>,
    readonly pendingWait?: (bundle: AttemptBundle) => Promise<WaitSpec | null>,
  ) {}
  async capabilities() {
    return { streaming: true, tools: true, interrupt: true, version: RUNTIME_VERSION };
  }
  async start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) {
    await diskGuard();
    const home = resolve(DATA, 'homes', bundle.attempt.job_id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chown(home, 10001, 10001);
    // The same renderer the image and the supervisors use, with the suite's turn
    // ceiling rather than the runaway one.
    const config = renderEngineConfig({
      provider: bundle.model.provider,
      model: bundle.model.model,
      brokerUrl: this.stack.brokerUrl,
      maxTurns: this.maxTurns,
    }) as Record<string, Record<string, unknown>>;
    (config.model as Record<string, unknown>).max_tokens = 4096;
    const configPath = resolve(PRIVATE, `config-${bundle.attempt.id}.yaml`);
    const runtimeKey = randomBytes(32).toString('hex');
    const containerName = `${PROJECT}-${bundle.attempt.id.toLowerCase()}`;
    if (!/^melete-evals-att_[a-z0-9]+$/.test(containerName))
      throw new Error('Invalid attempt container identity');
    await writeFile(configPath, stringify(config), { mode: 0o644 });
    await chmod(configPath, 0o644);
    const env = {
      EVALS_RUNTIME_KEY: runtimeKey,
      EVALS_BROKER_URL: this.stack.brokerUrl,
      EVALS_ATTEMPT_TOKEN: bundle.attempt.token,
      EVALS_ATTEMPT_ID: bundle.attempt.id,
      EVALS_JOB_ID: bundle.attempt.job_id,
      EVALS_MODEL_PROVIDER: bundle.model.provider,
      EVALS_MODEL_NAME: bundle.model.model,
      EVALS_HOME: home,
      EVALS_CONFIG: configPath,
    };
    const events: unknown[] = [];
    let output = '';
    this.last = { job: bundle.attempt.job_id, events, output };
    const compose = this.stack.compose;
    if (!compose) throw new Error('The container runtime needs the Compose stack');
    try {
      await compose(
        ['--profile', 'attempt', 'run', '-d', '--no-deps', '--name', containerName, 'runtime'],
        env,
      );
      const address = await command([
        'docker',
        'inspect',
        containerName,
        '--format',
        `{{(index .NetworkSettings.Networks "${PROJECT}_cell").IPAddress}}`,
      ]);
      const adapter = new HermesRuntimeAdapter({
        baseUrl: `http://${address}:8790`,
        token: runtimeKey,
        parkedActions: this.parked,
        pendingWait: this.pendingWait,
        catalogState: brokerCatalogState({ brokerUrl: this.stack.brokerUrl }),
      });
      const deadline = Date.now() + 60_000;
      for (;;) {
        signal.throwIfAborted();
        try {
          await adapter.capabilities();
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('Pinned runtime did not become ready');
        }
        await Bun.sleep(250);
      }
      const outcome = await adapter.start(
        bundle,
        {
          emit: async (event) => {
            await this.observe?.(bundle, event);
            events.push(event);
            if (event.type === 'text_delta') output += event.text;
            if (event.type === 'attempt_outcome' && 'summary' in event.outcome)
              output = event.outcome.summary;
            this.last = { job: bundle.attempt.job_id, events, output };
            await sink.emit(event);
          },
        },
        signal,
      );
      return outcome;
    } finally {
      // Only the container created for this attempt is eligible for cleanup.
      await command(['docker', 'stop', '-t', '2', containerName]).catch(() => undefined);
      await command(['docker', 'rm', containerName]).catch(() => undefined);
    }
  }
}
