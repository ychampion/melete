import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BrowserComposeFile,
  browserComposePaths,
  checkBrowserCompose,
  loadBrowserCompose,
} from './browser-compose-check.ts';

const paths = browserComposePaths();
const base = loadBrowserCompose(paths.base);
const override = loadBrowserCompose(paths.override);
const failures = (file: BrowserComposeFile, original = base) =>
  checkBrowserCompose(original, file)
    .filter((result) => !result.ok)
    .map((result) => result.name);

function mutation(change: (browser: Record<string, unknown>) => void) {
  const broken = structuredClone(override);
  const browser = broken.services?.browser;
  if (!browser) throw new Error('browser fixture is missing');
  change(browser);
  return broken;
}

describe('the isolated browser deployment', () => {
  test('accepts the shipped additive override', () => {
    expect(failures(override)).toEqual([]);
  });

  test('uses the pinned Node worker image and a distinct numeric uid', () => {
    const image = readFileSync(join(paths.base, '..', 'Dockerfile.browser'), 'utf8');
    const serviceImage = readFileSync(join(paths.base, '..', 'Dockerfile.melete'), 'utf8');
    const rootPackage = JSON.parse(readFileSync(join(paths.base, '../..', 'package.json'), 'utf8'));
    const servicePackage = JSON.parse(
      readFileSync(join(paths.base, '../..', 'apps/melete/package.json'), 'utf8'),
    );
    expect(image).toContain('FROM node:24.14.0-bookworm-slim');
    expect(image).toContain(`playwright@${rootPackage.devDependencies.playwright}`);
    expect(servicePackage.dependencies.playwright).toBe(rootPackage.devDependencies.playwright);
    expect(image).toContain(`zod@${servicePackage.dependencies.zod}`);
    expect(image).toContain('playwright install --with-deps chromium');
    expect(image).toContain('USER 10003:10003');
    expect(image).toContain(
      'CMD ["node", "--experimental-transform-types", "apps/melete/src/workers/browser/entry.ts"]',
    );
    expect(serviceImage).toContain('--uid 10002');
    expect(image).not.toMatch(/COPY\s+(?:\.\s|deploy\/config|packages\/)/);
  });

  test.each(['internal', 'edge'])('refuses giving the worker the %s network', (network) => {
    const broken = mutation((browser) => {
      browser.networks = ['browser-control', 'browser-egress', network];
    });
    expect(failures(broken)).toContain('the browser only joins its control and egress networks');
    expect(failures(broken)).toContain('only the broker shares a browser network');
  });

  test.each(['runtime', 'postgres', 'web'])('refuses giving %s a browser network', (name) => {
    const broken = structuredClone(base);
    const peer = broken.services?.[name];
    if (!peer) throw new Error(`missing ${name}`);
    peer.networks = ['browser-control'];
    expect(failures(override, broken)).toContain('only the broker shares a browser network');
  });

  test('refuses attaching another worker to egress', () => {
    const broken = structuredClone(base);
    if (!broken.services) throw new Error('missing services');
    broken.services.sibling = { networks: ['browser-egress'] };
    expect(failures(override, broken)).toContain('only the broker shares a browser network');
  });

  test('refuses turning the control network into a routed or external network', () => {
    for (const network of [
      { driver: 'bridge', internal: false },
      { internal: true, external: true },
    ]) {
      const broken = structuredClone(override);
      if (!broken.networks) throw new Error('missing networks');
      broken.networks['browser-control'] = network;
      expect(failures(broken)).toContain(
        'the control network is internal and the egress network is separate',
      );
    }
  });

  test.each([
    ['ports', ['3132:3132']],
    ['env_file', ['.env']],
    ['secrets', ['master_key']],
    ['volumes_from', ['melete']],
    ['network_mode', 'host'],
    ['pid', 'host'],
    ['ipc', 'host'],
    ['privileged', true],
    ['cap_add', ['SYS_ADMIN']],
    ['command', ['sh']],
  ])('refuses the alternate privilege or credential channel %s', (key, value) => {
    const broken = mutation((browser) => {
      browser[String(key)] = value;
    });
    expect(failures(broken)).toContain(
      'the browser has no unreviewed privilege or credential channels',
    );
  });

  test.each(['DATABASE_URL', 'MELETE_MASTER_KEY', 'MELETE_SPACES_DIR', 'FIREWORKS_API_KEY'])(
    'refuses injecting %s into the worker',
    (key) => {
      const broken = mutation((browser) => {
        browser.environment = {
          ...(browser.environment as object),
          [key]: 'must-not-be-inherited',
        };
      });
      expect(failures(broken)).toContain(
        'the worker receives only its space and control configuration',
      );
    },
  );

  test.each([
    { type: 'volume', source: 'spaces', target: '/space' },
    { type: 'volume', source: 'spaces', target: '/space', volume: { subpath: '..' } },
    { type: 'bind', source: '/', target: '/space' },
  ])('refuses a broader profile mount %j', (mount) => {
    const broken = mutation((browser) => {
      browser.volumes = [mount];
    });
    expect(failures(broken)).toContain('the browser mounts exactly one space subdirectory');
  });

  test.each([
    'artifacts:/data/artifacts',
    'work:/work',
    '/var/run/docker.sock:/var/run/docker.sock',
  ])('refuses the additional mount %s', (mount) => {
    const broken = mutation((browser) => {
      browser.volumes = [...(browser.volumes as unknown[]), mount];
    });
    expect(failures(broken)).toContain('the browser mounts exactly one space subdirectory');
  });

  test.each(['0:0', '10001:10001', '10002:10002'])('refuses shared or root uid %s', (user) => {
    const broken = mutation((browser) => {
      browser.user = user;
    });
    expect(failures(broken)).toContain('the browser runs its dedicated image as its own uid');
  });

  test('refuses removing read-only, capability, or privilege enforcement', () => {
    for (const field of ['read_only', 'cap_drop', 'security_opt']) {
      const broken = mutation((browser) => {
        delete browser[field];
      });
      expect(failures(broken)).toContain(
        'the browser drops capabilities and cannot gain privileges',
      );
    }
  });

  test('refuses broadening the broker override or mismatching its endpoint', () => {
    const broken = structuredClone(override);
    const broker = broken.services?.melete;
    if (!broker) throw new Error('missing broker');
    broker.volumes = ['spaces:/new-root'];
    broker.environment = {
      ...(broker.environment as object),
      MELETE_BROWSER_URL: 'http://runtime:3132',
    };
    expect(failures(broken)).toContain(
      'the browser override only adds its worker and broker connection',
    );
    expect(failures(broken)).toContain(
      'the broker connects to the matching private worker endpoint',
    );
  });
});
