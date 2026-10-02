import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';

let made = 0;

/** A template's agent under a name of its own, since two agents in a space never share one. */
export function freshAgent(index = 0) {
  const template = AGENT_TEMPLATES.templates[index]?.agent;
  if (!template) throw new Error(`no template ${index}`);
  made += 1;
  return { ...template, name: `${template.name} ${made}` };
}
