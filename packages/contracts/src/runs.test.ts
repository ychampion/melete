import { describe, expect, test } from 'bun:test';
import { RUN_START_TOOL, RUN_TOOLS, runSchedule, runStartInput } from './runs.ts';

type Node = Record<string, unknown>;

/** Object nodes that say nothing about their keys, by path. */
function looseObjects(node: unknown, path: string, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) looseObjects(item, `${path}[${index}]`, found);
  } else if (node && typeof node === 'object') {
    const schema = node as Node;
    if (schema.type === 'object' && !schema.properties && schema.additionalProperties === undefined)
      found.push(path);
    for (const [key, value] of Object.entries(schema)) looseObjects(value, `${path}.${key}`, found);
  }
  return found;
}

describe('run tool schemas', () => {
  // An object with no declared keys reaches some providers as one that takes
  // none, and the model can then only send it empty.
  test('every object names its keys or what its values are', () => {
    for (const tool of RUN_TOOLS) expect(looseObjects(tool.input_schema, tool.name)).toEqual([]);
  });

  test('repeat declares cron and timezone, and the call a model sends parses', () => {
    const repeat = (RUN_START_TOOL.input_schema.properties as Record<string, Node>).repeat;
    expect(Object.keys(repeat?.properties as Node)).toEqual(['cron', 'timezone']);
    expect(repeat?.required).toEqual(['cron']);
    expect(
      runStartInput.parse({
        goal: 'Check in with me',
        title: 'smoke-routine',
        repeat: { cron: '0 9 * * 1', timezone: 'America/Los_Angeles' },
      }).repeat,
    ).toEqual({ cron: '0 9 * * 1', timezone: 'America/Los_Angeles' });
  });

  test('a missing cron says how to write one', () => {
    const issue = runSchedule.safeParse({}).error?.issues[0];
    expect(issue?.path).toEqual(['cron']);
    expect(issue?.message).toContain('missing');
    expect(issue?.message).toContain('"0 9 * * 1" is Mondays at 9:00');
  });
});
