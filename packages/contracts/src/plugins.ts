/**
 * Plugins a person adds with one tap.
 *
 * Each entry is a stdio MCP server Melete knows how to run: the package or
 * image at a pinned version, what it may reach, which of its tools are offered
 * and how far each may act, and the few values a person has to supply, drawn
 * as a small form. Installing one is `POST /plugins/{id}`; the service starts,
 * stops, restarts, updates and checks it from then on. Every tool call still
 * goes through the broker, so a tool that changes something elsewhere asks
 * first.
 */
import { z } from 'zod';
import { effectClass } from './broker.ts';
import { prefixedId } from './common.ts';
import { connectionCheck } from './connections.ts';
import { connectionView } from './entities.ts';
import { MCP_ANY_PUBLIC_SITE, type McpStdioRunner, mcpEgressHost, mcpStdioEnvName } from './mcp.ts';

export type PluginField = {
  /** For `env`, the variable it fills; for `egress`, a label key. */
  name: string;
  label: string;
  help?: string;
  placeholder?: string;
  required: boolean;
  /** `env` values are sealed and given only to the plugin; `egress` values are sites it may reach. */
  target: 'env' | 'egress';
  secret: boolean;
};

export type PluginTool = {
  name: string;
  alias: string;
  label: string;
  effect_class: z.infer<typeof effectClass>;
};

export type PluginEntry = {
  id: string;
  title: string;
  description: string;
  /** Changes with the pinned source; an installed plugin is moved to it when the service starts. */
  version: string;
  launch: {
    runner: McpStdioRunner;
    source: string;
    command?: string;
    args: string[];
    /** Sites it always needs; a person may add more through an `egress` field. */
    egress: string[];
  };
  fields: PluginField[];
  tools: PluginTool[];
};

/** The starter catalog. Versions are pinned; a release moves them. */
export const PLUGIN_CATALOG: readonly PluginEntry[] = [
  {
    id: 'files',
    title: 'Files',
    description:
      'A private folder of its own for notes and drafts, kept between conversations. It has no network.',
    version: '2026.8.31',
    launch: {
      runner: 'npx',
      source: '@modelcontextprotocol/server-filesystem@2026.8.31',
      args: ['/data/home'],
      egress: [],
    },
    fields: [],
    tools: [
      { name: 'list_directory', alias: 'list', label: 'List a folder', effect_class: 'read' },
      { name: 'read_text_file', alias: 'read', label: 'Read a file', effect_class: 'read' },
      { name: 'search_files', alias: 'search', label: 'Find files', effect_class: 'read' },
      { name: 'get_file_info', alias: 'info', label: 'Describe a file', effect_class: 'read' },
      {
        name: 'write_file',
        alias: 'write',
        label: 'Save a file',
        effect_class: 'write_reversible',
      },
      {
        name: 'create_directory',
        alias: 'mkdir',
        label: 'Make a folder',
        effect_class: 'write_reversible',
      },
    ],
  },
  {
    id: 'fetch',
    title: 'Fetch a page',
    description:
      'Reads public web pages over HTTPS and turns them into text. It cannot reach your own network.',
    version: '2026.8.18',
    launch: {
      runner: 'uvx',
      source: 'mcp-server-fetch==2026.8.18',
      args: [],
      egress: [MCP_ANY_PUBLIC_SITE],
    },
    fields: [
      {
        name: 'sites',
        label: 'Only these sites',
        help: 'Leave empty to let it read any public site, or list host names, one per line, to keep it to those.',
        placeholder: 'docs.example.com',
        required: false,
        target: 'egress',
        secret: false,
      },
    ],
    tools: [{ name: 'fetch', alias: 'fetch', label: 'Read a page', effect_class: 'read' }],
  },
  {
    id: 'time',
    title: 'Time and time zones',
    description:
      'Tells the current time anywhere and converts between time zones. It has no network.',
    version: '2026.8.18',
    launch: { runner: 'uvx', source: 'mcp-server-time==2026.8.18', args: [], egress: [] },
    fields: [],
    tools: [
      { name: 'get_current_time', alias: 'now', label: 'Tell the time', effect_class: 'read' },
      { name: 'convert_time', alias: 'convert', label: 'Convert a time', effect_class: 'read' },
    ],
  },
  {
    id: 'github',
    title: 'GitHub',
    description:
      'Searches and reads repositories, issues and pull requests, and opens or changes an issue after you approve it.',
    version: 'v1.12.2',
    launch: {
      runner: 'image',
      source:
        'ghcr.io/github/github-mcp-server:v1.12.2@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6',
      args: ['stdio'],
      egress: ['api.github.com'],
    },
    fields: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub token',
        help: 'A fine-grained personal access token with the repositories and permissions you want it to have.',
        required: true,
        target: 'env',
        secret: true,
      },
    ],
    tools: [
      { name: 'get_me', alias: 'me', label: 'Who you are on GitHub', effect_class: 'read' },
      {
        name: 'search_repositories',
        alias: 'search_repos',
        label: 'Search repositories',
        effect_class: 'read',
      },
      { name: 'get_file_contents', alias: 'read_file', label: 'Read a file', effect_class: 'read' },
      { name: 'list_issues', alias: 'list_issues', label: 'List issues', effect_class: 'read' },
      { name: 'issue_read', alias: 'read_issue', label: 'Read an issue', effect_class: 'read' },
      {
        name: 'list_pull_requests',
        alias: 'list_pulls',
        label: 'List pull requests',
        effect_class: 'read',
      },
      {
        name: 'pull_request_read',
        alias: 'read_pull',
        label: 'Read a pull request',
        effect_class: 'read',
      },
      {
        name: 'issue_write',
        alias: 'write_issue',
        label: 'Open or change an issue',
        effect_class: 'write_external',
      },
    ],
  },
];

export const pluginView = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    version: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        help: z.string().optional(),
        placeholder: z.string().optional(),
        required: z.boolean(),
        /** Sealed on arrival and never shown again. */
        secret: z.boolean(),
        /** One value per line. */
        list: z.boolean(),
      }),
    ),
    tools: z.array(
      z.object({
        label: z.string(),
        effect_class: effectClass,
        /** True when every use waits for the person's approval. */
        asks_first: z.boolean(),
      }),
    ),
    /** The connection already running this plugin in the space asked about, if any. */
    installed: prefixedId('conn').nullable(),
  })
  .meta({ id: 'Plugin' });
export type PluginView = z.infer<typeof pluginView>;
export const pluginListResponse = z.object({ plugins: z.array(pluginView) });

/** One value per field, by field name; a list field takes one entry per line. */
export const installPluginRequest = z
  .object({
    space_id: prefixedId('sp').optional(),
    values: z.record(z.string(), z.string().max(16_384)).default({}),
  })
  .strict();
export type InstallPluginRequest = z.infer<typeof installPluginRequest>;
export const installPluginResponse = z.object({
  connection: connectionView,
  check: connectionCheck.optional(),
});

export function pluginEntry(id: string): PluginEntry | undefined {
  return PLUGIN_CATALOG.find((entry) => entry.id === id);
}

export function describePlugin(entry: PluginEntry, installed: string | null): PluginView {
  return pluginView.parse({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    version: entry.version,
    fields: entry.fields.map((field) => ({
      name: field.name,
      label: field.label,
      ...(field.help ? { help: field.help } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      required: field.required,
      secret: field.secret,
      list: field.target === 'egress',
    })),
    tools: entry.tools.map((tool) => ({
      label: tool.label,
      effect_class: tool.effect_class,
      asks_first: tool.effect_class === 'write_external' || tool.effect_class === 'spend',
    })),
    installed,
  });
}

/**
 * The `mcp_stdio` installation a catalog entry and a person's values make, or
 * the plain sentence that says what is missing.
 */
export function pluginInstallation(
  entry: PluginEntry,
  values: Record<string, string>,
):
  | {
      ok: true;
      config: {
        id: string;
        runner: McpStdioRunner;
        source: string;
        command?: string;
        args: string[];
        egress: string[];
        secret_env: { name: string; value: string }[];
        allowed_scopes: string[];
        audience: 'owner';
        tools: { name: string; alias: string; required_scopes: string[]; effect_class: string }[];
      };
    }
  | { ok: false; error: string } {
  const unknown = Object.keys(values).filter(
    (name) => !entry.fields.some((field) => field.name === name),
  );
  if (unknown.length) return { ok: false, error: `${entry.title} does not take ${unknown[0]}.` };
  const secretEnv: { name: string; value: string }[] = [];
  let egress = [...entry.launch.egress];
  for (const field of entry.fields) {
    const value = values[field.name]?.trim() ? values[field.name] : undefined;
    if (!value) {
      if (field.required) return { ok: false, error: `${field.label} is needed.` };
      continue;
    }
    if (field.target === 'env') {
      if (!mcpStdioEnvName.safeParse(field.name).success) throw new Error('Invalid catalog field');
      secretEnv.push({ name: field.name, value });
      continue;
    }
    // Naming sites narrows a plugin that could otherwise read any public site.
    egress = egress.filter((site) => site !== MCP_ANY_PUBLIC_SITE);
    for (const line of value.split(/[\n,]/).map((item) => item.trim().toLowerCase())) {
      if (!line) continue;
      if (!mcpEgressHost.safeParse(line).success)
        return { ok: false, error: `${field.label}: ${line} is not a host name.` };
      if (!egress.includes(line)) egress.push(line);
    }
  }
  const scope = (alias: string) => `mcp_${entry.id}.${alias}`;
  return {
    ok: true,
    config: {
      id: entry.id,
      runner: entry.launch.runner,
      source: entry.launch.source,
      ...(entry.launch.command ? { command: entry.launch.command } : {}),
      args: entry.launch.args,
      egress,
      secret_env: secretEnv,
      allowed_scopes: entry.tools.map((tool) => scope(tool.alias)),
      audience: 'owner',
      tools: entry.tools.map((tool) => ({
        name: tool.name,
        alias: tool.alias,
        required_scopes: [scope(tool.alias)],
        effect_class: tool.effect_class,
      })),
    },
  };
}
