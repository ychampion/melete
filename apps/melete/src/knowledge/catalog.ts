import type { ToolSpec } from '@melete/contracts';
import { SANDBOX_TERMINAL_TOOL } from '@melete/runtime-hermes';
import { chooseSkills, indexSkills } from '@melete/skills';
import { and, eq } from 'drizzle-orm';
import { ASK_PERSON_TOOL_NAME } from '../broker/ask-person.ts';
import { ALWAYS_OFFERED_WEB_TOOLS } from '../broker/catalog.ts';
import { RUNTIME_WAIT_TOOL } from '../broker/runtime-wait.ts';
import { type ConnectorLookup, grantedToolCatalog } from '../connectors/catalog.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { agentAccessIn, connectionOffered, offeredTo } from '../experience/access.ts';
import { attemptContextBudget } from '../jobs/context-budget.ts';
import type { RunnerOptions } from '../jobs/runner.ts';
import { connectionServesJob, typedAudience } from '../jobs/scopes.ts';
import { learnedSkills, procedureReach } from '../learning/selection.ts';
import { skillPayloadOf, turnAgentKeepsMemory, usableSkills } from '../principals/context.ts';

/**
 * Every tool name an attempt can reach: all it was granted, not the first few
 * by name, since discovery loads the rest, and the lifecycle wait and the
 * question for the person, which are the broker's own tools rather than a
 * connection's.
 */
export function reachableToolNames(
  granted: readonly ToolSpec[],
  scopes: readonly string[],
): Set<string> {
  const names = new Set([...granted.map((tool) => tool.name), ASK_PERSON_TOOL_NAME]);
  if (scopes.includes(RUNTIME_WAIT_TOOL.name)) names.add(RUNTIME_WAIT_TOOL.name);
  return names;
}

/** The API and runtime consult live grants against the same configured adapters. */
export class RuntimeCatalog {
  constructor(
    private readonly db: Database,
    private readonly connectors: ConnectorLookup,
  ) {}

  /**
   * The tools of a space's active connections that the scopes grant. With a
   * job, only the connections that serve that job: two connections can grant
   * the same scope, and a room's request is offered only the room's.
   */
  async toolsForSpace(
    spaceId: string,
    scopes?: readonly string[],
    query: Database | Transaction = this.db,
    jobId?: string,
  ): Promise<ToolSpec[]> {
    const connections = await query
      .select()
      .from(connection)
      .where(and(eq(connection.spaceId, spaceId), eq(connection.status, 'active')));
    const audience = jobId ? await typedAudience(query, jobId) : null;
    if (jobId && !audience) return [];
    const serving = audience
      ? connections.filter((row) => connectionServesJob(audience, row.sharedUse))
      : connections;
    return grantedToolCatalog(serving, this.connectors, scopes);
  }

  forAttempt: NonNullable<RunnerOptions['loadCatalog']> = async (tx, claims, bundle) => {
    // Only what this turn's agent may use, by the broker catalog's own rule: an
    // agent without the computer gets no engine terminal, and a narrowed agent
    // only its connections' tools. Anything more is offered and then refused.
    const access = await agentAccessIn(tx, claims.job_id);
    // How much of each kind this attempt's model has room for.
    const budget = attemptContextBudget(bundle.model.model, bundle.budget);
    const granted = (
      await this.toolsForSpace(claims.space_id, claims.scopes, tx, claims.job_id)
    ).filter((tool) => offeredTo(access, tool));
    // The engine builds its own terminal from the sandbox's terminal.run in this
    // list, and the plugin hands the terminal to it whenever the broker serves
    // that tool. So it keeps its place ahead of the cut: sorted by name, a
    // paired computer's device tools would push it out, and the engine would
    // start with no terminal while the plugin still expected one.
    const terminal = granted.filter(
      (tool) => tool.name === SANDBOX_TERMINAL_TOOL && tool.connection_id !== null,
    );
    // Searching and reading the web keep their place the same way, as the
    // broker's own first catalog keeps them: every agent has them whatever else
    // its space connects.
    const web = granted.filter(
      (tool) =>
        tool.connection_id !== null &&
        ALWAYS_OFFERED_WEB_TOOLS.some(
          (name) => tool.name === name || tool.name.startsWith(`${name}__`),
        ),
    );
    const first = [...terminal, ...web];
    const kept = new Set(
      [...first, ...granted.filter((tool) => !first.includes(tool))].slice(0, budget.max_tools),
    );
    const tools = granted.filter((tool) => kept.has(tool));
    const reachable = reachableToolNames(granted, claims.scopes);
    // The same selection bundle construction made, with its audience rules, now
    // over only the skills this attempt can use: one it cannot would otherwise
    // take a place and then be dropped. Learned skills keep their place: the
    // evaluated procedures and the engine's own live skills. Only a correction
    // procedure's own trigger words leave a built-in out beside it.
    const objective = bundle.job.objective;
    const latest = bundle.inputs.new_user_messages.at(-1)?.content ?? '';
    const procedures = await learnedSkills(tx, bundle.skills, {
      spaceId: claims.space_id,
      principalId: bundle.principal_id ?? null,
    });
    const usable = await usableSkills(
      tx,
      claims.space_id,
      bundle.principal_id ?? null,
      bundle.job.constraints.public_compartment === true,
      (needed) => needed.every((tool) => reachable.has(tool)),
      await procedureReach(tx, procedures),
      await turnAgentKeepsMemory(tx, bundle.attempt.job_id),
    );
    // Triggers now only rank: the likeliest few are given in full, and every
    // other usable skill is named in the index for the attempt to read itself.
    const chosen = chooseSkills(objective, latest, usable, budget.max_skills).map(({ skill }) =>
      skillPayloadOf(skill, claims.space_id),
    );
    const skills = [
      ...procedures,
      ...chosen.filter((skill) => !procedures.some((kept) => kept.name === skill.name)),
    ].slice(0, budget.max_skills);
    const given = new Set(skills.map((skill) => skill.name));
    const skill_index = indexSkills(
      objective,
      latest,
      usable.filter((skill) => !given.has(skill.frontmatter.name)),
      budget.skill_index_tokens,
    );
    const connected_accounts = await this.connectedAccounts(tx, claims, access, granted);
    return {
      tools,
      skills,
      skill_index,
      ...(connected_accounts.length ? { connected_accounts } : {}),
    };
  };

  /**
   * One line for each account the person connected that this attempt may use,
   * saying how: a connected app by its tools, and an account the computer's
   * command line reaches (GitHub, for one) by the commands that use it, since
   * it has no tool to find. The defaults every space has are left out.
   */
  private async connectedAccounts(
    tx: Transaction,
    claims: Parameters<NonNullable<RunnerOptions['loadCatalog']>>[1],
    access: Awaited<ReturnType<typeof agentAccessIn>>,
    granted: readonly ToolSpec[],
  ): Promise<string[]> {
    const audience = await typedAudience(tx, claims.job_id);
    if (!audience) return [];
    const rows = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.spaceId, claims.space_id), eq(connection.status, 'active')))
      .orderBy(connection.label);
    const terminal = granted.some(
      (tool) => tool.name === SANDBOX_TERMINAL_TOOL && tool.connection_id !== null,
    );
    const lines: string[] = [];
    for (const row of rows) {
      if (!connectionServesJob(audience, row.sharedUse) || !connectionOffered(access, row.id))
        continue;
      const configuration = (row.configuration ?? {}) as Record<string, unknown>;
      if (typeof configuration.builtin === 'string') continue;
      if (row.provider === 'command_line') {
        const adapter = configuration.kind === 'command_line' ? configuration.adapter : null;
        const how = typeof adapter === 'string' ? COMMAND_LINE_USE[adapter] : undefined;
        const read = `egress.${String(adapter)}_read`;
        if (!how || !row.scopes.includes(read) || !claims.scopes.includes(read)) continue;
        lines.push(
          terminal
            ? `${row.label}: ${how}`
            : `${row.label}: reached only from your computer's terminal, which this conversation does not have.`,
        );
        continue;
      }
      const tools = granted
        .filter((tool) => tool.connection_id === row.id)
        .map((tool) => tool.name);
      if (!tools.length) continue;
      lines.push(
        `${row.label}: ${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ', and more that search_tools finds' : ''}.`,
      );
    }
    return lines.slice(0, 20).map((line) => line.replace(/\s+/g, ' ').slice(0, 300));
  }
}

/** How a command-line account is used from the agent's computer, by adapter. */
const COMMAND_LINE_USE: Record<string, string> = {
  github:
    "signed in for git and gh in your computer's terminal; for the GitHub API with curl, send `Authorization: Bearer $GH_TOKEN`. The account is added for you, so never ask the person for a token.",
  gitlab:
    "signed in for git and glab in your computer's terminal. The account is added for you, so never ask the person for a token.",
  aws: "signed in for the aws command line in your computer's terminal. The key is added for you, so never ask the person for one.",
  npm: "signed in for npm in your computer's terminal. The token is added for you, so never ask the person for one.",
};
