import { z } from 'zod';
import { effectClass } from './broker.ts';

export const mcpHttpUrl = z.url().refine((value) => {
  // The format check has already refused what is not an address.
  if (!URL.canParse(value)) return true;
  const parsed = new URL(value);
  return (
    ['http:', 'https:'].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.hash
  );
}, 'MCP endpoint must be HTTP(S), without credentials or fragments');

const scope = z.string().min(1).max(160);
/** The operator declares authority; server annotations and tool arguments cannot grant it. */
export const mcpOperatorPolicy = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(40),
    allowed_scopes: z.array(scope).min(1).max(64),
    audience: z.literal('owner'),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
            alias: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .max(80),
            required_scopes: z.array(scope).min(1).max(32),
            effect_class: effectClass.default('write_external'),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const field of ['name', 'alias'] as const) {
      if (new Set(config.tools.map((tool) => tool[field])).size !== config.tools.length)
        ctx.addIssue({ code: 'custom', message: `MCP tool ${field} must be unique` });
    }
    for (const tool of config.tools) {
      if (!tool.required_scopes.every((item) => config.allowed_scopes.includes(item)))
        ctx.addIssue({ code: 'custom', message: 'MCP tool scopes exceed operator allowed_scopes' });
    }
  });

/** An HTTP MCP server the owner operates. */
export const mcpConnectionConfig = mcpOperatorPolicy.safeExtend({ url: mcpHttpUrl });

/**
 * How a stdio MCP server is started: an npm package run by `npx`, a PyPI
 * package run by `uvx`, or a container image. Nothing here can name a URL, a
 * git remote or a local path, so the only place code comes from is the
 * registry the runner already trusts, and no value can be read as a flag.
 */
export const MCP_STDIO_RUNNERS = ['npx', 'uvx', 'image'] as const;
export const mcpStdioRunner = z.enum(MCP_STDIO_RUNNERS);
export type McpStdioRunner = z.infer<typeof mcpStdioRunner>;

/** `name`, `@scope/name`, either with `@version`; a bare `user/repo` would be read as a git remote. */
const npmPackage = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9._~^<>=*+-]+)?$/);
const pythonVersion = '(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+';
/** `name`, optional `[extras]`, then `@version` or comparison clauses. */
const pythonPackage = z
  .string()
  .max(214)
  .regex(
    new RegExp(
      String.raw`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:@[A-Za-z0-9.*+!_-]+|${pythonVersion}(?:,${pythonVersion})*)?$`,
    ),
  );
/**
 * An image pins its content by digest: `ghcr.io/org/server:1.0@sha256:…`, or a
 * Docker Hub name such as `node:22@sha256:…`. A tag alone can be moved to other
 * content after the owner chose it.
 */
const IMAGE_REFERENCE =
  /^(?:(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

const imageReference = z
  .string()
  .max(512)
  .regex(IMAGE_REFERENCE)
  // The engine pulls from the host's network, so a registry that points back at the
  // host would have it knock on the host's own ports or its cloud metadata service.
  .refine((value) => !registryPointsAtHost(imageRegistry(value)));

/**
 * Whether the engine may pull this image reference: pinned by digest, from any
 * registry, public or private, except one that points back at the host. The
 * service also resolves the registry's name before a pull (`imagePullAllowed`).
 */
export function mayPullImage(reference: string): boolean {
  return imageReference.safeParse(reference).success;
}

/**
 * The registry an image reference pulls from, with its port. As for the engine,
 * the first part names a registry only when it has a dot or a port, or is
 * `localhost`; otherwise the image is on Docker Hub (`alpine`, `org/image`).
 */
export function imageRegistry(reference: string): string {
  const slash = reference.indexOf('/');
  const first = slash < 0 ? '' : reference.slice(0, slash);
  return /[.:[]/.test(first) || first === 'localhost' ? first : 'docker.io';
}

/** The host part of a registry, without its port or IPv6 brackets. */
export function registryHost(registry: string): string {
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(registry);
  return bracketed ? (bracketed[1] ?? '') : registry.replace(/:\d+$/, '');
}

/** The engine's own API ports, refused on any host. */
const DOCKER_API_PORTS = new Set([2375, 2376]);
/** Names that reach the host itself, its Docker gateway or a cloud metadata service. */
const HOST_NAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'host.docker.internal',
  'gateway.docker.internal',
]);

/**
 * Whether a registry points back at the host: the host itself (loopback,
 * `0.0.0.0`, Docker's host aliases), a link-local or cloud metadata address,
 * the engine's API ports on any host, or a wildcard-DNS name
 * (`127.0.0.1.nip.io`, `169-254-169-254.sslip.io`) that spells one of those
 * addresses. Any other registry, public or private, may be pulled from.
 */
export function registryPointsAtHost(registry: string): boolean {
  const port = /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(registry)?.[1];
  if (port !== undefined) {
    const number = Number(port);
    if (DOCKER_API_PORTS.has(number) || number < 1 || number > 65535) return true;
  }
  return hostPointsAtHost(registryHost(registry).toLowerCase());
}

/** Whether a host name or address literal points back at the host (see `registryPointsAtHost`). */
export function hostPointsAtHost(host: string): boolean {
  if (!host) return true;
  if (host.includes(':')) return addressPointsAtHost(host);
  if (HOST_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.docker.internal'))
    return true;
  const labels = host.split('.');
  const last = labels.at(-1) ?? '';
  // A name's last label is never all digits or hex, so this is an address. Only the
  // plain dotted form is taken, since resolvers read the short and hex forms differently.
  if (/^\d+$/.test(last)) return !IPV4.test(host) || addressPointsAtHost(host);
  if (/^0x/.test(last)) return true;
  return embeddedAddresses(labels).some(addressPointsAtHost);
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** The addresses a wildcard-DNS name can spell: `1.2.3.4.x`, `a-1-2-3-4.x`, `7f000001.x`, `--1.x`. */
function embeddedAddresses(labels: string[]): string[] {
  const found: string[] = [];
  const quads = (parts: string[]) => {
    for (let index = 0; index + 4 <= parts.length; index++) {
      const window = parts.slice(index, index + 4);
      if (window.every((part) => /^\d{1,3}$/.test(part))) found.push(window.join('.'));
    }
  };
  quads(labels);
  for (const label of labels) {
    const parts = label.split('-');
    quads(parts);
    for (const part of parts)
      if (/^[0-9a-f]{8}$/.test(part))
        found.push([0, 2, 4, 6].map((at) => Number.parseInt(part.slice(at, at + 2), 16)).join('.'));
    // IPv6 is spelled with dashes for colons: `--1`, `fe80--1`, `app-fe80--1`.
    if (label.includes('--')) {
      const starts = [0, ...[...label.matchAll(/-/g)].map((match) => (match.index ?? 0) + 1)];
      for (const start of starts) {
        const candidate = label.slice(start).replaceAll('-', ':');
        if (parseIpv6(candidate)) found.push(candidate);
      }
    }
  }
  return found.filter((address) => IPV4.test(address) || parseIpv6(address));
}

/**
 * Whether an address is the host itself or reaches a cloud metadata service:
 * loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0/8`, `::`), link-local
 * (`169.254.0.0/16`, `fe80::/10`) or a metadata address. Private ranges such as
 * `10.0.0.0/8` are allowed. Text that is not an address counts as the host.
 */
export function addressPointsAtHost(address: string): boolean {
  const plain = address
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (IPV4.test(plain)) {
    const [a, b, c, d] = plain.split('.').map(Number);
    return (
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 100 && b === 100 && c === 100 && d === 200)
    );
  }
  const words = parseIpv6(plain);
  if (!words) return true;
  const [first = 0, second = 0, , , , sixth = 0, high = 0, low = 0] = words;
  const zero = (from: number, to: number) => words.slice(from, to).every((word) => word === 0);
  const embedded = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  if (zero(0, 5)) {
    if (zero(5, 7)) return low <= 1; // `::` and `::1`
    if (sixth === 0 || sixth === 0xffff) return addressPointsAtHost(embedded); // IPv4-compatible or mapped
  }
  // NAT64 carries an IPv4 address in its last 32 bits.
  if (first === 0x64 && second === 0xff9b && zero(2, 6)) return addressPointsAtHost(embedded);
  if ((first & 0xffc0) === 0xfe80) return true;
  // The IPv6 address of the AWS metadata service, fd00:ec2::254.
  return first === 0xfd00 && second === 0xec2 && zero(2, 7) && low === 0x254;
}

/** The eight 16-bit words of an IPv6 address, or null. */
function parseIpv6(text: string): number[] | null {
  let body = text;
  const tail: number[] = [];
  const dotted = /^(.*:)([^:]*\.[^:]*)$/.exec(body);
  if (dotted) {
    const v4 = dotted[2] ?? '';
    if (!IPV4.test(v4)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    body = dotted[1] ?? '';
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const split = (part = '') => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const back = split(halves[1]);
  if (![...head, ...back].every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  const known = head.length + back.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const gap = new Array<string>(8 - known).fill('0');
  return [...head, ...gap, ...back].map((part) => Number.parseInt(part, 16)).concat(tail);
}
/** A destination the server may open: a DNS name with at least one dot, and an optional port. */
export const mcpEgressHost = z
  .string()
  .max(260)
  .regex(
    /^(?=.{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/,
  )
  .refine((value) => {
    const [host = '', port = '443'] = value.split(':');
    // A name's last label is never all digits, so an address literal is not a name.
    return /[a-z]/.test(host.split('.').at(-1) ?? '') && Number(port) >= 1 && Number(port) <= 65535;
  }, 'A destination is a host name with an optional port');
/** An egress entry that opens any public HTTPS site; private and loopback addresses stay closed. */
export const MCP_ANY_PUBLIC_SITE = '*';
/** Names the launcher sets itself; a secret cannot replace them. */
export const MCP_STDIO_RESERVED_ENV = [
  'HOME',
  'PATH',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_UPDATE_NOTIFIER',
  'UV_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_PYTHON_INSTALL_DIR',
] as const;
export const mcpStdioEnvName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine(
    (name) => !(MCP_STDIO_RESERVED_ENV as readonly string[]).includes(name),
    'This variable is set by the launcher',
  );

const launchShape = {
  runner: mcpStdioRunner,
  /** The npm package for `npx`, the PyPI package for `uvx`, or the image for `image`. */
  source: z.string().min(1).max(512),
  /** The program to run: a package's binary, or the image's entry command. Left out, the runner's own default. */
  command: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
    .optional(),
  args: z.array(z.string().max(4096)).max(64).default([]),
  /**
   * HTTPS destinations the running server may reach. Empty means none at all;
   * `*` means any public HTTPS site.
   */
  egress: z
    .array(z.union([z.literal(MCP_ANY_PUBLIC_SITE), mcpEgressHost]))
    .max(16)
    .default([]),
};

function checkLaunch(
  launch: { runner: McpStdioRunner; source: string; egress: string[] },
  ctx: z.RefinementCtx,
) {
  const valid =
    launch.runner === 'image'
      ? imageReference.safeParse(launch.source).success
      : launch.runner === 'npx'
        ? npmPackage.safeParse(launch.source).success
        : pythonPackage.safeParse(launch.source).success;
  if (!valid)
    ctx.addIssue({
      code: 'custom',
      path: ['source'],
      message:
        launch.runner === 'image'
          ? 'An image names its digest, such as ghcr.io/example/server:1.0@sha256:…, on a registry other than this host'
          : 'A package is a registry name with an optional version, never a URL or a path',
    });
  if (new Set(launch.egress).size !== launch.egress.length)
    ctx.addIssue({ code: 'custom', path: ['egress'], message: 'Each destination appears once' });
}

/** What a connection row keeps: the launch, and the names of its sealed variables only. */
export const mcpStdioLaunch = z
  .object({
    ...launchShape,
    secret_env_names: z.array(mcpStdioEnvName).max(32).default([]),
  })
  .strict()
  .superRefine((launch, ctx) => {
    checkLaunch(launch, ctx);
    if (new Set(launch.secret_env_names).size !== launch.secret_env_names.length)
      ctx.addIssue({ code: 'custom', message: 'Each variable is named once' });
  });
export type McpStdioLaunch = z.infer<typeof mcpStdioLaunch>;

/**
 * A stdio MCP server the owner installs. Each value in `secret_env` is sealed
 * on arrival and handed only to that server's own container.
 */
export const mcpStdioConnectionConfig = mcpOperatorPolicy
  .safeExtend({
    ...launchShape,
    secret_env: z
      .array(z.object({ name: mcpStdioEnvName, value: z.string().min(1).max(16_384) }).strict())
      .max(32)
      .default([]),
  })
  .superRefine((config, ctx) => {
    checkLaunch(config, ctx);
    if (new Set(config.secret_env.map((entry) => entry.name)).size !== config.secret_env.length)
      ctx.addIssue({
        code: 'custom',
        path: ['secret_env'],
        message: 'Each variable is named once',
      });
  });
export type McpStdioConnectionConfig = z.infer<typeof mcpStdioConnectionConfig>;
