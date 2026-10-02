import { sql } from 'drizzle-orm';
import type { Query } from '../broker/records.ts';
import type { Transaction } from '../db/transaction.ts';

/** The active turn pins its agent; changing the header selects the following turn. */
export async function agentAccess(tx: Query, jobId: string) {
  const [row] =
    await tx`select j.kind, j.paused, j.current_turn_id, coalesce(t.agent_id, j.agent_id) as bound_agent_id, a.id, a.allowed_connection_ids, a.asks_before_acting,
      a.uses_computer, a.reads_memory, a.writes_memory
    from job j left join experience_turn t on t.id = j.current_turn_id
    left join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
    where j.id = ${jobId}`;
  return accessOf(row);
}

/** The same reading inside the runner's transaction, where the attempt's bundle is built. */
export async function agentAccessIn(tx: Transaction, jobId: string): Promise<AgentAccess> {
  const [row] = await tx.execute<
    Record<string, unknown>
  >(sql`select j.kind, j.paused, j.current_turn_id, coalesce(t.agent_id, j.agent_id) as bound_agent_id, a.id, a.allowed_connection_ids, a.asks_before_acting,
      a.uses_computer, a.reads_memory, a.writes_memory
    from job j left join experience_turn t on t.id = j.current_turn_id
    left join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
    where j.id = ${jobId}`);
  return accessOf(row);
}

function accessOf(row: Record<string, unknown> | undefined) {
  return {
    chat: row?.kind === 'chat',
    turnId: ['chat', 'routine'].includes(String(row?.kind))
      ? (row?.current_turn_id as string | undefined)
      : undefined,
    paused: row?.paused === true,
    missingAgent: Boolean(row?.bound_agent_id && !row?.id),
    agentId: row?.id as string | undefined,
    allowed: (row?.allowed_connection_ids ?? undefined) as string[] | undefined,
    asksBeforeActing: row?.asks_before_acting !== false,
    /** Work with no agent of its own (a job, an evaluation) is not narrowed here. */
    usesComputer: row?.uses_computer !== false,
    readsMemory: row?.reads_memory !== false,
    writesMemory: row?.writes_memory !== false,
  };
}

export type AgentAccess = ReturnType<typeof accessOf>;

export const directSend = (kind: string) => /(?:^|[._])send(?:$|[._])/i.test(kind);

/**
 * The computer is the agent's own (its browser, terminal and code in the
 * workspace) and the person's paired computers. An agent the person set not to
 * use it is offered none of these tools, and the broker refuses them if asked
 * anyway.
 */
export const computerTool = (kind: string) =>
  /^(?:browser|computer|terminal|exec|device)\./.test(kind);

/**
 * Whether the agent is offered a connection's tools at all: work in a chat with
 * no agent is offered none, and an agent narrowed to some connections only those.
 */
export const connectionOffered = (access: AgentAccess, connectionId: string): boolean =>
  !(access.chat && !access.agentId) && !(access.allowed && !access.allowed.includes(connectionId));

/** Whether the agent is offered one of a connection's tools, by its name. */
export const toolOffered = (access: AgentAccess, name: string): boolean =>
  !(access.chat && directSend(name)) && !(!access.usesComputer && computerTool(name));

/**
 * The broker catalog's rule for one tool, for anything that must agree with it:
 * the engine is built only with what the agent may use. A broker tool of its
 * own (no connection) is not narrowed here.
 */
export const offeredTo = (
  access: AgentAccess,
  tool: { name: string; connection_id: string | null },
): boolean =>
  tool.connection_id === null ||
  (connectionOffered(access, tool.connection_id) && toolOffered(access, tool.name));
