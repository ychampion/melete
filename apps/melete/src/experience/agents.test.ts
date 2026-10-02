import { expect, test } from 'bun:test';
import { agentInput, freeAgentName, sameAgentName } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { ServiceError } from '../api/errors.ts';
import {
  AGENT_TEMPLATES,
  agentIdentity,
  agentValues,
  MELETE_AGENT,
  mentionedAgent,
  NO_MEMORY_NOTE,
} from './agents.ts';

test('agent identity accepts multibyte text within the contract character limits', () => {
  const input = agentInput.parse({
    ...AGENT_TEMPLATES.templates[0]?.agent,
    name: '星'.repeat(40),
    tone: '静'.repeat(80),
    standing_instruction: '学'.repeat(200),
  });
  const text = agentIdentity(input);
  expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(1000);
  expect(estimateTokens(text)).toBeLessThanOrEqual(250);
  expect(agentValues(input)).toMatchObject({
    name: input.name,
    standingInstruction: input.standing_instruction,
  });
});

test('an overlong agent identity is a bad request service error', () => {
  let failure: unknown;
  try {
    agentIdentity({ name: 'Nova', tone: 'Calm', standing_instruction: 'a'.repeat(1000) });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ServiceError);
  expect(failure).toMatchObject({ code: 'invalid_request', status: 400 });
});

test('a mention at the start names an agent, the longest name first', () => {
  const agents = [{ name: 'Sage' }, { name: 'Sage Green' }, { name: 'Scout' }];
  expect(mentionedAgent('@scout find trains', agents)?.name).toBe('Scout');
  expect(mentionedAgent('@Scout, find trains', agents)?.name).toBe('Scout');
  expect(mentionedAgent('@Sage Green plan my week', agents)?.name).toBe('Sage Green');
  expect(mentionedAgent('@Sage plan my week', agents)?.name).toBe('Sage');
  expect(mentionedAgent('@Scouting trip ideas', agents)).toBeNull();
  expect(mentionedAgent('Ask @Scout later', agents)).toBeNull();
  expect(mentionedAgent('@Nobody here', agents)).toBeNull();
});

test('Melete keeps its name and reach, and speaks without a persona line', () => {
  expect(agentValues(MELETE_AGENT, true)).toMatchObject({ name: 'Melete', usesComputer: true });
  expect(() => agentValues({ ...MELETE_AGENT, name: 'Mel' }, true)).toThrow(ServiceError);
  expect(() => agentValues({ ...MELETE_AGENT, allowed_connection_ids: [] }, true)).toThrow(
    ServiceError,
  );
  // In a shared space its owner chooses what it may use; its name still stays.
  expect(agentValues({ ...MELETE_AGENT, allowed_connection_ids: [] }, true, false)).toMatchObject({
    allowedConnectionIds: [],
  });
  expect(() => agentValues({ ...MELETE_AGENT, name: 'House' }, true, false)).toThrow(ServiceError);
  expect(agentIdentity({ ...MELETE_AGENT, is_default: true })).toBe('Tone: Warm and clear.');
  expect(agentIdentity({ ...MELETE_AGENT, name: 'Scout' })).toContain('you are Scout');
});

test('an agent that keeps no memory is told so, within the identity cap', () => {
  const longest = agentInput.parse({
    ...AGENT_TEMPLATES.templates[0]?.agent,
    name: 'n'.repeat(40),
    tone: 't'.repeat(80),
    standing_instruction: 's'.repeat(200),
    writes_memory: false,
  });
  const text = agentIdentity(longest);
  expect(text).toContain(NO_MEMORY_NOTE);
  expect(NO_MEMORY_NOTE).toContain('Melete');
  expect(estimateTokens(text)).toBeLessThanOrEqual(250);
  expect(agentIdentity({ ...longest, writes_memory: true })).not.toContain(NO_MEMORY_NOTE);
  // Melete always keeps memory; its identity never carries the note.
  expect(agentIdentity({ ...MELETE_AGENT, is_default: true, writes_memory: false })).not.toContain(
    NO_MEMORY_NOTE,
  );
});

test('a free agent name is the one wanted, or the next numbered one', () => {
  expect(freeAgentName('Nova', ['Melete'])).toBe('Nova');
  expect(freeAgentName('Nova', ['Melete', 'nova'])).toBe('Nova 2');
  expect(freeAgentName('Nova', ['Nova', 'Nova 2', 'NOVA 3'])).toBe('Nova 4');
  const long = 'x'.repeat(40);
  expect(freeAgentName(long, [long])).toBe(`${'x'.repeat(38)} 2`);
  expect(sameAgentName(' Scout ', 'scout')).toBe(true);
  expect(sameAgentName('Scout', 'Scout 2')).toBe(false);
});
