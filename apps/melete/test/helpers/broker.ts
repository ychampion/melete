import type { CapabilityClaims, JobBudget, JobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import { recordId } from '../../src/broker/records.ts';

/** Observe rejection asynchronously; Bun's rejects matcher can stall postgres socket progress on Windows. */
export async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject');
}

export const defaultBudget: JobBudget = {
  max_actions: 20,
  max_attempts: 3,
  max_output_tokens: 10_000,
  max_turns: 10,
  max_wall_ms: 60_000,
  max_usd_est: 2,
};

export async function seedJob(
  sql: Sql,
  options: {
    scopes?: string[];
    budget?: Partial<JobBudget>;
    constraints?: Partial<JobConstraints>;
    provider?: string;
  } = {},
): Promise<{ claims: CapabilityClaims; connectionId: string }> {
  const spaceId = recordId('sp');
  const jobId = recordId('job');
  const attemptId = recordId('att');
  const connectionId = recordId('conn');
  const budget = { ...defaultBudget, ...options.budget };
  const scopes = options.scopes ?? ['test.send', 'test.read'];
  await sql`insert into space (id, name, git_path) values (${spaceId}, 'Fixture', ${`spaces/${spaceId}`})`;
  await sql`insert into connection (id, space_id, provider, label, scopes)
    values (${connectionId}, ${spaceId}, ${options.provider ?? 'test'}, 'Fixture', ${JSON.stringify(scopes)}::jsonb)`;
  await sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
    values (${jobId}, ${spaceId}, 'Fixture', 'Verify the effect boundary', 'running', 1,
      ${JSON.stringify(budget)}::jsonb, ${JSON.stringify({ public_compartment: false, allowed_domains: [], ...options.constraints })}::jsonb)`;
  await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
  return {
    connectionId,
    claims: {
      job_id: jobId,
      attempt_id: attemptId,
      space_id: spaceId,
      epoch: 1,
      revision: 0,
      scopes,
      budget: {
        max_actions: budget.max_actions,
        max_output_tokens: budget.max_output_tokens,
        max_usd_est: budget.max_usd_est,
      },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}
