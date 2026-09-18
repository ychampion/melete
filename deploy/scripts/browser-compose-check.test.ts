import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_SECCOMP,
  type BrowserComposeFile,
  browserComposePaths,
  checkBrowserCompose,
  checkBrowserImage,
  checkBrowserSandbox,
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

  test('the worker keeps the same bounded json-file logs as the base services', () => {
    expect(override.services?.browser?.logging).toEqual(base.services?.melete?.logging);
    const unbounded = mutation((browser) => {
      delete browser.logging;
    });
    expect(failures(unbounded)).toContain('the browser stack keeps bounded logs');
    const unlimited = mutation((browser) => {
      browser.logging = { driver: 'json-file', options: { 'max-file': '5' } };
    });
    expect(failures(unlimited)).toContain('the browser stack keeps bounded logs');
    const baseWithout = structuredClone(base);
    delete baseWithout.services?.postgres?.logging;
    expect(failures(override, baseWithout)).toContain('the browser stack keeps bounded logs');
  });

  test('the image installs exactly the runtime packages the service pins', () => {
    const image = readFileSync(join(paths.base, '..', 'Dockerfile.browser'), 'utf8');
    const servicePackage = JSON.parse(
      readFileSync(join(paths.base, '../..', 'apps/melete/package.json'), 'utf8'),
    );
    expect(checkBrowserImage(image, servicePackage)).toMatchObject({ ok: true });
    const tldts = `tldts@${servicePackage.dependencies.tldts}`;
    for (const broken of [
      image.replace(` ${tldts}`, ''),
      image.replace(tldts, 'tldts@0.0.1'),
      image.replace(tldts, `${tldts} left-pad@1.3.0`),
      image.replace(`zod@${servicePackage.dependencies.zod}`, 'zod@3.0.0'),
      image.replace('--save-exact', '--save'),
    ])
      expect(checkBrowserImage(broken, servicePackage).ok).toBe(false);
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

  test('refuses a worker without the renderer sandbox profile, or with it turned off', () => {
    expect(override.services?.browser?.security_opt).toContain(`seccomp=${BROWSER_SECCOMP}`);
    for (const security of [
      ['no-new-privileges:true'],
      ['no-new-privileges:true', 'seccomp=unconfined'],
      ['no-new-privileges:true', 'seccomp=./config/somebody-elses.json'],
      ['seccomp=./config/browser-seccomp.json'],
      ['no-new-privileges:true', 'seccomp=./config/browser-seccomp.json', 'apparmor=unconfined'],
    ]) {
      const broken = mutation((browser) => {
        browser.security_opt = security;
      });
      expect([security, failures(broken)]).toEqual([
        security,
        expect.arrayContaining(['the browser drops capabilities and cannot gain privileges']),
      ]);
    }
    const elevated = mutation((browser) => {
      browser.privileged = true;
    });
    expect(failures(elevated)).toContain(
      'the browser drops capabilities and cannot gain privileges',
    );
  });

  test('the seccomp profile refuses by default and opens only the sandbox namespaces', () => {
    const profile = readFileSync(join(paths.override, '..', BROWSER_SECCOMP), 'utf8');
    expect(checkBrowserSandbox(profile)).toMatchObject({ ok: true });
    const shipped = JSON.parse(profile) as {
      defaultAction: string;
      syscalls: { names?: string[]; action?: string; args?: { value?: number }[] }[];
    };
    // Docker's own floor is kept: this is that profile with the namespace calls added.
    expect(shipped.syscalls.length).toBeGreaterThan(30);
    expect(shipped.syscalls.flatMap((rule) => rule.names ?? []).length).toBeGreaterThan(400);

    const permissive = { ...shipped, defaultAction: 'SCMP_ACT_ALLOW' };
    const widened = {
      ...shipped,
      // The same rules, but the mask no longer keeps mount, uts, ipc and cgroup namespaces shut.
      syscalls: shipped.syscalls.map((rule) =>
        (rule.args ?? []).some((argument) => argument.value === 0x0e020000)
          ? { ...rule, args: [{ index: 0, value: 0, op: 'SCMP_CMP_MASKED_EQ' }] }
          : rule,
      ),
    };
    const withoutChroot = {
      ...shipped,
      syscalls: shipped.syscalls.filter((rule) => !(rule.names ?? []).includes('chroot')),
    };
    for (const broken of [undefined, '', 'not json', JSON.stringify({ syscalls: [] })])
      expect([broken, checkBrowserSandbox(broken).ok]).toEqual([broken, false]);
    for (const broken of [permissive, widened, withoutChroot])
      expect(checkBrowserSandbox(JSON.stringify(broken)).ok).toBe(false);
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
