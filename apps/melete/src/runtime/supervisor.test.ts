import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import { parse } from 'yaml';
import { resolvePython } from './python.ts';
import {
  attemptEnvironment,
  DockerRuntimeSupervisor,
  dockerRunArguments,
  jobWorkspace,
  ProcessRuntimeSupervisor,
  platformEnvironment,
  type SupervisorOptions,
  stopProcessTree,
} from './supervisor.ts';

const bundle: AttemptBundle = {
  attempt: {
    id: 'att_01J00000000000000000000000',
    job_id: 'job_01J00000000000000000000000',
    epoch: 1,
    revision: 0,
    token: 'attempt-secret',
  },
  job: {
    title: 'Test',
    objective: 'Test',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  since_last: EMPTY_SINCE_LAST,
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  tools: [],
  skills: [],
  knowledge: [],
  transcript: [],
  workspace: { mount: '/work', files: [] },
  model: { provider: 'fake', model: 'scripted', fallback: null },
  budget: { max_turns: 2, max_actions: 1, max_output_tokens: 2000, max_wall_ms: 10000 },
};
const options: SupervisorOptions = {
  workRoot: 'unused',
  brokerUrl: 'http://melete:8788',
  engineRoot: 'unused',
  python: 'unused',
  runtimePackage: 'unused',
  dockerImage: 'melete-runtime:local',
  dockerNetwork: 'melete_internal',
  dockerWorkVolume: 'melete_work',
};

describe('runtime launch boundaries', () => {
  test('process startup hands the child the rendered engine configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'melete-process-config-'));
    const runtimePackage = join(root, 'runtime');
    const supervisor = new ProcessRuntimeSupervisor({
      ...options,
      engineRoot: join(root, 'engine'),
      runtimePackage,
      workRoot: join(root, 'work'),
      python: resolvePython(),
      startupTimeoutMs: 5000,
    });
    try {
      await mkdir(join(root, 'engine', '.git'), { recursive: true });
      await writeFile(join(root, 'engine', '.git', 'HEAD'), HERMES_PINNED_COMMIT);
      await mkdir(join(runtimePackage, 'patches'), { recursive: true });
      await mkdir(join(runtimePackage, 'melete_plugin'));
      await writeFile(join(runtimePackage, 'patches', 'observer_bridge.py'), '# Fixture only.\n');
      // A loopback-only stand-in returns the exact configuration the child received.
      await writeFile(
        join(runtimePackage, 'process_launcher.py'),
        `import http.server, json, os, pathlib
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = (pathlib.Path(os.environ['HERMES_HOME']) / 'config.yaml').read_bytes()
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
pathlib.Path(os.environ['MELETE_RUNTIME_ADDRESS_FILE']).write_text(json.dumps({'port': server.server_port}))
server.serve_forever()
`,
      );
      const instance = await supervisor.launch(bundle, new AbortController().signal);
      const response = await fetch(`${instance.baseUrl}/config`);
      const config = parse(await response.text());
      expect(config.provider).toBeUndefined();
      // The capability sits in both places: the main agent reads the provider
      // entry, the compaction summary client reads the model section.
      expect(config.model).toEqual({
        provider: 'melete-gateway',
        default: 'scripted',
        context_length: 128_000,
        extra_headers: { 'x-melete-capability': bundle.attempt.token },
      });
      expect(Object.keys(config.providers)).toEqual(['melete-gateway']);
      expect(config.providers['melete-gateway']).toMatchObject({
        base_url: 'http://melete:8788/providers/fake/v1',
        key_env: 'MELETE_MODEL_KEY',
        extra_headers: { 'x-melete-capability': bundle.attempt.token },
      });
      // Nothing about this path renders a different engine from the container's.
      expect(config.memory).toEqual({
        memory_enabled: false,
        user_profile_enabled: false,
        provider: '',
      });
      expect(config.agent).toEqual({ max_turns: 150 });
      expect(config.compression.enabled).toBe(true);
      expect(config.compression.threshold_tokens).toBe(96_000);
    } finally {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  test('a stop that fails is retried by close and still removes the engine home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'melete-process-stop-'));
    const runtimePackage = join(root, 'runtime');
    let kills = 0;
    const supervisor = new ProcessRuntimeSupervisor(
      {
        ...options,
        engineRoot: join(root, 'engine'),
        runtimePackage,
        workRoot: join(root, 'work'),
        python: resolvePython(),
        startupTimeoutMs: 5000,
      },
      async (child) => {
        kills++;
        if (kills === 1) throw new Error('Runtime process tree did not stop');
        await stopProcessTree(child);
      },
    );
    try {
      await mkdir(join(root, 'engine', '.git'), { recursive: true });
      await writeFile(join(root, 'engine', '.git', 'HEAD'), HERMES_PINNED_COMMIT);
      await mkdir(join(runtimePackage, 'patches'), { recursive: true });
      await mkdir(join(runtimePackage, 'melete_plugin'));
      await writeFile(join(runtimePackage, 'patches', 'observer_bridge.py'), '# Fixture only.\n');
      // A loopback-only stand-in that reports the home it was given.
      await writeFile(
        join(runtimePackage, 'process_launcher.py'),
        `import http.server, json, os, pathlib
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = os.environ['HERMES_HOME'].encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
pathlib.Path(os.environ['MELETE_RUNTIME_ADDRESS_FILE']).write_text(json.dumps({'port': server.server_port}))
server.serve_forever()
`,
      );
      const instance = await supervisor.launch(bundle, new AbortController().signal);
      const home = await (await fetch(`${instance.baseUrl}/home`)).text();
      expect(await instance.stop().catch((error: Error) => error.message)).toBe(
        'Runtime process tree did not stop',
      );
      // The home carries the attempt's capability in its engine configuration.
      expect(await lstat(home).catch(() => null)).toBeNull();
      // Shutdown tries the kill again instead of reporting the first failure.
      await supervisor.close();
      expect(kills).toBe(2);
    } finally {
      await supervisor.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  test('service credentials and inherited home never enter the child environment', () => {
    expect(
      platformEnvironment({
        PATH: 'platform-path',
        HOME: '/private',
        DATABASE_URL: 'database-secret',
        OPENAI_API_KEY: 'provider-secret',
        MELETE_MASTER_KEY: 'master-secret',
      }),
    ).toEqual({ PATH: 'platform-path' });
    const environment = attemptEnvironment(bundle, options.brokerUrl, 'api-secret');
    expect(environment.MELETE_ATTEMPT_TOKEN).toBe('attempt-secret');
    expect(environment.MELETE_MODEL_KEY).toStartWith('melete-surrogate-');
    const astra = attemptEnvironment(
      { ...bundle, model: { provider: 'openai', model: 'gpt-6-astra', fallback: null } },
      options.brokerUrl,
      'api-secret',
    );
    expect(astra.MELETE_MODEL_API_MODE).toBe('codex_responses');
  });
  test('Docker mounts only this job subdirectory and never passes secrets in arguments', () => {
    const env = attemptEnvironment(bundle, options.brokerUrl, 'api-secret');
    const args = dockerRunArguments(bundle, options, 'test-runtime', env);
    expect(args).toContain(
      `type=volume,src=melete_work,dst=/work,volume-subpath=${bundle.attempt.job_id}`,
    );
    expect(args).not.toContain('attempt-secret');
    expect(args).not.toContain('api-secret');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--privileged');
    expect(args).toContain('--read-only');
    for (const [flag, value] of [
      ['--user', '10001:10001'],
      ['--cap-drop', 'ALL'],
      ['--security-opt', 'no-new-privileges:true'],
      ['--pids-limit', '256'],
      ['--memory', '2g'],
    ] as const) {
      const index = args.indexOf(flag);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(args[index + 1]).toBe(value);
    }
    expect(args.filter((arg) => arg === '--network')).toHaveLength(1);
    expect(args.join(' ')).toContain(
      '--log-driver json-file --log-opt max-size=10m --log-opt max-file=5',
    );
    expect(() =>
      dockerRunArguments(
        bundle,
        { ...options, dockerWorkVolume: '/host/path' },
        'test-runtime',
        env,
      ),
    ).toThrow('Invalid Docker work volume');
  });
  test('an external Docker network is rejected before a container can start', async () => {
    const commands: string[][] = [];
    const supervisor = new DockerRuntimeSupervisor(options, async (args) => {
      commands.push(args);
      return JSON.stringify([{ Internal: false }]);
    });
    await expect(supervisor.launch(bundle, new AbortController().signal)).rejects.toThrow(
      'must be internal',
    );
    expect(commands).toEqual([['network', 'inspect', 'melete_internal']]);
    await supervisor.close();
  });
  test('an unpinned Docker image is rejected before a container can start', async () => {
    const commands: string[][] = [];
    const supervisor = new DockerRuntimeSupervisor(options, async (args) => {
      commands.push(args);
      return JSON.stringify(
        args[0] === 'network'
          ? [{ Internal: true }]
          : [{ Config: { Labels: { 'com.melete.hermes.commit': 'wrong' } } }],
      );
    });
    await expect(supervisor.launch(bundle, new AbortController().signal)).rejects.toThrow(
      'pinned Hermes commit',
    );
    expect(commands.some((args) => args[0] === 'run')).toBe(false);
    await supervisor.close();
  });
  test('an unpinned process checkout is rejected before spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'melete-supervisor-pin-'));
    try {
      await mkdir(join(root, '.git'));
      await writeFile(join(root, '.git', 'HEAD'), 'wrong');
      const supervisor = new ProcessRuntimeSupervisor({ ...options, engineRoot: root });
      await expect(supervisor.launch(bundle, new AbortController().signal)).rejects.toThrow(
        'must be pinned',
      );
      await supervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('path traversal and a linked job workspace are rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'melete-supervisor-workspace-'));
    try {
      await expect(jobWorkspace(root, '../sibling')).rejects.toThrow();
      const outside = join(root, 'sibling');
      await mkdir(outside);
      const link = join(root, bundle.attempt.job_id);
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(jobWorkspace(root, bundle.attempt.job_id)).rejects.toThrow('cannot be a link');
      // Remove the link itself before cleaning the disposable fixture tree.
      await rm(link, { recursive: process.platform === 'win32' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('stopping an owned process also stops its live child', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`,
      ],
      {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let childPid = 0;
    try {
      childPid = await new Promise<number>((resolve, reject) => {
        parent.once('error', reject);
        parent.stdout?.once('data', (data) => resolve(Number(String(data).trim())));
      });
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await stopProcessTree(parent);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await stopProcessTree(parent);
    }
  }, 15_000);
  test.skipIf(process.platform === 'win32')(
    'a restrictive service umask cannot remove runtime-group workspace access',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'melete-supervisor-mode-'));
      const previous = process.umask(0o077);
      try {
        const workspace = await jobWorkspace(root, bundle.attempt.job_id);
        expect((await lstat(workspace)).mode & 0o070).toBe(0o070);
      } finally {
        process.umask(previous);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
