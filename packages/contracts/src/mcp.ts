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
const toolAlias = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(80);

/**
 * What a server may add to its space's ledger, declared by whoever installs it.
 * `feed` is the alias of the tool that lists tracked items, and it must be one
 * of the installation's `read` tools; `actions` are the aliases an item may
 * offer as a next step. A server cannot widen either: an item naming any other
 * tool is admitted without that action, and a server with no declaration adds
 * nothing to the ledger, whatever its tools return.
 */
export const mcpLedgerDeclaration = z
  .object({
    feed: toolAlias,
    actions: z.array(toolAlias).max(16).default([]),
  })
  .strict();
export type McpLedgerDeclaration = z.infer<typeof mcpLedgerDeclaration>;

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
    ledger: mcpLedgerDeclaration.optional(),
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
    if (config.ledger) {
      const effectOf = new Map(config.tools.map((tool) => [tool.alias, tool.effect_class]));
      if (effectOf.get(config.ledger.feed) !== 'read')
        ctx.addIssue({
          code: 'custom',
          path: ['ledger', 'feed'],
          message: 'The ledger feed must name one of the installed read tools',
        });
      for (const action of config.ledger.actions) {
        if (!effectOf.has(action) || action === config.ledger.feed)
          ctx.addIssue({
            code: 'custom',
            path: ['ledger', 'actions'],
            message: 'Each ledger action must name another installed tool',
          });
      }
      if (new Set(config.ledger.actions).size !== config.ledger.actions.length)
        ctx.addIssue({
          code: 'custom',
          path: ['ledger', 'actions'],
          message: 'Each ledger action is named once',
        });
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
 * An image names its registry and pins its content: `ghcr.io/org/server:1.0@sha256:…`.
 * A tag alone can be moved to other content after the owner chose it.
 */
const imageReference = z
  .string()
  .max(512)
  .regex(
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/,
  )
  // The engine pulls from the host's network, so a registry named by address, or as the
  // host itself, would have it knock on the host's own or private ports.
  .refine((value) => registryIsNamed(value.slice(0, value.indexOf('/'))));

/** A registry host that is a DNS name, not an address and not the host itself. */
function registryIsNamed(registry: string): boolean {
  const host = registry.replace(/:\d+$/, '');
  const last = host.split('.').at(-1) ?? '';
  return /[a-z]/.test(last) && host !== 'localhost' && !host.endsWith('.localhost');
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
          ? 'An image names its registry and digest, such as ghcr.io/example/server:1.0@sha256:…'
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
