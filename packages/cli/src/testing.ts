/**
 * A context for tests: a temporary deployment directory holding copies of the
 * real Compose files, a fake Docker that answers from a table and records every
 * command, and captured output.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import type { Context, Endpoint, Source, StreamResult } from './context.ts';

export const REAL_DEPLOY_DIR = resolve(import.meta.dir, '../../../deploy');

/** A deploy/ directory in a fresh temporary checkout, with the release's Compose files. */
export function temporaryDeployDir(): string {
  const deployDir = join(mkdtempSync(join(tmpdir(), 'melete-cli-')), 'deploy');
  mkdirSync(deployDir);
  for (const file of readdirSync(REAL_DEPLOY_DIR))
    if (/^docker-compose.*\.yml$/.test(file) || file === '.env.example')
      copyFileSync(join(REAL_DEPLOY_DIR, file), join(deployDir, file));
  return deployDir;
}

/** A deploy/.env as configure.ts writes one, with a real provider key, and any overrides. */
export function writeEnv(deployDir: string, overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'melete',
    MELETE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    MELETE_CAPABILITY_KEY: 'a'.repeat(64),
    MELETE_APPROVAL_KEY: 'b'.repeat(64),
    MELETE_RUNTIME_KEY: 'c'.repeat(64),
    DOCKER_GID: '999',
    POSTGRES_USER: 'melete',
    POSTGRES_PASSWORD: 'd'.repeat(48),
    POSTGRES_DB: 'melete',
    DATABASE_URL: `postgres://melete:${'d'.repeat(48)}@postgres:5432/melete`,
    MELETE_IMAGE_TAG: 'main',
    MELETE_IMAGE_REGISTRY: '',
    MELETE_PORT: '3100',
    WEB_PORT: '3101',
    MELETE_DEFAULT_PROVIDER: 'anthropic',
    MELETE_DEFAULT_MODEL: 'a-model',
    ANTHROPIC_API_KEY: 'sk-test-value',
    MELETE_ENABLE_FAKE_PROVIDER: 'false',
    MELETE_ENABLE_TEST_CONNECTOR: 'false',
    ...overrides,
  };
  const text = `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
  writeFileSync(join(deployDir, '.env'), text, { mode: 0o600 });
  return text;
}

export type FakeDocker = {
  /** Answers by the first rule whose prefix the command starts with. */
  rules: [prefix: string, output: Partial<CommandOutput>][];
  calls: string[][];
};

export const ok = (stdout = ''): Partial<CommandOutput> => ({ code: 0, stdout });

/** The engine and Compose answers of a supported Linux host. */
export const SUPPORTED_HOST: FakeDocker['rules'] = [
  ['docker version', ok('1.51 28.3.0')],
  ['docker compose version', ok('2.39.1')],
  [
    'docker info --format {{json .}}',
    ok(
      JSON.stringify({
        OSType: 'linux',
        OperatingSystem: 'Ubuntu 24.04',
        KernelVersion: '6.8.0',
        MemTotal: 8 * 1024 ** 3,
        DockerRootDir: '/var/lib/docker',
      }),
    ),
  ],
  ['docker context inspect', ok('unix:///var/run/docker.sock')],
];

export type StreamCall = { source: Source; sinks: readonly Endpoint[] };

/**
 * A stream that writes to file sinks for real (new, 0600) and records command
 * sinks. A command source yields `streamed <command>` unless `streamFails`
 * names a prefix of it or of a sink command.
 */
export function fakeStream(calls: StreamCall[], fails: () => readonly string[]) {
  return async (source: Source, sinks: readonly Endpoint[]): Promise<StreamResult> => {
    calls.push({ source, sinks });
    const commands = [
      ...('command' in source ? [source.command.join(' ')] : []),
      ...sinks.flatMap((sink) => ('command' in sink ? [sink.command.join(' ')] : [])),
    ];
    const failing = fails().find((part) => commands.some((line) => line.includes(part)));
    if (failing)
      return {
        ok: false,
        bytes: 0,
        sha256: '',
        detail: `${failing} exited 1: it failed in this test`,
      };
    const bytes =
      'bytes' in source
        ? Buffer.from(source.bytes)
        : 'file' in source
          ? readFileSync(source.file)
          : Buffer.from(`streamed ${source.command.join(' ')}`);
    for (const sink of sinks)
      if ('file' in sink) {
        const fd = openSync(sink.file, 'wx', 0o600);
        writeSync(fd, bytes);
        closeSync(fd);
      }
    return {
      ok: true,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      detail: '',
    };
  };
}

export type TestContext = Context & {
  docker: FakeDocker;
  streams: StreamCall[];
  /** Text that, found in the source or a sink command, makes the stream fail. */
  streamFails: string[];
  slept: number[];
  printed: () => string;
  errors: () => string;
  attached: string[][];
};

export function testContext(
  deployDir: string,
  rules: FakeDocker['rules'] = [],
  overrides: Partial<Context> = {},
): TestContext {
  const docker: FakeDocker = { rules: [...rules, ...SUPPORTED_HOST], calls: [] };
  const out: string[] = [];
  const err: string[] = [];
  const attached: string[][] = [];
  const streams: StreamCall[] = [];
  const streamFails: string[] = [];
  const slept: number[] = [];
  return {
    deployDir,
    root: resolve(deployDir, '..'),
    run: (command) => {
      docker.calls.push([...command]);
      const line = command.join(' ');
      const rule = docker.rules.find(([prefix]) => line.startsWith(prefix));
      return { code: 1, stdout: '', stderr: 'no such command in this test', ...rule?.[1] };
    },
    attach: async (command) => {
      attached.push([...command]);
      return 0;
    },
    machine: {
      platform: 'linux',
      env: {},
      exists: () => false,
      installed: () => [],
    },
    probePort: async () => 'free',
    fetch: async () => new Response(null, { status: 401 }),
    stream: fakeStream(streams, () => streamFails),
    freeAt: () => 50 * 1024 ** 3,
    sameDisk: () => true,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => new Date('2026-10-02T10:00:00Z'),
    streams,
    streamFails,
    slept,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    docker,
    printed: () => out.join(''),
    errors: () => err.join(''),
    attached,
    ...overrides,
  };
}

/** Docker commands that change something. A read-only command never starts with one of these. */
export const CHANGING = [
  'docker compose up',
  'docker compose pull',
  'docker compose down',
  'docker compose restart',
  'docker compose rm',
  'docker compose stop',
  'docker rm',
  'docker run',
  'docker pull',
  'docker image prune',
  'docker image rm',
  'docker rmi',
  'docker volume',
  'docker network',
  'docker tag',
];

/** The calls that changed something; `docker compose -f ... up` counts. */
export function changingCalls(calls: readonly string[][]): string[] {
  return calls
    .map((call) => call.filter((part, index) => !(call[index - 1] === '-f' || part === '-f')))
    .map((call) =>
      call.filter((part, index) => !(call[index - 1] === '--profile' || part === '--profile')),
    )
    .map((call) => call.join(' '))
    .filter((line) => CHANGING.some((prefix) => line.startsWith(prefix)));
}
