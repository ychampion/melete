import { describe, expect, test } from 'bun:test';
import { unfenced } from './proposal-gateway.ts';

const body = '{"target":"skill_body"}';

describe('the proposal answer fence', () => {
  test('exactly one json or bare fence around the answer is removed', () => {
    expect(JSON.parse(unfenced(`\`\`\`json\n${body}\n\`\`\``))).toEqual({ target: 'skill_body' });
    expect(JSON.parse(unfenced(`\`\`\`\n${body}\n\`\`\``))).toEqual({ target: 'skill_body' });
    expect(JSON.parse(unfenced(`  \`\`\`json\r\n${body}\r\n\`\`\`  \n`))).toEqual({
      target: 'skill_body',
    });
    expect(unfenced(body)).toBe(body);
  });

  test('anything more lenient than one fence is left for the parser to refuse', () => {
    for (const text of [
      `Here you go:\n\`\`\`json\n${body}\n\`\`\``,
      `\`\`\`json\n${body}\n\`\`\`\nHope that helps.`,
      `\`\`\`json\n\`\`\`json\n${body}\n\`\`\`\n\`\`\``,
      `\`\`\`javascript\n${body}\n\`\`\``,
      `\`\`\`json ${body} \`\`\``,
      `~~~json\n${body}\n~~~`,
    ])
      expect(() => JSON.parse(unfenced(text))).toThrow();
  });
});
