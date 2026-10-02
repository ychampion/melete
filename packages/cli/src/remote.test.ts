import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import {
  hashScript,
  parseRemote,
  REMOTE_COMMANDS,
  RemoteRefusal,
  runRemote,
  shellWord,
  writeScript,
} from './commands/remote.ts';
import { main } from './main.ts';
import { reportSchema } from './schema.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const SECRET = 'sk-test-value';
const HEALTHY = 'bun 1.3.2\ndocker 29.1.3\ncheckout 755 755\n';

/**
 * An SSH that answers the preflight from `preflight`, the file listing from
 * `listings` (one per call, the last repeating), and records every command.
 */
function sshContext(
  options: {
    preflight?: Partial<CommandOutput>;
    listings?: string[];
    attachCode?: number;
    deployFile?: object;
  } = {},
) {
  const deployDir = temporaryDeployDir();
  writeEnv(deployDir);
  if (options.deployFile)
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      JSON.stringify({ contract: 1, ...options.deployFile }),
    );
  const calls: string[][] = [];
  const listings = [...(options.listings ?? [''])];
  const base = testContext(deployDir);
  const context = {
    ...base,
    // Real file modes, so a private deploy/.env reads as private where the platform has modes.
    machine: { ...base.machine, platform: process.platform },
    run: (command: readonly string[]): CommandOutput => {
      calls.push([...command]);
      const script = command.at(-1) ?? '';
      if (script.startsWith('export PATH'))
        return { code: 0, stdout: HEALTHY, stderr: '', ...options.preflight };
      if (script.startsWith('cd ')) {
        const stdout = listings.length > 1 ? (listings.shift() ?? '') : (listings[0] ?? '');
        return { code: 0, stdout, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    attach: async (command: readonly string[]) => {
      base.attached.push([...command]);
      return options.attachCode ?? 0;
    },
  };
  return { deployDir, context, calls };
}

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

describe('melete remote: arguments', () => {
  test('a target that ssh would read as an option is refused', () => {
    expect(() => parseRemote(['-oProxyCommand=x', 'status'])).toThrow(RemoteRefusal);
    expect(() => parseRemote(['vm1', '--path', '/srv/../etc', 'status'])).toThrow(
      'not a remote checkout',
    );
    expect(() => parseRemote(['vm1', 'remote', 'status'])).toThrow(
      'not a command melete remote runs',
    );
    expect(
      parseRemote(['claude@vm-1.example', '--path', '~/melete', 'deploy', '--tag', 'v1.2.0']),
    ).toEqual({
      target: 'claude@vm-1.example',
      path: '~/melete',
      command: 'deploy',
      args: ['--tag', 'v1.2.0'],
    });
    expect(REMOTE_COMMANDS).toContain('status');
  });

  test('set --from-env is refused, because over SSH it would read the remote shell', () => {
    expect(() => parseRemote(['vm1', 'set', '--from-env', 'ANTHROPIC_API_KEY'])).toThrow(
      'push --replace',
    );
  });

  test('every word reaches the remote shell quoted, with only a leading ~ expanded there', () => {
    expect(shellWord("it's; rm -rf /")).toBe(`'it'\\''s; rm -rf /'`);
    expect(shellWord('~/melete')).toBe(`"$HOME"/'melete'`);
    expect(shellWord('/srv/a~b')).toBe(`'/srv/a~b'`);
  });
});

describe('melete remote: running a command there', () => {
  test('status runs in the remote checkout with its own deploy directory, and its exit code comes back', async () => {
    const { context, calls } = sshContext({ attachCode: 1 });
    const code = await runRemote(context, ['vm1', '--path', '~/melete', 'status'], {
      json: true,
      offline: false,
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(['ssh', '-o', 'BatchMode=yes', 'vm1']);
    const attached = context.attached[0] ?? [];
    expect(attached.slice(0, 4)).toEqual(['ssh', '-o', 'BatchMode=yes', 'vm1']);
    expect(attached[4]).toBe(
      [
        'export PATH="$HOME/.bun/bin:$PATH"',
        `cd "$HOME"/'melete'`,
        `exec 'bun' 'run' 'melete' 'status' --deploy-dir "$HOME"/'melete'/deploy --json`,
      ].join('\n'),
    );
    // With --json, stdout stays the remote command's alone.
    expect(context.printed()).toBe('');
  });

  test('the remote checkout and the command that runs there come from the deploy file', async () => {
    const { context } = sshContext({
      deployFile: { remote: { path: '/srv/melete', cli: ['~/melete-cli/melete'] } },
    });
    expect(
      await runRemote(context, ['vm1', 'deploy', '--tag', 'v1.2.0'], {
        json: false,
        offline: false,
      }),
    ).toBe(0);
    expect(context.attached[0]?.[4]).toContain(
      `exec "$HOME"/'melete-cli/melete' 'deploy' --deploy-dir '/srv/melete'/deploy '--tag' 'v1.2.0'`,
    );
  });

  test('without a remote checkout named, nothing is run', async () => {
    const { context, calls } = sshContext();
    expect(await runRemote(context, ['vm1', 'status'], { json: false, offline: false })).toBe(2);
    expect(calls).toEqual([]);
    expect(context.errors()).toContain('--path');
  });

  test('a machine without bun or Docker is refused with what to install, and nothing runs there', async () => {
    const { context } = sshContext({
      preflight: { stdout: 'bun missing\ndocker missing\ncheckout 755 755\n' },
    });
    expect(
      await runRemote(context, ['vm1', '--path', '/srv/melete', 'status'], {
        json: true,
        offline: false,
      }),
    ).toBe(2);
    expect(context.attached).toEqual([]);
    const value = reportSchema.parse(JSON.parse(context.printed()));
    const failed = value.results.filter((result) => result.level === 'fail');
    expect(failed.map((result) => result.id)).toEqual(['remote.bun', 'remote.docker']);
    expect(failed[0]?.fix).toContain('bun.sh/install');
    expect(failed[1]?.fix).toContain('docker.com/engine/install');
  });

  test('a checkout another account could write is refused', async () => {
    for (const modes of ['checkout 777 755', 'checkout 755 757', 'checkout unknown 755']) {
      const { context } = sshContext({
        preflight: { stdout: `bun 1.3.2\ndocker 29.1.3\n${modes}\n` },
      });
      expect(
        await runRemote(context, ['vm1', '--path', '/srv/melete', 'status'], {
          json: false,
          offline: false,
        }),
      ).toBe(2);
      expect(context.attached).toEqual([]);
      expect(context.printed()).toContain('remote.checkout');
    }
  });

  test('a connection that fails is refused, and one that drops mid-command reports where to look', async () => {
    const refused = sshContext({
      preflight: { code: 255, stdout: '', stderr: 'Permission denied (publickey).' },
    });
    expect(
      await runRemote(refused.context, ['vm1', '--path', '/srv/m', 'status'], {
        json: false,
        offline: false,
      }),
    ).toBe(2);
    expect(refused.context.printed()).toContain('Permission denied (publickey).');
    const dropped = sshContext({ attachCode: 255 });
    expect(
      await runRemote(dropped.context, ['vm1', '--path', '/srv/m', 'deploy'], {
        json: false,
        offline: false,
      }),
    ).toBe(3);
    expect(dropped.context.errors()).toContain('history and status');
  });

  test('main dispatches remote with the deploy directory of this checkout', async () => {
    const { deployDir, context } = sshContext();
    const code = await main(
      ['remote', 'vm1', '--path', '/srv/m', 'check', '--deploy-dir', deployDir],
      () => context,
    );
    expect(code).toBe(0);
    expect(context.attached[0]?.[4]).toContain(`'check' --deploy-dir '/srv/m'/deploy`);
  });
});

describe('melete remote push', () => {
  const pushArgs = (...extra: string[]) => ['vm1', '--path', '/srv/melete', 'push', ...extra];

  test('remote sync keeps the env file private on both ends', async () => {
    const { deployDir, context, calls } = sshContext();
    const envHash = sha(readFileSync(join(deployDir, '.env')));
    // Nothing there yet; after the copy every file is there, deploy/.env at 0600.
    const listingAfter = `${envHash}  .env\nmode 600\n`;
    const responses = ['', listingAfter];
    context.run = (command) => {
      calls.push([...command]);
      const script = command.at(-1) ?? '';
      if (script.startsWith('export PATH')) return { code: 0, stdout: HEALTHY, stderr: '' };
      return { code: 0, stdout: responses.shift() ?? listingAfter, stderr: '' };
    };
    const code = await runRemote(context, pushArgs(), { json: true, offline: false });
    const value = reportSchema.parse(JSON.parse(context.printed()));
    expect(value.results.filter((result) => result.level === 'fail')).toEqual([]);
    expect(code).toBe(0);
    const write = context.streams.find((stream) => stream.sinks.length > 0);
    // Streamed from the file into cat there: the contents are never an argument.
    expect(write?.source).toEqual({ file: join(deployDir, '.env') });
    const sink = write?.sinks[0];
    const script = sink && 'command' in sink ? (sink.command.at(-1) ?? '') : '';
    expect(script).toBe(
      `umask 077 && cd '/srv/melete'/deploy && cat > '.env.melete-push' && chmod 600 '.env.melete-push' && mv -f '.env.melete-push' '.env'`,
    );
    expect(value.results.find((result) => result.id === 'remote.env_private')?.level).toBe('ok');
    // No command line, here or there, carries a value from deploy/.env, and nothing printed does.
    for (const call of [
      ...calls,
      ...context.streams.flatMap((stream) =>
        stream.sinks.map((s) => ('command' in s ? s.command : [])),
      ),
    ])
      expect(call.join(' ')).not.toContain(SECRET);
    expect(context.printed()).not.toContain(SECRET);
  });

  test('a deploy/.env other accounts here can read is never copied', async () => {
    if (process.platform === 'win32') return; // Windows has no permission bits to judge.
    const { deployDir, context } = sshContext();
    chmodSync(join(deployDir, '.env'), 0o644);
    expect(await runRemote(context, pushArgs(), { json: false, offline: false })).toBe(2);
    expect(context.streams.filter((stream) => stream.sinks.length > 0)).toEqual([]);
    expect(context.printed()).toContain('chmod 600');
  });

  test('a file that changed on the remote is not overwritten unless --replace is given', async () => {
    const { context } = sshContext({ listings: [`${'0'.repeat(64)}  .env\n`] });
    expect(await runRemote(context, pushArgs(), { json: false, offline: false })).toBe(2);
    expect(context.streams.filter((stream) => stream.sinks.length > 0)).toEqual([]);
    expect(context.printed()).toContain('remote.push_diverged');
    expect(context.printed()).toContain('.env');

    const replaced = sshContext({ listings: [`${'0'.repeat(64)}  .env\n`] });
    await runRemote(replaced.context, pushArgs('--replace'), { json: false, offline: false });
    expect(replaced.context.streams.filter((stream) => stream.sinks.length > 0)).toHaveLength(1);
  });

  test('push copies nothing while a melete command holds the lock there, or on --dry-run', async () => {
    const locked = sshContext({ listings: ['LOCKED\n'] });
    expect(await runRemote(locked.context, pushArgs(), { json: false, offline: false })).toBe(2);
    expect(locked.context.printed()).toContain('remote.push_locked');
    const dry = sshContext({ listings: [''] });
    expect(
      await runRemote(dry.context, pushArgs('--dry-run'), { json: false, offline: false }),
    ).toBe(0);
    expect(dry.context.printed()).toContain('Would copy .env');
    for (const context of [locked.context, dry.context])
      expect(context.streams.filter((stream) => stream.sinks.length > 0)).toEqual([]);
  });

  test('files the same on both ends are not copied again, and config files are written readable', async () => {
    const { deployDir, context } = sshContext();
    mkdirSync(join(deployDir, 'config'));
    writeFileSync(join(deployDir, 'config', 'connections.json'), '[]\n');
    const envHash = sha(readFileSync(join(deployDir, '.env')));
    const listing = `${envHash}  .env\n`;
    let listed = 0;
    context.run = (command) => {
      const script = command.at(-1) ?? '';
      if (script.startsWith('export PATH')) return { code: 0, stdout: HEALTHY, stderr: '' };
      listed += 1;
      return {
        code: 0,
        stdout:
          listed === 1 ? listing : `${listing}${sha('[]\n')}  config/connections.json\nmode 600\n`,
        stderr: '',
      };
    };
    expect(await runRemote(context, pushArgs(), { json: false, offline: false })).toBe(0);
    const writes = context.streams.filter((stream) => stream.sinks.length > 0);
    expect(writes).toHaveLength(1);
    const sink = writes[0]?.sinks[0];
    expect(sink && 'command' in sink ? sink.command.at(-1) : '').toBe(
      `umask 022 && cd '/srv/melete'/deploy && mkdir -p 'config' && cat > 'config/connections.json.melete-push' && mv -f 'config/connections.json.melete-push' 'config/connections.json'`,
    );
  });

  test('a copy that is not private there is reported, not hidden', async () => {
    const { deployDir, context } = sshContext();
    const envHash = sha(readFileSync(join(deployDir, '.env')));
    let listed = 0;
    context.run = (command) => {
      const script = command.at(-1) ?? '';
      if (script.startsWith('export PATH')) return { code: 0, stdout: HEALTHY, stderr: '' };
      listed += 1;
      return { code: 0, stdout: listed === 1 ? '' : `${envHash}  .env\nmode 644\n`, stderr: '' };
    };
    expect(await runRemote(context, pushArgs(), { json: false, offline: false })).toBe(3);
    expect(context.printed()).toContain('remote.env_private');
  });

  test('the listing script names each file quoted and reports the lock', () => {
    expect(hashScript('~/melete', ['.env', 'config/a b.json'])).toBe(
      [
        `cd "$HOME"/'melete'/deploy || exit 3`,
        'if [ -e .melete/lock ]; then echo LOCKED; fi',
        `for f in '.env' 'config/a b.json'; do if [ -f "$f" ]; then sha256sum -- "$f"; fi; done`,
      ].join('\n'),
    );
    expect(writeScript('/srv/m', { name: 'melete.deploy.json', file: '', private: false })).toBe(
      `umask 022 && cd '/srv/m'/deploy && cat > 'melete.deploy.json.melete-push' && mv -f 'melete.deploy.json.melete-push' 'melete.deploy.json'`,
    );
  });
});
