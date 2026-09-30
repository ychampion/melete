import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServiceAddress, onLocalNetwork } from './address.ts';
import { discoverApi } from './agent.ts';
import type { Capabilities, Folder } from './config.ts';
import { folderName } from './config.ts';
import { parsePath, Refusal, resolveInside } from './policy.ts';
import { LIMITS, runCommand, runTool } from './tools.ts';

const ALL: Capabilities = { commands: true, files: true, open_url: true, screenshot: true };
let root: string;
let shared: string;
let outside: string;
let folders: Folder[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'melete-device-'));
  shared = join(root, 'shared');
  outside = join(root, 'outside');
  await mkdir(join(shared, 'notes'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(shared, 'notes', 'todo.md'), 'buy milk\n');
  await writeFile(join(outside, 'secret.txt'), 'not for the agent');
  // A directory junction needs no special rights on Windows; elsewhere it is a symlink.
  await symlink(outside, join(shared, 'escape'), 'junction');
  await symlink(join(outside, 'secret.txt'), join(shared, 'secret-link.txt')).catch(() => {});
  folders = [{ name: 'Shared', path: shared }];
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return 'allowed';
};

describe('paths stay inside the shared folders', () => {
  test.each([
    ['Shared/../outside/secret.txt'],
    ['Shared/notes/../../outside'],
    ['/etc/passwd'],
    ['C:/Windows/win.ini'],
    ['Shared\\..\\outside'],
    ['~/secret'],
    ['Other/notes'],
    ['Shared/CON'],
    ['Shared/nul.txt'],
    ['Shared/notes./x'],
  ])('%s is refused', async (path) => {
    expect(await refusal(runTool('read_file', { path }, { capabilities: ALL, folders }))).toBe(
      'outside_folders',
    );
  });

  test('a path inside is read', async () => {
    const result = await runTool(
      'read_file',
      { path: 'Shared/notes/todo.md' },
      { capabilities: ALL, folders },
    );
    expect(result.content).toBe('buy milk\n');
    expect(result.binary).toBe(false);
  });

  test('a link out of the folder is not followed, for reading, listing or writing', async () => {
    const context = { capabilities: ALL, folders };
    expect(await refusal(runTool('read_file', { path: 'Shared/escape/secret.txt' }, context))).toBe(
      'outside_folders',
    );
    expect(await refusal(runTool('list_files', { path: 'Shared/escape' }, context))).toBe(
      'outside_folders',
    );
    expect(
      await refusal(
        runTool('write_file', { path: 'Shared/escape/new.txt', content: 'x' }, context),
      ),
    ).toBe('outside_folders');
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('not for the agent');
  });

  test('a file with a second name outside the folder is neither read nor written', async () => {
    const target = join(outside, 'linked.txt');
    await writeFile(target, 'kept outside');
    await link(target, join(shared, 'hard.txt'));
    const context = { capabilities: ALL, folders };
    expect(await refusal(runTool('read_file', { path: 'Shared/hard.txt' }, context))).toBe(
      'outside_folders',
    );
    expect(
      await refusal(
        runTool('write_file', { path: 'Shared/hard.txt', content: 'OVERWRITTEN' }, context),
      ),
    ).toBe('outside_folders');
    expect(await readFile(target, 'utf8')).toBe('kept outside');
  });

  test('a listing shows links as links and never follows them', async () => {
    const result = await runTool('list_files', { path: 'Shared' }, { capabilities: ALL, folders });
    const entries = result.entries as { name: string; kind: string }[];
    expect(entries.find((entry) => entry.name === 'escape')?.kind).toBe('other');
    expect(entries.find((entry) => entry.name === 'notes')?.kind).toBe('directory');
  });

  test('a shared folder that is itself replaced by a link is judged where it points now', async () => {
    const moved = [{ name: 'Moved', path: join(shared, 'escape') }];
    // The folder resolves to `outside`; its contents are inside that real folder, which is allowed,
    // but nothing climbs out of it.
    expect(await refusal(resolveInside('Moved/../shared', moved))).toBe('outside_folders');
  });

  test('writing makes missing folders inside and nothing outside', async () => {
    const result = await runTool(
      'write_file',
      { path: 'Shared/new/deep/file.txt', content: 'hello' },
      { capabilities: ALL, folders },
    );
    expect(result.bytes).toBe(5);
    expect(await readFile(join(shared, 'new', 'deep', 'file.txt'), 'utf8')).toBe('hello');
    expect(
      await refusal(
        runTool('write_file', { path: 'Shared', content: 'x' }, { capabilities: ALL, folders }),
      ),
    ).toBe('invalid_request');
  });

  test('parsePath names the folder and the rest', () => {
    expect(parsePath('Shared/notes/todo.md', folders).segments).toEqual(['notes', 'todo.md']);
  });

  test('folder names are plain and distinct', () => {
    const taken: Folder[] = [{ name: 'Projects', path: '/a/Projects' }];
    expect(folderName('/b/Projects/', taken)).toBe('Projects-2');
    expect(folderName('/c/my files!', [])).toBe('my files');
  });
});

describe('capabilities turned off here are refused here', () => {
  const off: Capabilities = { commands: false, files: false, open_url: false, screenshot: false };
  test.each([
    ['run', { command: 'echo hi' }],
    ['read_file', { path: 'Shared/notes/todo.md' }],
    ['write_file', { path: 'Shared/x.txt', content: 'x' }],
    ['list_files', { path: 'Shared' }],
    ['open_url', { url: 'https://example.com' }],
    ['screenshot', {}],
  ])('%s', async (tool, args) => {
    let launched = false;
    expect(
      await refusal(
        runTool(tool, args, {
          capabilities: off,
          folders,
          launch: async () => {
            launched = true;
          },
          captureScreen: async () => Buffer.from('png'),
        }),
      ),
    ).toBe('capability_off');
    expect(launched).toBe(false);
  });
});

describe('commands', () => {
  test('run in the shared folder and report their exit code', async () => {
    const result = await runTool(
      'run',
      { command: 'echo hello', cwd: 'Shared/notes' },
      { capabilities: ALL, folders },
    );
    expect(String(result.stdout).trim()).toBe('hello');
    expect(result.exit_code).toBe(0);
    expect(result.cwd).toBe(
      join(await import('node:fs/promises').then((fs) => fs.realpath(shared)), 'notes'),
    );
  });

  test('keep only the capped amount of output', async () => {
    const command =
      process.platform === 'win32'
        ? 'for /L %i in (1,1,3000) do @echo 0123456789012345678901234567890123456789'
        : 'yes 0123456789012345678901234567890123456789 | head -n 3000';
    const result = await runCommand({
      command,
      cwd: shared,
      timeoutMs: 60_000,
      maxOutputBytes: 1_000,
    });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_000);
    expect(result.stdout_truncated).toBe(true);
    expect(LIMITS.max_output_bytes).toBe(65_536);
  }, 70_000);

  test('stop at their time limit', async () => {
    const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
    const result = await runCommand({ command, cwd: shared, timeoutMs: 500 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.duration_ms).toBeLessThan(15_000);
  }, 20_000);
});

describe('web pages', () => {
  test('only http and https are opened, without a shell', async () => {
    const launched: string[][] = [];
    const context = {
      capabilities: ALL,
      folders,
      launch: async (command: string, args: string[]) => {
        launched.push([command, ...args]);
      },
      resolve: async () => ['93.184.215.14'],
    };
    expect(await refusal(runTool('open_url', { url: 'file:///etc/passwd' }, context))).toBe(
      'invalid_request',
    );
    expect(await refusal(runTool('open_url', { url: 'javascript:alert(1)' }, context))).toBe(
      'invalid_request',
    );
    await runTool('open_url', { url: 'https://example.com/a?b=1&c=2' }, context);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.at(-1)).toBe('https://example.com/a?b=1&c=2');
  });
});

describe('pages on this computer or its network', () => {
  const launched: string[] = [];
  const answers: Record<string, string[]> = {
    'example.com': ['93.184.215.14'],
    'rebind.example': ['93.184.215.14', '192.168.1.1'],
    'loop.example': ['::ffff:127.0.0.1'],
  };
  const context = {
    capabilities: ALL,
    folders,
    launch: async (_command: string, args: string[]) => {
      launched.push(String(args.at(-1)));
    },
    resolve: async (host: string) => answers[host] ?? [],
  };

  test.each([
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://[::1]:3000/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://printer.local/',
    'http://router/',
    'https://rebind.example/',
    'https://loop.example/',
  ])('%s is refused unless the person approved it', async (url) => {
    launched.length = 0;
    expect(await refusal(runTool('open_url', { url }, context))).toBe('invalid_request');
    expect(launched).toEqual([]);
    await runTool('open_url', { url, local_approved: true }, context);
    expect(launched).toHaveLength(1);
  });

  test('a public page opens without a mark', async () => {
    launched.length = 0;
    await runTool('open_url', { url: 'https://example.com/' }, context);
    expect(launched).toEqual(['https://example.com/']);
    expect(await onLocalNetwork(new URL('https://example.com/'), context.resolve)).toBe(false);
  });
});

describe('the address Melete is reached at', () => {
  test.each([
    'http://127.0.0.1:3100',
    'http://localhost:3000',
    'http://[::1]:3000',
    'https://melete.example',
    'https://192.168.1.10',
  ])('%s is accepted', (address) => {
    expect(() => checkServiceAddress(address)).not.toThrow();
  });

  test.each([
    'http://melete.example',
    'http://192.168.1.10:3000',
    'http://10.0.0.2',
    'ftp://melete.example',
  ])('%s is refused before anything is sent', async (address) => {
    expect(() => checkServiceAddress(address)).toThrow();
    let asked = false;
    const fetcher = async () => {
      asked = true;
      return new Response('{}');
    };
    expect(
      await discoverApi(address, fetcher).then(
        () => 'accepted',
        () => 'refused',
      ),
    ).toBe('refused');
    expect(asked).toBe(false);
  });
});
