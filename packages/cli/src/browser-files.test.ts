/**
 * The one-line installer's way to turn on the browser worker: `browser files`,
 * which the service image runs for it, and the installer's own shell, held to
 * what `browser enable` does.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withSetting } from '../../../deploy/scripts/set-env.ts';
import { CONNECTION_ID, judgeBrowser, SPACE_ID } from './browser.ts';
import { PROVISION_SCRIPT, provisionCommand, SERVICE_SCRIPT } from './commands/browser.ts';
import { CONTRACT_SETTINGS, runBrowserFiles } from './commands/browser-files.ts';
import { readInstallation } from './installation.ts';
import { temporaryDeployDir, testContext } from './testing.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const INSTALLER = readFileSync(join(ROOT, 'install.sh'), 'utf8').replace(/\r\n/g, '\n');
const CONNECTION = 'conn_browser1';

const line = (text: string | null) =>
  text === null ? '-' : Buffer.from(text, 'utf8').toString('base64');
const decoded = (text: string) =>
  text === '-' ? null : Buffer.from(text, 'base64').toString('utf8');

async function files(
  input: { settings?: string; contract?: string | null; connections?: string | null },
  args: string[] = ['files', '--connection', CONNECTION],
) {
  const context = testContext(temporaryDeployDir());
  const stdin = `${line(input.settings ?? '')}\n${line(input.contract ?? null)}\n${line(input.connections ?? null)}\n`;
  const code = await runBrowserFiles(context, args, async () => stdin);
  const [contract = '', connections = ''] = context.printed().trim().split('\n');
  return { code, context, contract: decoded(contract), connections: decoded(connections) };
}

describe('melete browser files', () => {
  test('writes the contract out from the settings, with the overlay, and adds the connection', async () => {
    const result = await files({
      settings: 'COMPOSE_PROJECT_NAME=home\nMELETE_IMAGE_TAG=v0.2.1\n',
      connections: '[]\n',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.contract ?? '')).toMatchObject({
      contract: 1,
      project: 'home',
      overlays: ['browser'],
      images: { registry: 'ghcr.io/ychampion', tag: 'v0.2.1', channel: 'release' },
    });
    expect(result.connections).toBe(
      `${JSON.stringify([{ kind: 'browser', id: CONNECTION }], null, 2)}\n`,
    );
  });

  test('changes nothing when the overlay and the connection are there already', async () => {
    const first = await files({ settings: 'MELETE_IMAGE_TAG=main\n', connections: '[]' });
    const again = await files({
      settings: 'MELETE_IMAGE_TAG=main\n',
      contract: first.contract,
      connections: first.connections,
    });
    expect(again.code).toBe(0);
    expect(again.context.printed()).toBe('-\n-\n');
  });

  test('keeps the other entries and adds the overlay to a contract that has others', async () => {
    const contract = `${JSON.stringify({ contract: 1, overlays: ['tailscale'] })}\n`;
    const result = await files({
      contract,
      connections: JSON.stringify([{ kind: 'mcp', id: 'conn_other' }]),
    });
    expect(JSON.parse(result.contract ?? '').overlays).toEqual(['tailscale', 'browser']);
    expect(JSON.parse(result.connections ?? '')).toEqual([
      { kind: 'mcp', id: 'conn_other' },
      { kind: 'browser', id: CONNECTION },
    ]);
  });

  test('reads only the contract settings', async () => {
    const result = await files({
      settings: 'MELETE_IMAGE_TAG=main\nCOMPOSE_PROJECT_NAME=Not A Project\n',
    });
    // A project name the contract refuses leaves the defaults, as readInstallation does.
    expect(JSON.parse(result.contract ?? '').project).toBe('melete');
    expect(CONTRACT_SETTINGS).not.toContain('MELETE_BROWSER_TOKEN');
  });

  test('refuses a contract or connections file it cannot read, and a wrong id', async () => {
    const invalid = await files({ contract: '{"contract": 1, "overlay": []}' });
    expect(invalid.code).toBe(2);
    expect(invalid.context.errors()).toContain('melete.deploy.json is not valid');
    expect(invalid.context.printed()).toBe('');

    const broken = await files({ connections: '{' });
    expect(broken.code).toBe(2);
    expect(broken.context.errors()).toContain('connections.json is not JSON');

    expect((await files({}, ['files', '--connection', 'sp_wrong'])).code).toBe(2);
    expect((await files({}, ['files'])).code).toBe(2);
    const short = testContext(temporaryDeployDir());
    expect(
      await runBrowserFiles(short, ['files', '--connection', CONNECTION], async () => '-\n'),
    ).toBe(2);
  });
});

describe('the browser judgment inside the service container', () => {
  const service = (environment: Record<string, string>, connections: string) => {
    const deployDir = temporaryDeployDir();
    const file = join(mkdtempSync(join(tmpdir(), 'melete-etc-')), 'connections.json');
    writeFileSync(file, connections);
    return judgeBrowser(readInstallation(deployDir), {
      MELETE_CONNECTIONS_FILE: file,
      ...environment,
    });
  };
  const on = {
    MELETE_BROWSER_URL: 'http://browser:3132',
    MELETE_BROWSER_SPACE: 'sp_first',
    MELETE_BROWSER_TOKEN: 'a'.repeat(64),
  };
  const listed = JSON.stringify([{ kind: 'browser', id: CONNECTION }]);

  test('is ok with the overlay, its settings and the connection', () => {
    expect(service(on, listed)).toEqual([
      { id: 'browser.worker', level: 'ok', detail: 'The browser worker works for sp_first.' },
    ]);
  });

  test('reports the worker off, with the installer command, without the overlay', () => {
    const [result] = service({}, '[]');
    expect(result?.level).toBe('warn');
    expect(result?.fix).toContain('MELETE_BROWSER=1 curl -fsSL');
  });

  test('fails a listed connection without the overlay, and a short token', () => {
    expect(service({}, listed)[0]?.level).toBe('fail');
    expect(service({ ...on, MELETE_BROWSER_TOKEN: 'short' }, listed)[0]?.level).toBe('fail');
  });

  test('judges nothing outside the service with no deploy/.env', () => {
    expect(judgeBrowser(readInstallation(temporaryDeployDir()), {})).toEqual([]);
  });
});

describe('the installer turns the worker on as browser enable does', () => {
  test('its provisioning script is browser enable’s', () => {
    const match = /^PROVISION_SCRIPT='([^']*)'$/m.exec(INSTALLER);
    expect(match?.[1]).toBe(PROVISION_SCRIPT);
  });

  test('its provisioning container is browser enable’s', () => {
    const body = /^provision_browser_dir\(\) \{\n([\s\S]*?)\n\}$/m.exec(INSTALLER)?.[1] ?? '';
    const words = body
      .replace(/\\\n/g, ' ')
      .split('\n')
      .filter((text) => !/^\s*local /.test(text))
      .join(' ')
      .replace(/"/g, '')
      .trim()
      .split(/\s+/)
      .filter((word) => word !== 'MSYS_NO_PATHCONV=1');
    expect(words).toEqual(
      provisionCommand('$volume', '$space', '$image').map((word) =>
        word === PROVISION_SCRIPT ? '$PROVISION_SCRIPT' : word,
      ),
    );
  });

  test('it asks the service with the same script, and sends only the contract settings', () => {
    expect(INSTALLER).toContain(`exec -T melete bun run ${SERVICE_SCRIPT}`);
    expect(INSTALLER).toContain(`grep -E '^(${CONTRACT_SETTINGS.join('|')})='`);
    expect(INSTALLER).toContain(SPACE_ID.source.replace(/^\^|\$$/g, ''));
    expect(INSTALLER).toContain(CONNECTION_ID.source.replace(/^\^|\$$/g, ''));
  });

  // The installer's functions, without its last line, which runs it.
  const bash = Bun.which('bash');
  const library = () => {
    expect(INSTALLER.endsWith('\nmain "$@"\n')).toBe(true);
    const path = join(mkdtempSync(join(tmpdir(), 'melete-installer-')), 'install-lib.sh');
    writeFileSync(path, INSTALLER.slice(0, -'main "$@"\n'.length));
    return path;
  };
  const shell = (script: string, environment: Record<string, string>) => {
    const run = Bun.spawnSync(
      [bash ?? 'bash', '-c', `set -euo pipefail; source "$LIB"; ${script}`],
      {
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    return run.stdout.toString();
  };

  test.skipIf(!bash)('set_env writes deploy/.env as withSetting does', () => {
    const lib = library();
    const cases: [string, string, string][] = [
      ['A=1\nMELETE_BROWSER_SPACE=\nB=2\n', 'MELETE_BROWSER_SPACE', 'sp_first'],
      ['A=1\n  export MELETE_BROWSER_SPACE = old\n', 'MELETE_BROWSER_SPACE', 'sp_first'],
      ['A=1\n', 'MELETE_BROWSER_TOKEN', 'f'.repeat(64)],
      ['A=1', 'MELETE_BROWSER_TOKEN', 'x&y\\z/w'],
      [
        'MELETE_IMAGE_TAG=main\n# MELETE_IMAGE_TAG=old\nMELETE_IMAGE_TAG=dup\n',
        'MELETE_IMAGE_TAG',
        'v1',
      ],
    ];
    for (const [before, name, value] of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'melete-deploy-'));
      writeFileSync(join(dir, '.env'), before);
      shell('set_env "$NAME" "$VALUE"', { LIB: lib, DEPLOY: dir, NAME: name, VALUE: value });
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(withSetting(before, name, value));
    }
  });

  test.skipIf(!bash)('a file goes to the service image and comes back unchanged', () => {
    const lib = library();
    const dir = mkdtempSync(join(tmpdir(), 'melete-deploy-'));
    const text = `${JSON.stringify([{ kind: 'browser', id: CONNECTION }], null, 2)}\n`;
    writeFileSync(join(dir, 'in.json'), text);
    const sent = shell('file_line "$DEPLOY/in.json"; file_line "$DEPLOY/missing.json"', {
      LIB: lib,
      DEPLOY: dir,
    });
    expect(sent).toBe(`${line(text)}\n-\n`);
    shell('replace_public "$DEPLOY/out.json" "$LINE"', { LIB: lib, DEPLOY: dir, LINE: line(text) });
    expect(readFileSync(join(dir, 'out.json'), 'utf8')).toBe(text);
  });
});
