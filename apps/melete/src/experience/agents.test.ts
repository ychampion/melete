import { expect, test } from 'bun:test';
import { agentInput } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { ServiceError } from '../api/errors.ts';
import {
  AGENT_TEMPLATES,
  agentIdentity,
  agentValues,
  MELETE_AGENT,
  mentionedAgent,
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
