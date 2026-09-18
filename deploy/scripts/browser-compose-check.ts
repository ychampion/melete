/**
 * Check the browser override without pretending to run a container. The override
 * is deliberately additive: rejecting unreviewed merge fields avoids guessing at
 * Compose semantics when a mount, environment file, or shared namespace is added.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { boundedLogging, type CheckResult, unboundedServices } from './compose-check.ts';

export type BrowserComposeFile = {
  services?: Record<string, Record<string, unknown>>;
  networks?: Record<string, Record<string, unknown> | null>;
  volumes?: Record<string, unknown>;
  [key: string]: unknown;
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expands this required variable.
const SPACE = '${MELETE_BROWSER_SPACE:?set MELETE_BROWSER_SPACE in .env}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expands this required variable.
const TOKEN = '${MELETE_BROWSER_TOKEN:?set MELETE_BROWSER_TOKEN in .env}';
const CONTROL = 'browser-control';
const EGRESS = 'browser-egress';
/** Relative to this compose file, which is how the engine is given the profile. */
export const BROWSER_SECCOMP = './config/browser-seccomp.json';
/** CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC: not the sandbox's to make. */
const DENIED_NAMESPACES = 0x0e020000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((name) => typeof name === 'string');
  return Object.keys(record(value) ?? {});
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((name) => actual.includes(name));
}

function hasOnly(value: Record<string, unknown> | undefined, allowed: readonly string[]): boolean {
  return Boolean(value) && Object.keys(value ?? {}).every((key) => allowed.includes(key));
}

export function checkBrowserCompose(
  base: BrowserComposeFile,
  override: BrowserComposeFile,
): CheckResult[] {
  const results: CheckResult[] = [];
  const say = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
  const browser = override.services?.browser;
  const broker = override.services?.melete;
  const workerNetworks = names(browser?.networks);
  const brokerNetworks = [
    ...new Set([...names(base.services?.melete?.networks), ...names(broker?.networks)]),
  ];

  say(
    'the browser override only adds its worker and broker connection',
    hasOnly(override, ['services', 'networks']) &&
      sameNames(Object.keys(override.services ?? {}), ['melete', 'browser']) &&
      sameNames(Object.keys(override.networks ?? {}), [CONTROL, EGRESS]) &&
      !base.services?.browser &&
      !base.networks?.[CONTROL] &&
      !base.networks?.[EGRESS] &&
      hasOnly(broker, ['networks', 'environment', 'depends_on']),
    'the override must not redefine existing service privileges, mounts, or networks',
  );

  const control = override.networks?.[CONTROL];
  const egress = override.networks?.[EGRESS];
  say(
    'the control network is internal and the egress network is separate',
    control?.internal === true &&
      control.driver === 'bridge' &&
      hasOnly(control, ['driver', 'internal']) &&
      egress?.internal === false &&
      egress.driver === 'bridge' &&
      hasOnly(egress, ['driver', 'internal']),
    'control must have no default route; egress must be a dedicated local bridge',
  );
  say(
    'the browser only joins its control and egress networks',
    sameNames(workerNetworks, [CONTROL, EGRESS]),
    `browser networks: ${workerNetworks.join(', ')}`,
  );
  // The broker keeps every network the base stack gives it (edge, internal and,
  // since the database moved off the runtime network, database) and gains only
  // the control network; the worker's egress network stays its own.
  const baseBrokerNetworks = names(base.services?.melete?.networks);
  say(
    'only the broker shares a browser network',
    baseBrokerNetworks.includes('edge') &&
      baseBrokerNetworks.includes('internal') &&
      !baseBrokerNetworks.includes(CONTROL) &&
      !baseBrokerNetworks.includes(EGRESS) &&
      sameNames(brokerNetworks, [...baseBrokerNetworks, CONTROL]) &&
      Object.entries(base.services ?? {}).every(
        ([name, service]) =>
          name === 'melete' ||
          names(service.networks).every((network) => !workerNetworks.includes(network)),
      ),
    'runtime, postgres, web, and other workers must not share either browser network',
  );

  if (!browser) {
    say('the browser service exists', false, 'no browser service in the override');
    return results;
  }
  say(
    'the browser has no unreviewed privilege or credential channels',
    hasOnly(browser, [
      'build',
      'restart',
      'init',
      'networks',
      'user',
      'read_only',
      'cap_drop',
      'security_opt',
      'pids_limit',
      'mem_limit',
      'shm_size',
      'tmpfs',
      'stop_grace_period',
      'environment',
      'volumes',
      'healthcheck',
      'logging',
    ]),
    'ports, env_file, secrets, configs, host namespaces, devices, and privilege overrides are refused',
  );
  const build = record(browser.build);
  say(
    'the browser runs its dedicated image as its own uid',
    build?.context === '..' &&
      build.dockerfile === 'deploy/Dockerfile.browser' &&
      hasOnly(build, ['context', 'dockerfile']) &&
      browser.user === '10003:10003' &&
      base.services?.runtime?.user !== browser.user &&
      base.services?.melete?.user !== browser.user,
    'browser uid 10003 differs from runtime uid 10001 and the service image uid 10002',
  );
  const options = names(browser.security_opt).map((option) => option.replace(/\s/g, ''));
  say(
    'the browser drops capabilities and cannot gain privileges',
    browser.read_only === true &&
      browser.privileged === undefined &&
      sameNames(names(browser.cap_drop), ['ALL']) &&
      sameNames(options, ['no-new-privileges:true', `seccomp=${BROWSER_SECCOMP}`]),
    `read_only, cap_drop ALL, no-new-privileges and seccomp=${BROWSER_SECCOMP} are required`,
  );
  say(
    'the browser has bounded private temporary storage and process limits',
    browser.init === true &&
      typeof browser.pids_limit === 'number' &&
      browser.pids_limit > 0 &&
      browser.pids_limit <= 512 &&
      typeof browser.mem_limit === 'string' &&
      /^(?:[1-4]g|[1-9]\d{1,3}m)$/.test(browser.mem_limit) &&
      browser.shm_size === '256m' &&
      sameNames(names(browser.tmpfs), ['/tmp:size=256m,mode=1777']),
    'use a private /tmp and /dev/shm, an init process, and finite memory and pid limits',
  );

  // The override cannot replace a base service's logging (the broker entry above
  // admits three keys only), so the merged stack is bounded when both files are.
  const unbounded = [
    ...unboundedServices(base.services ?? {}),
    ...(boundedLogging(browser.logging) ? [] : ['browser']),
  ];
  say(
    'the browser stack keeps bounded logs',
    unbounded.length === 0,
    `services without a json-file max-size and max-file: ${unbounded.join(', ')}`,
  );

  const environment = record(browser.environment);
  const expectedEnvironment = {
    MELETE_BROWSER_SPACE: SPACE,
    MELETE_BROWSER_ROOT: '/space',
    MELETE_BROWSER_TOKEN: TOKEN,
    MELETE_BROWSER_HOST: '0.0.0.0',
    MELETE_BROWSER_PORT: '3132',
    PLAYWRIGHT_BROWSERS_PATH: '/opt/chromium',
  };
  say(
    'the worker receives only its space and control configuration',
    sameNames(Object.keys(environment ?? {}), Object.keys(expectedEnvironment)) &&
      Object.entries(expectedEnvironment).every(([key, value]) => environment?.[key] === value),
    'no database URL, vault key, provider key, global roots, or inherited environment is permitted',
  );

  const mounts = Array.isArray(browser.volumes) ? browser.volumes : [];
  const mount = record(mounts[0]);
  const volume = record(mount?.volume);
  say(
    'the browser mounts exactly one space subdirectory',
    Object.hasOwn(base.volumes ?? {}, 'spaces') &&
      mounts.length === 1 &&
      mount?.type === 'volume' &&
      mount.source === 'spaces' &&
      mount.target === '/space' &&
      mount.read_only === false &&
      hasOnly(mount, ['type', 'source', 'target', 'read_only', 'volume']) &&
      volume?.subpath === SPACE &&
      volume.nocopy === true &&
      hasOnly(volume, ['subpath', 'nocopy']),
    'only spaces/<space id> may be mounted; no all-spaces root, artifacts root, work, or socket',
  );

  const brokerEnvironment = record(broker?.environment);
  say(
    'the broker connects to the matching private worker endpoint',
    sameNames(Object.keys(brokerEnvironment ?? {}), [
      'MELETE_BROWSER_URL',
      'MELETE_BROWSER_SPACE',
      'MELETE_BROWSER_TOKEN',
    ]) &&
      brokerEnvironment?.MELETE_BROWSER_URL === 'http://browser:3132' &&
      brokerEnvironment.MELETE_BROWSER_SPACE === SPACE &&
      brokerEnvironment.MELETE_BROWSER_TOKEN === TOKEN &&
      record(record(broker?.depends_on)?.browser)?.condition === 'service_healthy' &&
      hasOnly(record(broker?.depends_on), ['browser']),
    'only the matching space and broker token may configure this worker',
  );
  return results;
}

/** The worker image installs its runtime packages at exactly the versions the service pins. */
export function checkBrowserImage(
  dockerfile: string,
  servicePackage: { dependencies?: Record<string, string> },
): CheckResult {
  const expected = ['playwright', 'tldts', 'zod'].map(
    (name) => `${name}@${servicePackage.dependencies?.[name]}`,
  );
  const installed =
    /npm install --omit=dev --ignore-scripts --save-exact ([^\\\n]+)/
      .exec(dockerfile)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  return {
    name: 'the browser image installs exactly its pinned runtime packages',
    ok: sameNames(installed, expected),
    detail: `expected ${expected.join(' ')}; the image installs ${installed.join(' ') || 'nothing'}`,
  };
}

type SeccompRule = {
  names?: string[];
  action?: string;
  args?: { index?: number; value?: number; op?: string }[];
  comment?: string;
  includes?: { caps?: string[]; arches?: string[] };
  excludes?: { caps?: string[]; arches?: string[] };
};
type SeccompProfile = { defaultAction?: string; syscalls?: SeccompRule[] };

/**
 * The engine's own default profile, as moby v28.0.1 ships it, hashed with its keys in order.
 * Pinned rather than described: a rule added anywhere in it — an unconditional ptrace, a mount,
 * a bpf — changes this digest, which is the only way to tell a narrowed profile from a widened
 * one by reading it.
 */
const ENGINE_DEFAULT_DIGEST = '885442dc08f21f8d60f99ea43d59af88b1c529103815fe24bbf9ce998d3a609d';

/** What Chromium's sandbox needs on top of that default, in the order the profile carries them. */
const SANDBOX_ADDITIONS: SeccompRule[] = [
  {
    names: ['clone', 'unshare'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: DENIED_NAMESPACES, op: 'SCMP_CMP_MASKED_EQ' }],
    comment: "Chromium's sandbox makes a user, pid and net namespace for each renderer",
    includes: {},
    excludes: { arches: ['s390', 's390x'] },
  },
  {
    names: ['clone', 'unshare'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 1, value: DENIED_NAMESPACES, op: 'SCMP_CMP_MASKED_EQ' }],
    comment: 'The same, where the flags are the second argument',
    includes: { arches: ['s390', 's390x'] },
    excludes: {},
  },
  {
    names: ['chroot'],
    action: 'SCMP_ACT_ALLOW',
    args: [],
    comment: 'The zygote chroots to an empty directory inside its own user namespace',
    includes: {},
    excludes: {},
  },
];

/** The same bytes for the same profile however it is formatted: keys in order, no spacing. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

/** The digest of a profile with the sandbox's own rules taken back off the end of it. */
export function engineDefaultDigest(profile: SeccompProfile): string {
  const rules = profile.syscalls ?? [];
  const base = { ...profile, syscalls: rules.slice(0, -SANDBOX_ADDITIONS.length) };
  return createHash('sha256').update(canonical(base)).digest('hex');
}

/**
 * The profile the worker container is given: the engine's own default, unchanged, plus exactly
 * the three rules Chromium's sandbox needs. Both halves are checked, because a profile that
 * merely *contains* those three rules can allow anything else beside them.
 */
export function checkBrowserSandbox(profile: string | undefined): CheckResult {
  const name = 'the browser renderer sandbox has a profile of its own';
  const detail =
    "the profile must be the engine's default profile, unchanged, plus exactly the clone, " +
    'unshare and chroot rules the sandbox makes its own namespaces with';
  let parsed: SeccompProfile;
  try {
    parsed = JSON.parse(profile ?? '') as SeccompProfile;
  } catch {
    return { name, ok: false, detail: `${BROWSER_SECCOMP} is missing or is not JSON` };
  }
  const rules = parsed.syscalls ?? [];
  const added = rules.slice(-SANDBOX_ADDITIONS.length);
  const ok =
    parsed.defaultAction === 'SCMP_ACT_ERRNO' &&
    rules.length > SANDBOX_ADDITIONS.length &&
    canonical(added) === canonical(SANDBOX_ADDITIONS) &&
    engineDefaultDigest(parsed) === ENGINE_DEFAULT_DIGEST;
  return { name, ok, detail };
}

export function loadBrowserCompose(path: string): BrowserComposeFile {
  return parse(readFileSync(path, 'utf8')) as BrowserComposeFile;
}

export const browserComposePaths = () => {
  const deploy = join(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    base: join(deploy, 'docker-compose.yml'),
    override: join(deploy, 'docker-compose.browser.yml'),
  };
};

if (import.meta.main) {
  const paths = browserComposePaths();
  const results = checkBrowserCompose(
    loadBrowserCompose(process.argv[2] ?? paths.base),
    loadBrowserCompose(process.argv[3] ?? paths.override),
  );
  results.push(
    checkBrowserImage(
      readFileSync(join(dirname(paths.base), 'Dockerfile.browser'), 'utf8'),
      JSON.parse(
        readFileSync(join(dirname(paths.base), '..', 'apps', 'melete', 'package.json'), 'utf8'),
      ),
    ),
  );
  // Read by the path the compose file names, so a profile that is not there fails the check.
  let profile: string | undefined;
  try {
    profile = readFileSync(join(dirname(paths.override), BROWSER_SECCOMP), 'utf8');
  } catch {
    profile = undefined;
  }
  results.push(checkBrowserSandbox(profile));
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`);
    if (!result.ok) process.stdout.write(`     ${result.detail}\n`);
  }
  const failures = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `browser-compose:check ${failures ? 'failed' : 'passed'} (${results.length} checks)\n`,
  );
  process.exit(failures ? 1 : 0);
}
