import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import { parseEnvFile } from '../../../deploy/scripts/provider-settings.ts';
import { type FileReplacer, fileReplacer } from '../../../deploy/scripts/tailscale-origin.ts';
import { ENABLE_COMMAND, judgeBrowser } from './browser.ts';
import { browserOptions, PROVISION_SCRIPT, runBrowser } from './commands/browser.ts';
import { judgeCheck } from './commands/check.ts';
import { runDoctor } from './commands/doctor.ts';
import { readInstallation } from './installation.ts';
import { reportSchema } from './schema.ts';
import { REAL_DEPLOY_DIR, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

/** A temporary checkout with what the browser Compose check reads beside the Compose files. */
function browserCheckout(): string {
  const deployDir = temporaryDeployDir();
  mkdirSync(join(deployDir, 'config'));
  copyFileSync(
    join(REAL_DEPLOY_DIR, 'config', 'browser-seccomp.json'),
    join(deployDir, 'config', 'browser-seccomp.json'),
  );
  writeFileSync(join(deployDir, 'config', 'connections.json'), '[]\n');
  copyFileSync(join(REAL_DEPLOY_DIR, 'Dockerfile.browser'), join(deployDir, 'Dockerfile.browser'));
  const service = join(dirname(deployDir), 'apps', 'melete');
  mkdirSync(service, { recursive: true });
  copyFileSync(
    join(REAL_DEPLOY_DIR, '..', 'apps', 'melete', 'package.json'),
    join(service, 'package.json'),
  );
  return deployDir;
}

type Answers = {
  service?: Partial<CommandOutput>;
  provision?: Partial<CommandOutput>;
  volume?: number;
};

const SPACE = 'sp_first';
const CONNECTION = 'conn_browser1';
const enabled = (created: boolean) =>
  JSON.stringify({ space_id: SPACE, connection_id: CONNECTION, created });

/** A Docker engine whose service, volume and one-shot container answer as told. */
function engine(deployDir: string, answers: Answers = {}) {
  const calls: string[][] = [];
  const context = testContext(deployDir, [], {
    run: (command) => {
      calls.push([...command]);
      const line = command.join(' ');
      const answer = (output: Partial<CommandOutput> | undefined, fallback: string) => ({
        code: 0,
        stdout: fallback,
        stderr: '',
        ...output,
      });
      if (line.includes(' exec -T melete '))
        return answer(answers.service, `leases: ready\n${enabled(true)}\n`);
      if (line.startsWith('docker volume inspect'))
        return { code: answers.volume ?? 0, stdout: 'melete_spaces\n', stderr: '' };
      if (line.startsWith('docker run '))
        return answer(answers.provision, '10002:10002 755\n10003:10003 700\n');
      return { code: 1, stdout: '', stderr: 'no such command in this test' };
    },
  });
  return { context, calls };
}

const files = (deployDir: string) =>
  Object.fromEntries(
    ['.env', 'melete.deploy.json', 'config/connections.json'].map((name) => [
      name,
      existsSync(join(deployDir, name)) ? readFileSync(join(deployDir, name), 'utf8') : null,
    ]),
  );

/** Records every file written, and writes it. */
function recordingReplacer(): FileReplacer & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: async (path, text, mode) => {
      written.push(path);
      await fileReplacer.write(path, text, mode);
    },
    rename: fileReplacer.rename,
    remove: fileReplacer.remove,
  };
}

describe('melete browser enable', () => {
  test('writes the settings, the overlay and the connection, then starts the stack with the worker', async () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    const { context, calls } = engine(deployDir);
    expect(await runBrowser(context, ['enable'])).toBe(0);

    const env = parseEnvFile(readFileSync(join(deployDir, '.env'), 'utf8'));
    expect(env.MELETE_BROWSER_SPACE).toBe(SPACE);
    expect(env.MELETE_BROWSER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // The token goes to deploy/.env only: never to the output, the connections file or a command.
    const token = env.MELETE_BROWSER_TOKEN ?? '';
    expect(context.printed() + context.errors()).not.toContain(token);
    expect(JSON.stringify(calls) + JSON.stringify(context.attached)).not.toContain(token);
    expect(readFileSync(join(deployDir, 'config', 'connections.json'), 'utf8')).not.toContain(
      token,
    );
    // The overlay is recorded, so deploy and every later command run it.
    const contract = JSON.parse(readFileSync(join(deployDir, 'melete.deploy.json'), 'utf8'));
    expect(contract).toMatchObject({
      contract: 1,
      project: 'melete',
      overlays: ['browser'],
      images: { tag: 'main' },
    });
    expect(JSON.parse(readFileSync(join(deployDir, 'config', 'connections.json'), 'utf8'))).toEqual(
      [{ kind: 'browser', id: CONNECTION }],
    );

    // The service was asked with the files it runs with now, without the overlay.
    const asked = calls.find((call) => call.includes('exec')) ?? [];
    expect(asked.join(' ')).toContain(
      'exec -T melete bun run apps/melete/src/workers/browser/enable.ts',
    );
    expect(asked.join(' ')).not.toContain('docker-compose.browser.yml');
    expect(asked).not.toContain('--space');

    // The directory is made as root on the space's own subpath, and nothing else.
    const provision = calls.find((call) => call[0] === 'docker' && call[1] === 'run') ?? [];
    expect(provision).toContain(
      `type=volume,source=melete_spaces,target=/space,volume-subpath=${SPACE}`,
    );
    expect(provision.slice(provision.indexOf('--user'), provision.indexOf('--user') + 2)).toEqual([
      '--user',
      '0:0',
    ]);
    expect(provision).toEqual(expect.arrayContaining(['--network', 'none', '--read-only']));
    expect(provision.filter((part) => part === '--mount')).toHaveLength(1);
    expect(provision.some((part) => /^-v$|^--volume/.test(part))).toBe(false);
    expect(provision.at(-1)).toBe(PROVISION_SCRIPT);
    expect(PROVISION_SCRIPT).toContain('chown -h 10003:10003 "$d"');
    expect(PROVISION_SCRIPT).toContain('chmod 0700 "$d"');
    expect(PROVISION_SCRIPT).not.toMatch(/-R\b|--recursive|\bfind\b/);

    // Then the worker is built and the stack starts with the overlay.
    expect(context.attached).toHaveLength(2);
    expect(context.attached[0]?.slice(-2)).toEqual(['build', 'browser']);
    for (const command of context.attached)
      expect(command).toContain(join(deployDir, 'docker-compose.browser.yml'));
    expect(context.attached[1]).toEqual(
      expect.arrayContaining(['up', '-d', '--no-build', '--wait']),
    );

    expect(judgeBrowser(readInstallation(deployDir, 'linux'))).toEqual([
      { id: 'browser.worker', level: 'ok', detail: `The browser worker works for ${SPACE}.` },
    ]);
  });

  test('running it again changes no file and keeps the token', async () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    expect(await runBrowser(engine(deployDir).context, ['enable'])).toBe(0);
    const before = files(deployDir);

    const again = engine(deployDir, { service: { stdout: `${enabled(false)}\n` } });
    const replacer = recordingReplacer();
    expect(await runBrowser(again.context, ['enable'], replacer)).toBe(0);
    expect(replacer.written).toEqual([]);
    expect(files(deployDir)).toEqual(before);
    expect(again.context.printed()).toContain('already in place');
    // The space it already works for is the one asked for.
    expect(again.calls.find((call) => call.includes('exec'))?.slice(-2)).toEqual([
      '--space',
      SPACE,
    ]);
  });

  test('an existing token and other connections are kept', async () => {
    const deployDir = browserCheckout();
    const kept = 'k'.repeat(40);
    writeEnv(deployDir, { MELETE_BROWSER_TOKEN: kept });
    const other = { kind: 'mcp', id: 'conn_other', server: { transport: 'http' } };
    writeFileSync(join(deployDir, 'config', 'connections.json'), JSON.stringify([other]));
    expect(await runBrowser(engine(deployDir).context, ['enable'])).toBe(0);
    expect(parseEnvFile(readFileSync(join(deployDir, '.env'), 'utf8')).MELETE_BROWSER_TOKEN).toBe(
      kept,
    );
    expect(JSON.parse(readFileSync(join(deployDir, 'config', 'connections.json'), 'utf8'))).toEqual(
      [other, { kind: 'browser', id: CONNECTION }],
    );
  });

  test('a worker that already serves one space is not moved to another', async () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir, { MELETE_BROWSER_SPACE: 'sp_one' });
    const before = files(deployDir);
    const { context, calls } = engine(deployDir);
    expect(await runBrowser(context, ['enable', '--space', 'sp_two'])).toBe(2);
    expect(context.errors()).toContain('One worker serves one space');
    expect(calls).toEqual([]);
    expect(files(deployDir)).toEqual(before);
  });

  test('without an account nothing is changed', async () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    const before = files(deployDir);
    const { context, calls } = engine(deployDir, {
      service: {
        code: 2,
        stdout: '',
        stderr: 'There is no account yet. Create your account in Melete, then run this again.\n',
      },
    });
    expect(await runBrowser(context, ['enable'])).toBe(2);
    expect(context.errors()).toContain('There is no account yet');
    expect(calls.some((call) => call[1] === 'run')).toBe(false);
    expect(context.attached).toEqual([]);
    expect(files(deployDir)).toEqual(before);
  });

  test('a directory the worker would not own, or could not reach, stops it before any file changes', async () => {
    for (const stdout of ['10002:10002 755\n0:0 755\n', '10002:10002 700\n10003:10003 700\n']) {
      const deployDir = browserCheckout();
      writeEnv(deployDir);
      const before = files(deployDir);
      const { context } = engine(deployDir, { provision: { stdout } });
      expect(await runBrowser(context, ['enable'])).toBe(2);
      expect(context.errors()).toContain("The worker's directory could not be made");
      expect(context.attached).toEqual([]);
      expect(files(deployDir)).toEqual(before);
    }
  });

  test('a browser overlay that fails its Compose check is refused before anything runs', async () => {
    const mutations: [string, string][] = [
      ['user: "10003:10003"', 'user: "0:0"'],
      ['cap_drop: [ALL]', 'cap_drop: []'],
      [
        'networks: [browser-control, browser-egress]',
        'networks: [browser-control, browser-egress, internal]',
      ],
      ['        subpath: ${MELETE_BROWSER_SPACE:?set MELETE_BROWSER_SPACE in .env}\n', ''],
      [
        '      MELETE_BROWSER_HOST: 0.0.0.0',
        '      MELETE_BROWSER_HOST: 0.0.0.0\n      DATABASE_URL: ${DATABASE_URL}',
      ],
    ];
    for (const [from, to] of mutations) {
      const deployDir = browserCheckout();
      writeEnv(deployDir);
      const overlay = join(deployDir, 'docker-compose.browser.yml');
      const text = readFileSync(overlay, 'utf8');
      expect(text, from).toContain(from);
      writeFileSync(overlay, text.replace(from, to));
      const before = files(deployDir);
      const { context, calls } = engine(deployDir);
      expect(await runBrowser(context, ['enable']), from).toBe(2);
      expect(context.errors()).toContain('fail their check');
      expect(calls).toEqual([]);
      expect(files(deployDir)).toEqual(before);
    }
  });

  test('its options', () => {
    expect(browserOptions(['enable'])).toEqual({});
    expect(browserOptions(['enable', '--space', 'sp_x1'])).toEqual({ space: 'sp_x1' });
    expect(browserOptions(['enable', '--space=sp_x1'])).toEqual({ space: 'sp_x1' });
    expect(() => browserOptions([])).toThrow('Usage');
    expect(() => browserOptions(['enable', '--space'])).toThrow('space id');
    expect(() => browserOptions(['enable', '--space', '../x'])).toThrow('space id');
    expect(() => browserOptions(['enable', '--other'])).toThrow('not an option');
  });
});

describe('the browser worker in check and doctor', () => {
  const judge = (deployDir: string) =>
    judgeCheck(readInstallation(deployDir, 'linux')).find(
      (result) => result.id === 'browser.worker',
    );

  test('off, it is a warning that names the command', () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    expect(judge(deployDir)).toMatchObject({
      level: 'warn',
      fix: expect.stringContaining(ENABLE_COMMAND),
    });
  });

  test('a browser connection without the overlay fails, since the service would refuse to start', () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    writeFileSync(
      join(deployDir, 'config', 'connections.json'),
      JSON.stringify([{ kind: 'browser', id: CONNECTION }]),
    );
    expect(judge(deployDir)).toMatchObject({ level: 'fail', fix: `Run ${ENABLE_COMMAND}.` });
    // A worker the operator runs elsewhere, at its own address, is theirs to judge.
    writeFileSync(
      join(deployDir, 'config', 'connections.json'),
      JSON.stringify([
        { kind: 'browser', id: CONNECTION, worker_url: 'http://worker.example:3132' },
      ]),
    );
    expect(judge(deployDir)?.level).toBe('warn');
  });

  test('the overlay without its settings or its connection is misconfigured', () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      JSON.stringify({ contract: 1, overlays: ['browser'] }),
    );
    expect(judge(deployDir)).toMatchObject({ level: 'fail', fix: `Run ${ENABLE_COMMAND}.` });
    writeEnv(deployDir, { MELETE_BROWSER_SPACE: SPACE, MELETE_BROWSER_TOKEN: 'short' });
    expect(judge(deployDir)?.detail).toContain('MELETE_BROWSER_TOKEN');
    writeEnv(deployDir, { MELETE_BROWSER_SPACE: SPACE, MELETE_BROWSER_TOKEN: 't'.repeat(64) });
    expect(judge(deployDir)).toMatchObject({ level: 'warn', fix: `Run ${ENABLE_COMMAND}.` });
    writeFileSync(join(deployDir, 'config', 'connections.json'), '{');
    expect(
      judgeCheck(readInstallation(deployDir, 'linux')).find(
        (result) => result.id === 'browser.connections',
      )?.level,
    ).toBe('fail');
  });

  test('doctor reports a missing worker with the command that turns it on', async () => {
    const deployDir = browserCheckout();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    await runDoctor(context, true, true);
    const value = reportSchema.parse(JSON.parse(context.printed()));
    expect(value.results.find((result) => result.id === 'browser.worker')).toMatchObject({
      level: 'warn',
      fix: expect.stringContaining(ENABLE_COMMAND),
    });
  });
});
