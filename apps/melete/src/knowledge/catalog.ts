import { join } from 'node:path';
import { CONTEXT_LIMITS, skillsWithToolsAvailable, type ToolSpec } from '@melete/contracts';
import { loadSkills } from '@melete/skills';
import { and, eq } from 'drizzle-orm';
import { RUNTIME_WAIT_TOOL } from '../broker/runtime-wait.ts';
import { type ConnectorLookup, grantedToolCatalog } from '../connectors/catalog.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { RunnerOptions } from '../jobs/runner.ts';

/** The API and runtime consult live grants against the same configured adapters. */
export class RuntimeCatalog {
  constructor(
    private readonly db: Database,
    private readonly connectors: ConnectorLookup,
    private readonly spacesRoot: string,
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
    // A skill is checked against everything the attempt can reach, not the first
    // few tools by name: discovery loads the rest, and the lifecycle wait is the
    // broker's own tool rather than a connection's.
    const reachable: ToolSpec[] = claims.scopes.includes(RUNTIME_WAIT_TOOL.name)
      ? [...granted, RUNTIME_WAIT_TOOL]
      : granted;
    const available = new Set(
      skillsWithToolsAvailable(
        loadSkills({ spaceSkillsDirectory: join(this.spacesRoot, claims.space_id, 'skills') })
          .skills,
        reachable,
      ).map((skill) => skill.frontmatter.name),
    );
    // Bundle construction already checked audience and evaluated-procedure evidence.
    // Catalog enrichment may narrow those skills, but must not replace that selection.
    const skills = bundle.skills.filter(
      (skill) => skill.name.startsWith('procedure:') || available.has(skill.name),
    );
    return { tools, skills };
  };
}
