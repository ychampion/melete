import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptBundle } from '@melete/contracts';
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
    const root = await mkdtemp(join(tmpdir(), 'melete-w15-pin-'));
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
    const root = await mkdtemp(join(tmpdir(), 'melete-w15-workspace-'));
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
      const root = await mkdtemp(join(tmpdir(), 'melete-w15-mode-'));
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
