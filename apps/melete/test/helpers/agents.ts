import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';

let made = 0;

/**
 * A specialist made from a template, under a name of its own since two agents
 * in a space never share one. Templates start with no connections; this one
 * reaches every connection, the computer and memory, as the chats and tools
 * under test need.
 */
export function freshAgent(index = 0) {
  const template = AGENT_TEMPLATES.templates[index]?.agent;
  if (!template) throw new Error(`no template ${index}`);
  made += 1;
  return {
    ...template,
    name: `${template.name} ${made}`,
    allowed_connection_ids: null,
    uses_computer: true,
    reads_memory: true,
    writes_memory: true,
  };
}
