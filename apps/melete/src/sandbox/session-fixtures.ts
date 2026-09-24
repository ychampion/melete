import type { Sql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { sandboxLabels } from './manifest.ts';
import type { SandboxSpec } from './types.ts';

/** The rows a sandbox session refers to: a space with a connection, an agent and a job. */
export async function seedSessionScope(sql: Sql) {
  const spaceId = recordId('sp');
  const connectionId = recordId('conn');
  const agentId = recordId('agent');
  const jobId = recordId('job');
  await sql`insert into space (id, name, git_path) values (${spaceId}, 'Sandbox', ${`/spaces/${spaceId}`})`;
  await sql`insert into connection (id, space_id, provider, label)
    values (${connectionId}, ${spaceId}, 'test', 'Sandbox')`;
  await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
    values (${agentId}, ${spaceId}, 'Agent', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
  await sql`insert into job (id, space_id, title, objective) values (${jobId}, ${spaceId}, 'Job', 'Run')`;
  let epoch = 0;
  const attempt = async () => {
    epoch += 1;
    const id = recordId('att');
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${id}, ${jobId}, ${epoch}, 'fake', 'fake', 'scripted')`;
    return id;
  };
  const action = async (attemptId: string) => {
    const id = recordId('act');
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, idempotency_key)
      values (${id}, ${jobId}, ${attemptId}, ${connectionId}, 'terminal.run', 'write_reversible',
        '{}'::jsonb, 'hash', ${id})`;
    return id;
  };
  return { spaceId, connectionId, agentId, jobId, attempt, action };
}

/**
 * A spec labelled the way the service labels one. `connectionId` is part of it
 * because reconciliation reads that label, so a fixture that left it out would
 * be kept by the rule that protects another connection rather than by its own.
 */
export const sessionSpec =
  (project: string, spaceId: string, connectionId?: string) =>
  (session: string): SandboxSpec => ({
    image: 'base',
    egress: { kind: 'deny_all' },
    region: null,
    lifetimeSeconds: 600,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({ project, connection: connectionId ?? null, space: spaceId, session }),
    env: {},
  });
