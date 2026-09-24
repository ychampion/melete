import { CONTEXT_LIMITS, type ToolSpec } from '@melete/contracts';
import { chooseSkills, indexSkills } from '@melete/skills';
import { and, eq } from 'drizzle-orm';
import { RUNTIME_WAIT_TOOL } from '../broker/runtime-wait.ts';
import { type ConnectorLookup, grantedToolCatalog } from '../connectors/catalog.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { RunnerOptions } from '../jobs/runner.ts';
import { procedureReach } from '../learning/selection.ts';
import { skillPayloadOf, usableSkills } from '../principals/context.ts';

/**
 * Every tool name an attempt can reach: all it was granted, not the first few
 * by name, since discovery loads the rest, and the lifecycle wait, which is the
 * broker's own tool rather than a connection's.
 */
export function reachableToolNames(
  granted: readonly ToolSpec[],
  scopes: readonly string[],
): Set<string> {
  const names = new Set(granted.map((tool) => tool.name));
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
    const granted = await this.toolsForSpace(claims.space_id, claims.scopes, tx);
    const tools = granted.slice(0, CONTEXT_LIMITS.max_tools);
    const reachable = reachableToolNames(granted, claims.scopes);
    // The same selection bundle construction made, with its audience rules, now
    // over only the skills this attempt can use: one it cannot would otherwise
    // take a place and then be dropped. Evaluated procedures keep their place.
    const objective = bundle.job.objective;
    const latest = bundle.inputs.new_user_messages.at(-1)?.content ?? '';
    const procedures = bundle.skills.filter((skill) => skill.name.startsWith('procedure:'));
    const usable = await usableSkills(
      tx,
      claims.space_id,
      bundle.principal_id ?? null,
      bundle.job.constraints.public_compartment === true,
      (needed) => needed.every((tool) => reachable.has(tool)),
      await procedureReach(tx, procedures),
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
