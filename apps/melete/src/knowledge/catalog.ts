import { CONTEXT_LIMITS, type ToolSpec } from '@melete/contracts';
import { SANDBOX_TERMINAL_TOOL } from '@melete/runtime-hermes';
import { chooseSkills, indexSkills } from '@melete/skills';
import { and, eq } from 'drizzle-orm';
import { ASK_PERSON_TOOL_NAME } from '../broker/ask-person.ts';
import { RUNTIME_WAIT_TOOL } from '../broker/runtime-wait.ts';
import { type ConnectorLookup, grantedToolCatalog } from '../connectors/catalog.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { agentAccessIn, offeredTo } from '../experience/access.ts';
import type { RunnerOptions } from '../jobs/runner.ts';
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

  async toolsForSpace(
    spaceId: string,
    scopes?: readonly string[],
    query: Database | Transaction = this.db,
  ): Promise<ToolSpec[]> {
    const connections = await query
      .select()
      .from(connection)
      .where(and(eq(connection.spaceId, spaceId), eq(connection.status, 'active')));
    return grantedToolCatalog(connections, this.connectors, scopes);
  }

  forAttempt: NonNullable<RunnerOptions['loadCatalog']> = async (tx, claims, bundle) => {
    // Only what this turn's agent may use, by the broker catalog's own rule: an
    // agent without the computer gets no engine terminal, and a narrowed agent
    // only its connections' tools. Anything more is offered and then refused.
    const access = await agentAccessIn(tx, claims.job_id);
    const granted = (await this.toolsForSpace(claims.space_id, claims.scopes, tx)).filter((tool) =>
      offeredTo(access, tool),
    );
    // The engine builds its own terminal from the sandbox's terminal.run in this
    // list, and the plugin hands the terminal to it whenever the broker serves
    // that tool. So it keeps its place ahead of the cut: sorted by name, a
    // paired computer's device tools would push it out, and the engine would
    // start with no terminal while the plugin still expected one.
    const terminal = granted.filter(
      (tool) => tool.name === SANDBOX_TERMINAL_TOOL && tool.connection_id !== null,
    );
    const kept = new Set(
      [...terminal, ...granted.filter((tool) => !terminal.includes(tool))].slice(
        0,
        CONTEXT_LIMITS.max_tools,
      ),
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
    const chosen = chooseSkills(objective, latest, usable, 3).map(({ skill }) =>
      skillPayloadOf(skill, claims.space_id),
    );
    const skills = [
      ...procedures,
      ...chosen.filter((skill) => !procedures.some((kept) => kept.name === skill.name)),
    ].slice(0, CONTEXT_LIMITS.max_skills);
    const given = new Set(skills.map((skill) => skill.name));
    const skill_index = indexSkills(
      objective,
      latest,
      usable.filter((skill) => !given.has(skill.frontmatter.name)),
      CONTEXT_LIMITS.skill_index_tokens,
    );
    return { tools, skills, skill_index };
  };
}
