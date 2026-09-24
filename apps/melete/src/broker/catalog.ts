import { createHash } from 'node:crypto';
import {
  type CapabilityClaims,
  CONTEXT_LIMITS,
  type ConnectionHealth,
  type JsonObject,
  REACT_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  type Skill,
  type ToolSpec,
} from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { MAX_TOOL_SCHEMA_BYTES, toolSchemaFits } from '../connectors/schema-budget.ts';
import { type Connector, connectorAllowsAudience } from '../connectors/types.ts';
import { type AgentAccess, agentAccess, directSend } from '../experience/access.ts';
import { appendToolTrace } from '../experience/tools.ts';
import { plainSkillTitle } from '../jobs/skill-trace.ts';
import { spaceRole } from '../principals/authority.ts';
import { audienceVisible } from '../principals/context.ts';
import { grantsConnectionScopes } from './connection-scopes.ts';
import { BrokerFault } from './errors.ts';
import { gist, relevance, terms, words } from './lexical.ts';
import { appendEvent, checkAttempt, type LockedJob, lockJob, type Query } from './records.ts';
import { hasResumableAction, RESUME_ACTION_TOOL } from './resume.ts';
import { RUNTIME_WAIT_TOOL } from './runtime-wait.ts';

export type CatalogSource = 'connector' | 'capability' | 'skill' | 'mcp';
/** A skill with where it came from: a built-in is readable by anyone the space admits. */
export type SourcedSkill = Skill & { source?: 'builtin' | 'space' };

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
export type CatalogSearch = {
  tools: CatalogEntry[];
  /** Present only when nothing matched: what `load_tool` can still fetch, by name. */
  index?: { name: string; gist: string }[];
  hint?: string;
};

// Reserve the rest of the 4,000-token tripwire for the pinned engine's scaffolding.
export const CORE_CATALOG_TOKENS: number = CONTEXT_LIMITS.core_catalog_tokens;
export const SEARCH_RESULT_TOKENS = 1_000;
const SEARCH_TERMS = 24;
/** The names-only index of unloaded tools has its own fixed allowance beside the schemas. */
export const CATALOG_INDEX_TOKENS: number = CONTEXT_LIMITS.catalog_index_tokens;
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

/** A chat's narration tool: what the assistant will do next, in the person's words, at no action cost. */
export const SAY_TOOL: ToolSpec = {
  name: 'say',
  description:
    'Tell the person in one or two first-person sentences what you will do next. Do not include reasoning, internal names, or technical details. This narration has no action cost and needs no approval.',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 600 } },
    required: ['text'],
    additionalProperties: false,
  },
  effect_class: 'read',
  connection_id: null,
};

/**
 * Reads the body of a skill the attempt's index names. One broker-owned tool
 * serves every skill, so reading one needs no schema load and no new run.
 */
export const SKILL_READ_TOOL: ToolSpec = {
  name: SKILL_READ_TOOL_NAME,
  description:
    'Read the full instructions of a skill listed in your skill index, by its exact name. Read one before doing the kind of work it describes.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['name'],
    additionalProperties: false,
  },
  effect_class: 'read',
  connection_id: null,
};

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

/** What the broker knows about the turn before any model has spoken. */
export type CoreSelectionContext = {
  /** The objective and the most recent owner message, as written. */
  text?: string;
  /** The job has an enabled trigger, so the lifecycle wait must be on offer. */
  waitable?: boolean;
  /** The attempt answers a person directly, so a reaction may be the whole reply. */
  conversational?: boolean;
  /** An approved action is waiting to be carried out, so resuming it comes first. */
  resumable?: boolean;
  /** The attempt may read skills it was not given in full, so the reader must be on offer. */
  readable?: boolean;
};

const namespace = (name: string) => (name.includes('.') ? name.slice(0, name.indexOf('.')) : null);
const writesOutside = (item: CatalogItem) =>
  item.entry.effect_class === 'write_external' || item.entry.effect_class === 'spend';
/** Whether the installation vouches for this entry's own words. An MCP server writes its own. */
const granted = (item: CatalogItem) => (item.entry.source === 'mcp' ? 0 : 1);

/**
 * Budget the serialized provider schemas, including the two always-on meta-tools.
 *
 * Order: tools the turn cannot do without, then everything the owner granted
 * ahead of anything a remote server described to us, then lexical relevance to
 * the job's own words, then the local core, then usage, then name. Relevance is
 * read off a tool's own description, and an MCP server writes its own: ranking
 * it against granted verbs would let that server take the first catalog's room
 * by echoing the job. It may have the room nothing granted wanted, and no more.
 * A reversible tool is
 * only offered beside an external-write sibling from the same connection and
 * namespace, because a draft shown alone reads as the only way to act. Whatever
 * stays outside is named in a bounded index on `load_tool`, so the model knows
 * what it can fetch without paying for the schemas.
 */
export function selectCore(
  items: readonly CatalogItem[],
  budget = CORE_CATALOG_TOKENS,
  context: CoreSelectionContext = {},
  indexBudget = CATALOG_INDEX_TOKENS,
): ToolSpec[] {
  if (!Number.isSafeInteger(budget) || budget < toolTokens(META_TOOLS))
    throw new Error('Core catalog budget cannot hold discovery tools');
  const tools = structuredClone(META_TOOLS);
  const query = terms(context.text ?? '');
  const scored = items
    .filter((item) => item.entry.health !== 'failing')
    .map((item) => ({
      item,
      score: relevance(query, item.entry),
      pinned:
        item.tool.connection_id !== null
          ? 0
          : context.resumable === true && item.tool.name === RESUME_ACTION_TOOL.name
            ? 2
            : (context.waitable === true && item.tool.name === RUNTIME_WAIT_TOOL.name) ||
                (context.conversational === true && item.tool.name === REACT_TOOL_NAME) ||
                (context.readable === true && item.tool.name === SKILL_READ_TOOL.name)
              ? 1
              : 0,
    }))
    .sort(
      (a, b) =>
        b.pinned - a.pinned ||
        granted(b.item) - granted(a.item) ||
        b.score - a.score ||
        Number(b.item.core) - Number(a.item.core) ||
        b.item.uses - a.item.uses ||
        compare(a.item.entry.name, b.item.entry.name),
    );
  // A connector verb is always a candidate; an MCP tool only when the job's own
  // words point at it; capabilities and skills stay behind discovery.
  const eligible = scored.filter(
    ({ item, score }) =>
      item.core || item.entry.source === 'connector' || (item.entry.source === 'mcp' && score > 0),
  );
  const chosen = new Set<CatalogItem>();
  const add = (...group: CatalogItem[]) => {
    const fresh = group.filter((item) => !chosen.has(item));
    if (toolTokens([...tools, ...fresh.map((item) => item.tool)]) > budget) return false;
    for (const item of fresh) {
      chosen.add(item);
      tools.push(item.tool);
    }
    return true;
  };
  for (const { item } of eligible) {
    if (chosen.has(item)) continue;
    const siblings =
      item.entry.effect_class === 'write_reversible' && item.tool.connection_id !== null
        ? eligible
            .map((entry) => entry.item)
            .filter(
              (other) =>
                writesOutside(other) &&
                other.tool.connection_id === item.tool.connection_id &&
                namespace(other.entry.name) !== null &&
                namespace(other.entry.name) === namespace(item.entry.name),
            )
        : [];
    if (siblings.length === 0 || siblings.some((other) => chosen.has(other))) add(item);
    else siblings.some((other) => add(item, other));
  }
  const loader = tools.find((tool) => tool.name === 'load_tool');
  const rest = scored.map((entry) => entry.item).filter((item) => !chosen.has(item));
  if (loader && rest.length > 0 && indexBudget > 0) {
    const listing = (shown: number) => {
      const named = rest
        .slice(0, shown)
        .map((item) => `${item.entry.name} (${gist(item.entry.description)})`);
      const more = rest.length - shown;
      return ` Not loaded yet: ${named.join('; ')}${
        more > 0 ? `${shown > 0 ? '; ' : ''}+${more} more through search_tools` : ''
      }.`;
    };
    let shown = rest.length;
    while (shown > 0 && estimateTokens(listing(shown)) > indexBudget) shown--;
    if (estimateTokens(listing(shown)) <= indexBudget) loader.description += listing(shown);
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
  skills?: (spaceId: string) => Promise<readonly SourcedSkill[]>;
  nativeTools?: readonly ToolSpec[];
};

/**
 * The skills an attempt may read: every tool one names is within its scopes,
 * and a space skill's audience admits the reader. A built-in is readable by
 * anyone the space admits; a space skill with no audience is its owner's alone.
 */
export function readableSkills(
  skills: readonly SourcedSkill[],
  reader: { spaceId: string; scopes: readonly string[]; owner: boolean },
): SourcedSkill[] {
  return skills.filter(
    (skill) =>
      skill.frontmatter.tools.every((scope) => reader.scopes.includes(scope)) &&
      (skill.source === 'builtin' ||
        audienceVisible(skill.frontmatter.audience, reader.spaceId, reader.owner)),
  );
}

/** The context is durable, but possession of a schema never becomes authority. */
export class ToolCatalog {
  constructor(private readonly options: CatalogOptions) {}

  /**
   * The skills this attempt may read: its granted scopes cover every tool one
   * names, and a space skill's audience admits the attempt's principal. A skill
   * with no audience is private to the space's owner.
   */
  private async skills(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
  ): Promise<readonly SourcedSkill[]> {
    if (job.constraints.public_compartment) return [];
    const skills = (await this.options.skills?.(job.space_id)) ?? [];
    // The rule every other surface uses: a co-owner is an owner, and a space
    // from before principals belongs to the installation's owner. A principal
    // the space does not admit reads nothing.
    const role = await spaceRole(tx, job.space_id, claims.principal_id ?? null);
    if (!role) return [];
    return readableSkills(skills, {
      spaceId: job.space_id,
      scopes: claims.scopes,
      owner: role === 'owner',
    });
  }

  private async scoped(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
    access: AgentAccess,
  ): Promise<ScopedCatalogItem[]> {
    // A job bound to a persona that no longer resolves fails closed: nothing is offered.
    if (access.missingAgent) return [];
    const connections = await tx`select c.id, c.provider, c.scopes, c.health, s.audience
      from connection c join space s on s.id = c.space_id
      where c.space_id = ${job.space_id} and c.status = 'active' order by c.id`;
    const usage = await tx`select a.connection_id, a.kind, count(*)::int as uses from action a
      join job j on j.id = a.job_id where j.space_id = ${job.space_id} and a.status = 'succeeded'
      group by a.connection_id, a.kind`;
    const items: ScopedCatalogItem[] = [];
    const skills = await this.skills(tx, job, claims);
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
      // A conversation's persona bounds which connections and verbs are offered.
      if ((access.chat && !access.agentId) || (access.allowed && !access.allowed.includes(row.id)))
        continue;
      const connector = this.options.connectors.get(row.id);
      if (!connector || connector.manifest.provider !== row.provider) continue;
      // A capability whose provider is not configured has nothing to offer yet.
      if (connector.capability?.available === false) continue;
      if (!connectorAllowsAudience(connector, job.constraints, row.audience)) continue;
      for (const declared of connector.manifest.tools) {
        if (access.chat && directSend(declared.name)) continue;
        const scopes = [declared.name, ...declared.required_scopes];
        if (!grantsConnectionScopes(claims, row.scopes, scopes)) continue;
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
    const resumable = await hasResumableAction(tx, job);
    for (const tool of [...(this.options.nativeTools ?? []), ...(access.chat ? [SAY_TOOL] : [])]) {
      if (tool.name === RUNTIME_WAIT_TOOL.name && !claims.scopes.includes(tool.name)) continue;
      // Offered only while there is a skill this attempt may read.
      if (tool.name === SKILL_READ_TOOL.name && skills.length === 0) continue;
      // Offered only while the owner's approval is waiting to be carried out.
      if (tool.name === RESUME_ACTION_TOOL.name && !resumable) continue;
      if (
        !(await accept(tool.name, tool.connection_id, () => {
          const lifecycle = [RUNTIME_WAIT_TOOL, RESUME_ACTION_TOOL].some(
            (typed) =>
              tool.name === typed.name &&
              schemaFingerprint(tool.input_schema) === schemaFingerprint(typed.input_schema) &&
              tool.effect_class === typed.effect_class,
          );
          if (tool.connection_id !== null || (tool.effect_class !== 'read' && !lifecycle))
            throw new BrokerFault(
              'unknown_tool',
              'Native catalog tools must be broker-owned reads or a typed lifecycle operation',
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

  /**
   * What the turn is about, read from durable rows before any model speaks: the
   * objective, the latest owner message, whether a trigger is registered, and
   * whether this attempt answers a person directly (a chat, a first attempt, or
   * a wake that carries a new owner message).
   */
  private async turn(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
    access: AgentAccess,
  ): Promise<CoreSelectionContext> {
    const [row] = await tx`select
      (select e.payload->>'text' from event e where e.job_id = ${job.id} and e.type = 'notice'
        and e.payload->>'kind' = 'user_message' order by e.seq desc limit 1) as message,
      (select max(e.seq) from event e where e.job_id = ${job.id} and e.type = 'notice'
        and e.payload->>'kind' = 'user_message') as message_seq,
      (select a.input_cursor from attempt a where a.job_id = ${job.id}
        and a.id <> ${claims.attempt_id} order by a.epoch desc limit 1) as prior_cursor,
      exists (select 1 from trigger t where t.job_id = ${job.id} and t.enabled) as waitable`;
    const first = row?.prior_cursor === null || row?.prior_cursor === undefined;
    return {
      text: [job.objective, row?.message].filter(Boolean).join(' '),
      waitable: row?.waitable === true,
      resumable: await hasResumableAction(tx, job),
      readable: (await this.skills(tx, job, claims)).length > 0,
      conversational:
        access.chat || first || Number(row?.message_seq ?? 0) > Number(row?.prior_cursor ?? 0),
    };
  }

  private async context(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
    items: CatalogItem[],
    access: AgentAccess,
  ): Promise<CatalogContext> {
    const [row] =
      await tx`select core, loaded from attempt_tool_context where attempt_id = ${claims.attempt_id}`;
    if (row) return { core: row.core, loaded: row.loaded };
    const core = selectCore(
      items,
      this.options.coreTokenBudget,
      await this.turn(tx, job, claims, access),
    );
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
    use: (
      tx: Query,
      job: LockedJob,
      items: CatalogItem[],
      context: CatalogContext,
      access: AgentAccess,
    ) => Promise<T>,
  ): Promise<T> {
    return this.options.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const access = await agentAccess(tx, job.id);
      const items = await this.scoped(tx, job, claims, access);
      const context = await this.context(tx, job, claims, items, access);
      return use(tx, job, this.bindNames(items, context), context, access);
    }) as Promise<T>;
  }

  catalog(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.within(claims, async (_tx, _job, items, context, access) =>
      access.missingAgent ? [] : this.current(context, items),
    );
  }

  /** Used by trusted broker composition; does not load schemas or create a grant. */
  available(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.within(claims, async (_tx, _job, items) =>
      items.filter((item) => item.entry.health !== 'failing').map((item) => item.tool),
    );
  }

  async search(claims: CapabilityClaims, query: string): Promise<CatalogEntry[]> {
    return (await this.find(claims, query)).tools;
  }

  /**
   * Ranked discovery. Any term may match: the terms are ORed, stemmed with the
   * `english` configuration and also kept whole under `simple`, so an identifier
   * segment such as `restart` in `server.restart` answers "restarting services".
   * A query that matches nothing returns the names of what can be loaded, with
   * one line saying so, because an empty list reads as "no such tool exists".
   */
  find(claims: CapabilityClaims, query: string): Promise<CatalogSearch> {
    const parsed = z.string().trim().min(1).max(500).parse(query);
    return this.within(claims, async (tx, _job, items, context) => {
      const loaded = new Set(this.current(context, items).map((tool) => tool.name));
      const rest = items.filter((item) => !loaded.has(item.entry.name)).map((item) => item.entry);
      // Only letters and digits reach the query text, so it cannot carry an operator.
      const lexemes = words(parsed).slice(0, SEARCH_TERMS).join(' | ');
      // The input contains only already-authorized entries. Even the ranking engine
      // cannot reveal another space's names, schemas, examples or result counts.
      const ranked = lexemes
        ? await tx`with entries as (
        select value as entry, regexp_replace(value->>'name', '[._-]', ' ', 'g') as segments
        from jsonb_array_elements(${JSON.stringify(rest)}::jsonb)
      ), documents as (
        select entry,
          setweight(to_tsvector('english', segments), 'A') ||
          setweight(to_tsvector('simple', segments), 'A') ||
          setweight(to_tsvector('english', entry->>'description'), 'B') ||
          setweight(to_tsvector('english', (entry->'examples')::text), 'C') as document
        from entries
      ), query as (
        select to_tsquery('english', ${lexemes}) || to_tsquery('simple', ${lexemes}) as terms
      )
      select entry from documents, query where document @@ terms
      order by ts_rank(document, terms) desc, entry->>'name' collate "C"`
        : [];
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
      if (result.length > 0) return { tools: result };
      const index: CatalogSearch['index'] = [];
      for (const entry of rest) {
        if (entry.health === 'failing') continue;
        const next = { name: entry.name, gist: gist(entry.description) };
        if (estimateTokens(JSON.stringify([...index, next])) > SEARCH_RESULT_TOKENS) break;
        index.push(next);
      }
      return {
        tools: [],
        index,
        hint: index.length
          ? `No tool matched ${JSON.stringify(parsed)}. These are the tools load_tool can fetch by exact name.`
          : `No tool matched ${JSON.stringify(parsed)}, and nothing further can be loaded in this attempt.`,
      };
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

  async callSkill(claims: CapabilityClaims, name: string, args: JsonObject): Promise<JsonObject> {
    const reading = name === SKILL_READ_TOOL.name;
    // A skill's own tool takes no arguments; the reader takes the name to read.
    const asked = reading
      ? z.strictObject({ name: z.string().min(1).max(80) }).parse(args).name
      : null;
    if (!reading) z.object({}).strict().parse(args);
    return this.within(claims, async (tx, job, items, context) => {
      if (
        !this.current(context, items).some(
          (tool) => tool.name === name && tool.connection_id === null,
        )
      )
        throw new BrokerFault('unknown_tool');
      const skill = (await this.skills(tx, job, claims)).find((item) =>
        reading
          ? item.frontmatter.name === asked
          : `skills.${item.frontmatter.name.replaceAll('-', '_')}` === name,
      );
      if (!skill) throw new BrokerFault('unknown_tool');
      // The conversation shows the read as a tool entry naming the skill.
      const at = new Date().toISOString();
      const title = plainSkillTitle(skill.frontmatter.name);
      await appendToolTrace(tx, job.id, claims.attempt_id, {
        id: `skill-read:${claims.attempt_id}:${skill.frontmatter.name}`,
        kind: 'skill',
        title: `Used the skill: ${title}`,
        status: 'done',
        started_at: at,
        ended_at: at,
        input_summary: null,
        output_summary: { text: title },
        detail: null,
        parent: null,
      });
      await appendEvent(tx, job.id, claims.attempt_id, 'notice', {
        phase: 'skill_read',
        name,
        effect_class: 'read',
      });
      return { name: skill.frontmatter.name, body: skill.body };
    });
  }
}
