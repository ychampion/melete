import type { Result } from './adapter.ts';
import type { Agent, AgentInput } from './types.ts';

type AgentCalls = {
  agents: () => Promise<Result<{ agents: Agent[] }>>;
  createAgent: (input: AgentInput) => Promise<Result<{ agent: Agent }>>;
};

/**
 * The agent a first message from Home goes to. Skipping setup leaves none, so
 * the default one is made, but only once the service says there is none: a
 * list that has not loaded yet, or failed to load, is not an empty one.
 */
export async function agentForFirstMessage(
  known: string | undefined,
  fallback: AgentInput,
  calls: AgentCalls,
): Promise<{ id: string; created: boolean } | { error: string }> {
  if (known) return { id: known, created: false };
  const listed = await calls.agents();
  if (listed.data === null) return { error: listed.error ?? listed.unavailable };
  const first = listed.data.agents[0];
  if (first) return { id: first.id, created: false };
  const made = await calls.createAgent(fallback);
  if (made.data === null) return { error: made.error ?? made.unavailable };
  return { id: made.data.agent.id, created: true };
}
