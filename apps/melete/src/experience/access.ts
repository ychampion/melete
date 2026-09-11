import type { Query } from '../broker/records.ts';

/** The active turn pins its agent; changing the header selects the following turn. */
export async function agentAccess(tx: Query, jobId: string) {
  const [row] =
    await tx`select j.kind, j.paused, a.id, a.allowed_connection_ids, a.asks_before_acting
    from job j left join experience_turn t on t.id = j.current_turn_id
    left join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
    where j.id = ${jobId}`;
  return {
    chat: row?.kind === 'chat',
    paused: row?.paused === true,
    agentId: row?.id as string | undefined,
    allowed: row?.allowed_connection_ids as string[] | undefined,
    asksBeforeActing: row?.asks_before_acting !== false,
  };
}

export const directSend = (kind: string) => /(?:^|[._])send(?:$|[._])/i.test(kind);
