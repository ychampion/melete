import { createHash } from 'node:crypto';
import type {
  CapabilityClaims,
  ConnectionHealth,
  JsonObject,
  Skill,
  ToolSpec,
} from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { MAX_TOOL_SCHEMA_BYTES, toolSchemaFits } from '../connectors/schema-budget.ts';
import { type Connector, connectorAllowsAudience } from '../connectors/types.ts';
import { BrokerFault } from './errors.ts';
import { appendEvent, checkAttempt, type LockedJob, lockJob, type Query } from './records.ts';

export type CatalogSource = 'connector' | 'capability' | 'skill' | 'mcp';

/** Supplied by trusted service code or operator configuration, never by a tool result. */
export type CatalogMetadata = {
  source?: CatalogSource;
  examples?: Record<string, readonly string[]>;
  core?: readonly string[];
  audience?: 'owner';
};

export type CatalogEntry = {
  name: string;
  description: string;
  schema_fingerprint: string;
  examples: string[];
  effect_class: ToolSpec['effect_class'];
  required_scopes: string[];
  source: CatalogSource;
  health: ConnectionHealth;
  connection_id: string | null;
};

export type CatalogItem = { entry: CatalogEntry; tool: ToolSpec; core: boolean; uses: number };
type ScopedCatalogItem = CatalogItem & { original: string };
export type CatalogContext = { core: ToolSpec[]; loaded: ToolSpec[] };

// Reserve the rest of the 4,000-token tripwire for the pinned engine's scaffolding.
export const CORE_CATALOG_TOKENS = 750;
export const SEARCH_RESULT_TOKENS = 1_000;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const schemaFingerprint = (schema: ToolSpec['input_schema']): string =>
  createHash('sha256').update(stable(schema)).digest('hex');

/** A stable function name for two granted accounts offering the same verb. */
export const accountToolName = (name: string, connectionId: string): string =>
  `${name}__${createHash('sha256').update(connectionId).digest('hex').slice(0, 12)}`;

export function resolveToolAlias(connector: Connector, connectionId: string, name: string) {
  return (
    connector.manifest.tools.find((tool) => tool.name === name) ??
    connector.manifest.tools.find((tool) => accountToolName(tool.name, connectionId) === name)
  );
}

export const META_TOOLS: ToolSpec[] = [
  {
    name: 'search_tools',
    description:
      'Find available tools by keywords. Results contain names; use load_tool for schemas.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['query'],
      additionalProperties: false,
    },
    effect_class: 'read',
    connection_id: null,
  },
  {
    name: 'load_tool',
    description: 'Load an available tool by its exact search result name for this attempt.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['name'],
      additionalProperties: false,
    },
    effect_class: 'read',
    connection_id: null,
  },
];

export const toolTokens = (tools: readonly ToolSpec[]): number =>
  estimateTokens(
    JSON.stringify(
      tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
    ),
  );

/** Budget the serialized provider schemas, including the two always-on meta-tools. */
export function selectCore(
  items: readonly CatalogItem[],
  budget = CORE_CATALOG_TOKENS,
): ToolSpec[] {
  if (!Number.isSafeInteger(budget) || budget < toolTokens(META_TOOLS))
    throw new Error('Core catalog budget cannot hold discovery tools');
  const tools = structuredClone(META_TOOLS);
  const ranked = [...items].sort(
    (a, b) =>
      Number(b.core) - Number(a.core) || b.uses - a.uses || compare(a.entry.name, b.entry.name),
  );
  for (const item of ranked) {
    if (item.entry.health === 'failing' || (!item.core && item.entry.source !== 'connector'))
      continue;
    if (toolTokens([...tools, item.tool]) <= budget) tools.push(item.tool);
  }
  return tools;
}

export function manifestEntry(
  tool: ToolSpec,
  scopes: readonly string[],
  source: CatalogSource = 'connector',
  health: ConnectionHealth = 'unknown',
  examples: readonly string[] = [],
): CatalogEntry {
  return {
    name: tool.name,
    description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 400),
    schema_fingerprint: schemaFingerprint(tool.input_schema),
    examples: examples.slice(0, 2).map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 200)),
    effect_class: tool.effect_class,
    required_scopes: [...new Set(scopes)].sort(compare),
    source,
    health,
    connection_id: tool.connection_id,
  };
}

type ConnectorResolver = { get(connectionId: string): Connector | undefined };
export type CatalogOptions = {
  sql: Sql;
  connectors: ConnectorResolver;
  coreTokenBudget?: number;
  /** This loader is service-owned and already selects the job's space. */
  skills?: (spaceId: string) => Promise<readonly Skill[]>;
  nativeTools?: readonly ToolSpec[];
};

/** The context is durable, but possession of a schema never becomes authority. */
export class ToolCatalog {
  constructor(private readonly options: CatalogOptions) {}

  private async skills(job: LockedJob, claims: CapabilityClaims): Promise<readonly Skill[]> {
    if (job.constraints.public_compartment) return [];
    const skills = (await this.options.skills?.(job.space_id)) ?? [];
    return skills.filter((skill) =>
      skill.frontmatter.tools.every((scope) => claims.scopes.includes(scope)),
    );
  }

  private async scoped(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
  ): Promise<ScopedCatalogItem[]> {
    const connections = await tx`select c.id, c.provider, c.scopes, c.health, s.audience
      from connection c join space s on s.id = c.space_id
      where c.space_id = ${job.space_id} and c.status = 'active' order by c.id`;
    const usage = await tx`select a.connection_id, a.kind, count(*)::int as uses from action a
      join job j on j.id = a.job_id where j.space_id = ${job.space_id} and a.status = 'succeeded'
      group by a.connection_id, a.kind`;
    const items: ScopedCatalogItem[] = [];
    const skills = await this.skills(job, claims);
    const nativeNames = new Set(
      [...META_TOOLS, ...(this.options.nativeTools ?? [])].map((tool) => tool.name),
    );
    const reserved = new Set([
      ...nativeNames,
      ...skills.map((skill) => `skills.${skill.frontmatter.name.replaceAll('-', '_')}`),
    ]);
    const accept = async (name: string, connectionId: string | null, validate: () => void) => {
      try {
        validate();
        return true;
      } catch (error) {
        if (!(error instanceof BrokerFault)) throw error;
        // Isolate configuration faults to their entry; retain a durable diagnostic.
        await appendEvent(
          tx,
          claims.job_id,
          claims.attempt_id,
          'notice',
          {
            phase: 'catalog_rejected',
            name,
            connection_id: connectionId,
            code: error.code,
            message: error.message,
          },
          `catalog:reject:${claims.attempt_id}:${connectionId ?? 'native'}:${name}`,
        );
        return false;
      }
    };
    for (const row of connections) {
      const connector = this.options.connectors.get(row.id);
      if (!connector || connector.manifest.provider !== row.provider) continue;
      // A capability whose provider is not configured has nothing to offer yet.
      if (connector.capability?.available === false) continue;
      if (!connectorAllowsAudience(connector, job.constraints, row.audience)) continue;
      for (const declared of connector.manifest.tools) {
        const scopes = [declared.name, ...declared.required_scopes];
        if (!scopes.every((scope) => claims.scopes.includes(scope) && row.scopes.includes(scope)))
          continue;
        if (
          !(await accept(declared.name, row.id, () => {
            if (reserved.has(declared.name))
              throw new BrokerFault(
                'unknown_tool',
                'Connector name is reserved by a broker tool or skill',
              );
          }))
        )
          continue;
        const source = connector.catalog?.source ?? 'connector';
        const tool: ToolSpec = {
          name: declared.name,
          description: declared.description,
          input_schema: declared.input_schema,
          effect_class: declared.effect_class,
          connection_id: row.id,
          // The cell needs to know which tools it carries out itself, and
          // the shape of the record it owes the ledger afterwards.
          execution: declared.execution,
          record_schema: declared.record_schema,
        };
        items.push({
          original: tool.name,
          tool,
          entry: manifestEntry(
            tool,
            scopes,
            source,
            row.health,
            connector.catalog?.examples?.[tool.name],
          ),
          core:
            /^(files\.|knowledge\.|react(?:\.|$))/.test(tool.name) ||
            Boolean(connector.catalog?.core?.includes(tool.name)),
          uses: Number(
            usage.find((item) => item.connection_id === row.id && item.kind === tool.name)?.uses ??
              0,
          ),
        });
      }
    }
    for (const skill of skills) {
      const tool: ToolSpec = {
        name: `skills.${skill.frontmatter.name.replaceAll('-', '_')}`,
        description: skill.frontmatter.description,
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        effect_class: 'read',
        connection_id: null,
      };
      if (
        !(await accept(tool.name, null, () => {
          if (
            nativeNames.has(tool.name) ||
            items.some((item) => item.original === tool.name && item.tool.connection_id === null)
          )
            throw new BrokerFault('unknown_tool', 'Duplicate scoped skill or reserved native name');
        }))
      )
        continue;
      items.push({
        original: tool.name,
        tool,
        entry: manifestEntry(
          tool,
          skill.frontmatter.tools,
          'skill',
          'ok',
          skill.frontmatter.triggers,
        ),
        core: false,
        uses: 0,
      });
    }
    for (const tool of this.options.nativeTools ?? []) {
      if (
        !(await accept(tool.name, tool.connection_id, () => {
          if (tool.connection_id !== null || tool.effect_class !== 'read')
            throw new BrokerFault(
              'unknown_tool',
              'Native catalog tools must be broker-owned reads',
            );
          if (
            META_TOOLS.some((meta) => meta.name === tool.name) ||
            items.some((item) => item.original === tool.name && item.tool.connection_id === null)
          )
            throw new BrokerFault('unknown_tool', 'Duplicate native tool name');
        }))
      )
        continue;
      items.push({
        original: tool.name,
        tool,
        entry: manifestEntry(tool, [], 'capability', 'ok'),
        core: true,
        uses: 0,
      });
    }
    const counts = new Map(META_TOOLS.map((tool) => [tool.name, 1]));
    for (const item of items) counts.set(item.original, (counts.get(item.original) ?? 0) + 1);
    for (const item of items) {
      if ((counts.get(item.original) ?? 0) > 1 && item.tool.connection_id) {
        item.tool.name = accountToolName(item.original, item.tool.connection_id);
        item.entry.name = item.tool.name;
      }
    }
    return items.sort((a, b) => compare(a.entry.name, b.entry.name));
  }

  private async context(
    tx: Query,
    claims: CapabilityClaims,
    items: CatalogItem[],
  ): Promise<CatalogContext> {
    const [row] =
      await tx`select core, loaded from attempt_tool_context where attempt_id = ${claims.attempt_id}`;
    if (row) return { core: row.core, loaded: row.loaded };
    const core = selectCore(items, this.options.coreTokenBudget);
    await tx`insert into attempt_tool_context (attempt_id, job_id, core, loaded)
      values (${claims.attempt_id}, ${claims.job_id}, ${JSON.stringify(core)}::jsonb, '[]'::jsonb)`;
    await appendEvent(tx, claims.job_id, claims.attempt_id, 'notice', {
      phase: 'catalog_context',
      core: core.map((tool) => ({
        name: tool.name,
        schema_fingerprint: schemaFingerprint(tool.input_schema),
      })),
      estimated_tokens: toolTokens(core),
    });
    return { core, loaded: [] };
  }

  private current(context: CatalogContext, items: CatalogItem[]): ToolSpec[] {
    return [...context.core, ...context.loaded].filter(
      (tool) =>
        META_TOOLS.some((meta) => meta.name === tool.name && tool.connection_id === null) ||
        items.some(
          (item) =>
            item.entry.name === tool.name &&
            item.tool.connection_id === tool.connection_id &&
            item.entry.schema_fingerprint === schemaFingerprint(tool.input_schema) &&
            item.entry.effect_class === tool.effect_class &&
            item.entry.health !== 'failing',
        ),
    );
  }

  /** Names already shown in this attempt remain bound even after an account is revoked. */
  private bindNames(items: ScopedCatalogItem[], context: CatalogContext): CatalogItem[] {
    const saved = [...context.core, ...context.loaded];
    const reserved = new Set(saved.map((tool) => tool.name));
    const claimed = new Set<string>();
    for (const item of items) {
      const connectionId = item.tool.connection_id;
      const prior = saved.find(
        (tool) =>
          tool.connection_id === connectionId &&
          (tool.name === item.original ||
            (connectionId !== null && tool.name === accountToolName(item.original, connectionId))),
      );
      if (prior) item.tool.name = prior.name;
      else if (reserved.has(item.tool.name)) {
        if (!connectionId) throw new BrokerFault('unknown_tool', 'Duplicate native tool name');
        item.tool.name = accountToolName(item.original, connectionId);
      }
      if ((!prior && reserved.has(item.tool.name)) || claimed.has(item.tool.name))
        throw new BrokerFault('unknown_tool', 'Ambiguous tool name');
      claimed.add(item.tool.name);
      item.entry.name = item.tool.name;
    }
    return items.sort((a, b) => compare(a.entry.name, b.entry.name));
  }

  private async within<T>(
    claims: CapabilityClaims,
    use: (tx: Query, job: LockedJob, items: CatalogItem[], context: CatalogContext) => Promise<T>,
  ): Promise<T> {
    return this.options.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const items = await this.scoped(tx, job, claims);
      const context = await this.context(tx, claims, items);
      return use(tx, job, this.bindNames(items, context), context);
    }) as Promise<T>;
  }

  catalog(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.within(claims, async (_tx, _job, items, context) => this.current(context, items));
  }

  /** Used by trusted broker composition; does not load schemas or create a grant. */
  available(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.within(claims, async (_tx, _job, items) =>
      items.filter((item) => item.entry.health !== 'failing').map((item) => item.tool),
    );
  }

  search(claims: CapabilityClaims, query: string): Promise<CatalogEntry[]> {
    const parsed = z.string().trim().min(1).max(500).parse(query);
    return this.within(claims, async (tx, _job, items, context) => {
      const loaded = new Set(this.current(context, items).map((tool) => tool.name));
      const rest = items.filter((item) => !loaded.has(item.entry.name)).map((item) => item.entry);
      // The input contains only already-authorized entries. Even the ranking engine
      // cannot reveal another space's names, schemas, examples or result counts.
      const ranked = await tx`with entries as (
        select value as entry, setweight(to_tsvector('simple', regexp_replace(value->>'name', '[._-]', ' ', 'g')), 'A') ||
          setweight(to_tsvector('simple', value->>'description'), 'B') ||
          setweight(to_tsvector('simple', (value->'examples')::text), 'C') as document
        from jsonb_array_elements(${JSON.stringify(rest)}::jsonb)
      ), query as (select plainto_tsquery('simple', ${parsed}) as terms)
      select entry from entries, query where document @@ terms
      order by ts_rank(document, terms) desc, entry->>'name' collate "C"`;
      const result: CatalogEntry[] = [];
      for (const row of ranked) {
        // A long, valid scope list must not make the best match undiscoverable.
        if (
          result.length === 0 ||
          estimateTokens(JSON.stringify([...result, row.entry])) <= SEARCH_RESULT_TOKENS
        )
          result.push(row.entry);
      }
      await appendEvent(tx, claims.job_id, claims.attempt_id, 'notice', {
        phase: 'search_tools',
        query: parsed,
        names: result.map((item) => item.name),
        effect_class: 'read',
      });
      return result;
    });
  }

  load(
    claims: CapabilityClaims,
    name: string,
  ): Promise<{ tool: ToolSpec; schema_fingerprint: string }> {
    z.string().min(1).max(300).parse(name);
    return this.within(claims, async (tx, _job, items, context) => {
      const item = items.find((entry) => entry.entry.name === name);
      if (!item) throw new BrokerFault('unknown_tool');
      if (item.entry.health === 'failing') throw new BrokerFault('connector_unavailable');
      if (!toolSchemaFits(item.tool.input_schema))
        throw new BrokerFault(
          'connector_unavailable',
          `Tool schema exceeds ${MAX_TOOL_SCHEMA_BYTES} UTF-8 bytes`,
        );
      const prior = [...context.core, ...context.loaded].find((tool) => tool.name === name);
      if (
        prior &&
        (prior.connection_id !== item.tool.connection_id ||
          schemaFingerprint(prior.input_schema) !== item.entry.schema_fingerprint ||
          prior.effect_class !== item.entry.effect_class)
      )
        throw new BrokerFault('unknown_tool', 'The tool changed during this attempt');
      if (!prior) {
        await tx`update attempt_tool_context set loaded = loaded || ${JSON.stringify([item.tool])}::jsonb, updated_at = now()
          where attempt_id = ${claims.attempt_id}`;
        await appendEvent(
          tx,
          claims.job_id,
          claims.attempt_id,
          'notice',
          { phase: 'load_tool', ...item.entry },
          `catalog:load:${claims.attempt_id}:${name}`,
        );
      }
      return { tool: item.tool, schema_fingerprint: item.entry.schema_fingerprint };
    });
  }

  callSkill(claims: CapabilityClaims, name: string, args: JsonObject): Promise<JsonObject> {
    z.object({}).strict().parse(args);
    return this.within(claims, async (tx, job, items, context) => {
      if (
        !this.current(context, items).some(
          (tool) => tool.name === name && tool.connection_id === null,
        )
      )
        throw new BrokerFault('unknown_tool');
      const skill = (await this.skills(job, claims)).find(
        (item) => `skills.${item.frontmatter.name.replaceAll('-', '_')}` === name,
      );
      if (!skill) throw new BrokerFault('unknown_tool');
      await appendEvent(tx, job.id, claims.attempt_id, 'notice', {
        phase: 'skill_read',
        name,
        effect_class: 'read',
      });
      return { name: skill.frontmatter.name, body: skill.body };
    });
  }
}
