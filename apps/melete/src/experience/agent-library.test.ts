import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_CATEGORIES, AGENT_WORKS_WITH, sameAgentName } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { AGENT_TEMPLATES, agentIdentity, agentValues } from './agents.ts';

const templates = AGENT_TEMPLATES.templates;
const builtin = join(import.meta.dir, '../../../../packages/skills/builtin');

test('the library has a good spread, one shelf at a time', () => {
  expect(templates.length).toBeGreaterThanOrEqual(20);
  for (const category of AGENT_CATEGORIES)
    expect(templates.some((template) => template.category === category)).toBe(true);
  expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
  expect(templates.some((template) => template.featured)).toBe(true);
});

test('every name is its own, and none is taken by Melete or the familiar faces', () => {
  const names = templates.map((template) => template.agent.name);
  for (const [i, name] of names.entries()) {
    for (const other of names.slice(i + 1)) expect(sameAgentName(name, other)).toBe(false);
    for (const reserved of ['Melete', 'Nova', 'Atlas', 'Scout', 'Quill', 'Sage'])
      expect(sameAgentName(name, reserved)).toBe(false);
  }
});

test('no template grants a connection; what it works best with is only shown', () => {
  for (const template of templates) {
    expect(template.agent.allowed_connection_ids).toEqual([]);
    expect(template.works_best_with.length).toBeGreaterThan(0);
    for (const kind of template.works_best_with) expect(AGENT_WORKS_WITH).toContain(kind);
    expect(new Set(template.works_best_with).size).toBe(template.works_best_with.length);
    // An agent without the computer is never sold on the computer, a browser or a device.
    if (!template.agent.uses_computer)
      for (const kind of ['computer', 'browser', 'devices'] as const)
        expect(template.works_best_with).not.toContain(kind);
  }
});

test('every brief saves as an agent and fits the persona cap', () => {
  for (const template of templates) {
    expect(template.agent.asks_before_acting).toBe(true);
    expect(template.agent.standing_instruction.length).toBeGreaterThan(200);
    const identity = agentIdentity(template.agent);
    expect(estimateTokens(identity)).toBeLessThanOrEqual(250);
    expect(agentValues(template.agent).allowedConnectionIds).toEqual([]);
    expect(template.wont.length).toBeGreaterThan(0);
  }
});

test('questions save to a key of their own, only for agents that read memory', () => {
  const keys = templates.flatMap((template) =>
    template.questions.map((question) => question.memory_key),
  );
  expect(new Set(keys).size).toBe(keys.length);
  for (const template of templates) {
    expect(template.questions.length).toBeLessThanOrEqual(4);
    if (template.questions.length) expect(template.agent.reads_memory).toBe(true);
    // One purpose per agent: its answers share one pref.<purpose> domain.
    const domains = new Set(template.questions.map((q) => q.memory_key.split('.')[1]));
    expect(domains.size).toBeLessThanOrEqual(1);
  }
});

test('named skills are built in, and a starter routine is a real schedule', () => {
  for (const template of templates) {
    for (const skill of template.skills)
      expect(existsSync(join(builtin, skill, 'SKILL.md'))).toBe(true);
    const routine = template.starter_routine;
    if (routine) {
      expect(new Set(routine.weekdays).size).toBe(routine.weekdays.length);
      expect(routine.at).toMatch(/^\d\d:\d\d$/);
    }
  }
});
