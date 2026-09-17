/**
 * Check the Tailscale override, its serve configuration and the kernel-mode
 * opt-in without running a container. The point of the override is a private
 * route in: one node on the edge network, no published port, no public
 * exposure. Every one of those is a property of the YAML, so a change that
 * would undo it fails here rather than on somebody's tailnet.
 *
 * Like the browser override, this one is deliberately additive and refuses
 * unreviewed merge fields: a new mount, device, capability or environment file
 * has to be read by a person before it can reach the node.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { boundedLogging, type CheckResult, unboundedServices } from './compose-check.ts';

export type TailscaleComposeFile = {
  services?: Record<string, Record<string, unknown>>;
  networks?: Record<string, Record<string, unknown> | null>;
  volumes?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The serve configuration as tailscaled reads it. */
export type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string } | null>;
  Web?: Record<string, { Handlers?: Record<string, Record<string, unknown>> } | null>;
  AllowFunnel?: Record<string, boolean>;
  [key: string]: unknown;
};

const SERVICE = 'tailscale';
const STATE_VOLUME = 'tailscale-state';
const STATE_DIR = '/var/lib/tailscale';
const SERVE_PATH = '/etc/tailscale/serve.json';
const SERVE_MOUNT = `./config/tailscale-serve.json:${SERVE_PATH}:ro`;
const UPSTREAM = 'MELETE_WEB_TRUSTED_UPSTREAM';
// biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expands this required variable.
const AUTHKEY = '${TS_AUTHKEY:?set TS_AUTHKEY in deploy/.env}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: tailscaled expands this at startup.
const CERT_DOMAIN = '${TS_CERT_DOMAIN}:443';
const WEB_TARGET = 'http://web:3000';
/** A version tag, optionally pinned further by digest. Never a moving name. */
const PINNED_IMAGE = /^tailscale\/tailscale:v\d+\.\d+\.\d+(?:@sha256:[0-9a-f]{64})?$/;
const MOVING_TAG = /:(?:latest|stable|unstable)(?:@|$)/;

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

/** The one handler a serve configuration may carry, and where it points. */
function singleHandler(serve: ServeConfig): Record<string, unknown> | undefined {
  const hosts = Object.keys(serve.Web ?? {});
  if (hosts.length !== 1 || hosts[0] !== CERT_DOMAIN) return undefined;
  const handlers = serve.Web?.[CERT_DOMAIN]?.Handlers ?? {};
  const paths = Object.keys(handlers);
  return paths.length === 1 && paths[0] === '/' ? record(handlers['/']) : undefined;
}

export function checkTailscaleCompose(
  base: TailscaleComposeFile,
  override: TailscaleComposeFile,
  kernel: TailscaleComposeFile,
  serve: ServeConfig,
): CheckResult[] {
  const results: CheckResult[] = [];
  const say = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
  const node = override.services?.[SERVICE];
  const web = override.services?.web;
  const environment = record(node?.environment) ?? {};

  say(
    'the Tailscale override only adds its node and the web upstream setting',
    hasOnly(override, ['services', 'volumes']) &&
      sameNames(Object.keys(override.services ?? {}), ['web', SERVICE]) &&
      sameNames(Object.keys(override.volumes ?? {}), [STATE_VOLUME]) &&
      hasOnly(web, ['environment']) &&
      sameNames(Object.keys(record(web?.environment) ?? {}), [UPSTREAM]) &&
      record(web?.environment)?.[UPSTREAM] === SERVICE &&
      !base.services?.[SERVICE] &&
      !Object.hasOwn(base.volumes ?? {}, STATE_VOLUME),
    'the override must not redefine existing service privileges, mounts, ports, or networks',
  );

  if (!node) {
    say('the Tailscale service exists', false, `no ${SERVICE} service in the override`);
    return results;
  }

  say(
    'the node has no unreviewed privilege, device or credential channels',
    hasOnly(node, [
      'image',
      'restart',
      'logging',
      'networks',
      'depends_on',
      'environment',
      'read_only',
      'cap_drop',
      'security_opt',
      'pids_limit',
      'mem_limit',
      'tmpfs',
      'volumes',
      'healthcheck',
    ]),
    'ports, env_file, secrets, configs, devices, host namespaces, and privilege overrides are refused',
  );

  const networks = names(node.networks);
  say(
    'the node joins the edge network only',
    sameNames(networks, ['edge']) &&
      !networks.includes('database') &&
      !networks.includes('internal') &&
      Object.hasOwn(base.networks ?? {}, 'edge'),
    `tailscale.networks is [${networks.join(', ')}]; the node must never reach the database or runtime network`,
  );

  say(
    'the node publishes nothing on a host interface',
    node.ports === undefined &&
      node.network_mode === undefined &&
      (base.services?.web?.ports ?? undefined) !== undefined,
    'a published port would put this node on an address the tailnet does not gate',
  );

  say(
    'the node runs userspace networking without kernel privileges',
    environment.TS_USERSPACE === 'true' &&
      node.privileged === undefined &&
      node.cap_add === undefined &&
      node.devices === undefined &&
      sameNames(names(node.cap_drop), ['ALL']) &&
      sameNames(names(node.security_opt), ['no-new-privileges:true']) &&
      node.read_only === true,
    'the default node needs no /dev/net/tun and no NET_ADMIN; kernel mode is the separate opt-in file',
  );

  say(
    'the node has bounded memory, processes and private temporary storage',
    typeof node.pids_limit === 'number' &&
      node.pids_limit > 0 &&
      node.pids_limit <= 512 &&
      typeof node.mem_limit === 'string' &&
      /^(?:[1-4]g|[1-9]\d{1,3}m)$/.test(node.mem_limit) &&
      names(node.tmpfs).some((entry) => entry.startsWith('/tmp:')) &&
      names(node.tmpfs).some((entry) => entry.startsWith('/var/run:')),
    'a read-only root still needs a private /tmp and a writable socket directory, and finite limits',
  );

  say(
    'the node image is pinned to a released version',
    typeof node.image === 'string' && PINNED_IMAGE.test(node.image) && !MOVING_TAG.test(node.image),
    `tailscale.image is ${String(node.image)}; latest, stable and unstable move under an installation`,
  );

  const unbounded = [
    ...unboundedServices(base.services ?? {}),
    ...(boundedLogging(node.logging) ? [] : [SERVICE]),
  ];
  say(
    'the Tailscale stack keeps bounded logs',
    unbounded.length === 0,
    `services without a json-file max-size and max-file: ${unbounded.join(', ')}`,
  );

  const mounts = names(node.volumes);
  say(
    'the node key lives on a named volume and the serve configuration is read only',
    sameNames(mounts, [`${STATE_VOLUME}:${STATE_DIR}`, SERVE_MOUNT]) &&
      environment.TS_STATE_DIR === STATE_DIR &&
      environment.TS_SERVE_CONFIG === SERVE_PATH,
    `the node must keep its state in the ${STATE_VOLUME} volume and mount nothing else`,
  );

  const settings = Object.keys(environment);
  say(
    'the auth key comes from the environment and no other secret is present',
    environment.TS_AUTHKEY === AUTHKEY &&
      settings.every((key) => key.startsWith('TS_')) &&
      Object.values(environment).every((value) => !/tskey-/i.test(String(value))),
    'TS_AUTHKEY must be the deployment variable, never a literal key, and the node gets no other credential',
  );

  say(
    'the node keeps the resolver that finds the web service',
    environment.TS_ACCEPT_DNS === 'false' &&
      record(record(node.depends_on)?.web)?.condition === 'service_healthy' &&
      hasOnly(record(node.depends_on), ['web']),
    'accepting tailnet DNS would replace the resolver the serve target is looked up with',
  );

  say(
    'the serve configuration answers one HTTPS host and proxies only the web client',
    serve.TCP?.['443']?.HTTPS === true &&
      sameNames(Object.keys(serve.TCP ?? {}), ['443']) &&
      Object.values(serve.TCP ?? {}).every((entry) => entry?.TCPForward === undefined) &&
      singleHandler(serve)?.Proxy === WEB_TARGET &&
      sameNames(Object.keys(singleHandler(serve) ?? {}), ['Proxy']),
    `the node must terminate HTTPS on 443 and forward only / to ${WEB_TARGET}`,
  );

  say(
    'Funnel is off, so nothing is published to the public internet',
    Object.values(serve.AllowFunnel ?? {}).every((allowed) => allowed === false) &&
      serve.AllowFunnel?.[CERT_DOMAIN] === false,
    'AllowFunnel must be false for every host; true would put the sign-in page on the internet',
  );

  const kernelNode = kernel.services?.[SERVICE];
  say(
    'the kernel-mode opt-in changes only the documented networking settings',
    hasOnly(kernel, ['services']) &&
      sameNames(Object.keys(kernel.services ?? {}), [SERVICE]) &&
      hasOnly(kernelNode, ['environment', 'devices', 'cap_add']) &&
      sameNames(Object.keys(record(kernelNode?.environment) ?? {}), ['TS_USERSPACE']) &&
      record(kernelNode?.environment)?.TS_USERSPACE === 'false' &&
      sameNames(names(kernelNode?.devices), ['/dev/net/tun:/dev/net/tun']) &&
      sameNames(names(kernelNode?.cap_add), ['NET_ADMIN']) &&
      kernelNode?.privileged === undefined,
    'kernel mode may add the TUN device and NET_ADMIN and nothing else; it may never grant privileged',
  );

  return results;
}

export function loadTailscaleCompose(path: string): TailscaleComposeFile {
  return parse(readFileSync(path, 'utf8')) as TailscaleComposeFile;
}

export function loadServeConfig(path: string): ServeConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as ServeConfig;
}

export const tailscaleComposePaths = () => {
  const deploy = join(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    base: join(deploy, 'docker-compose.yml'),
    override: join(deploy, 'docker-compose.tailscale.yml'),
    kernel: join(deploy, 'docker-compose.tailscale-kernel.yml'),
    serve: join(deploy, 'config', 'tailscale-serve.json'),
  };
};

if (import.meta.main) {
  const paths = tailscaleComposePaths();
  const results = checkTailscaleCompose(
    loadTailscaleCompose(process.argv[2] ?? paths.base),
    loadTailscaleCompose(process.argv[3] ?? paths.override),
    loadTailscaleCompose(process.argv[4] ?? paths.kernel),
    loadServeConfig(process.argv[5] ?? paths.serve),
  );
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`);
    if (!result.ok) process.stdout.write(`     ${result.detail}\n`);
  }
  const failures = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `tailscale-compose:check ${failures ? 'failed' : 'passed'} (${results.length} checks)\n`,
  );
  process.exit(failures ? 1 : 0);
}
