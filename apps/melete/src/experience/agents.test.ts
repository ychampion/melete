import { expect, test } from 'bun:test';
import { agentInput } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { ServiceError } from '../api/errors.ts';
import { AGENT_TEMPLATES, agentIdentity, agentValues } from './agents.ts';

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
