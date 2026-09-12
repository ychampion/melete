import { join } from 'node:path';
import { CONTEXT_LIMITS, type ToolSpec } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { type ConnectorLookup, grantedToolCatalog } from '../connectors/catalog.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { RunnerOptions } from '../jobs/runner.ts';
import { skillsForObjective } from './routes.ts';

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
    const tools = (await this.toolsForSpace(claims.space_id, claims.scopes, tx)).slice(
      0,
      CONTEXT_LIMITS.max_tools,
    );
    const latest = bundle.inputs.new_user_messages.at(-1)?.content ?? '';
    const skills = skillsForObjective(
      bundle.job.objective,
      latest,
      join(this.spacesRoot, claims.space_id, 'skills'),
      tools,
    ).map(({ skill }) => ({ name: skill.frontmatter.name, body: skill.body }));
    return { tools, skills };
  };
}
