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

  test('repeat declares a cron or a rule and its start, and the call a model sends parses', () => {
    const repeat = (RUN_START_TOOL.input_schema.properties as Record<string, Node>).repeat;
    expect(Object.keys(repeat?.properties as Node)).toEqual([
      'cron',
      'rrule',
      'starts',
      'timezone',
    ]);
    expect(repeat?.required).toBeUndefined();
    expect(
      runStartInput.parse({
        goal: 'Check in with me',
        title: 'smoke-routine',
        repeat: { cron: '0 9 * * 1', timezone: 'America/Los_Angeles' },
      }).repeat,
    ).toEqual({ cron: '0 9 * * 1', timezone: 'America/Los_Angeles' });
  });

  test('a missing cron says how to write one, and when to use a rule instead', () => {
    const issue = runSchedule.safeParse({}).error?.issues[0];
    expect(issue?.path).toEqual(['cron']);
    expect(issue?.message).toContain('missing');
    expect(issue?.message).toContain('"0 9 * * 1" is Mondays at 9:00');
    expect(issue?.message).toContain('give rrule and starts');
  });

  test('a calendar rule parses with its start, and is refused without one or beside a cron', () => {
    const rule = { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', starts: '2026-10-16T09:00' };
    expect(runStartInput.parse({ goal: 'Payday check', repeat: rule }).repeat).toEqual(rule);
    const issue = (repeat: unknown) => {
      const found = runSchedule.safeParse(repeat).error?.issues[0];
      return found && { path: found.path, message: found.message };
    };
    expect(issue({ rrule: rule.rrule })).toMatchObject({
      path: ['starts'],
      message: expect.stringContaining('needs starts'),
    });
    expect(issue({ ...rule, cron: '0 9 * * 5' })).toMatchObject({
      path: ['rrule'],
      message: 'Give a cron or an rrule, not both.',
    });
    expect(issue({ cron: '0 9 * * 5', starts: rule.starts })?.path).toEqual(['starts']);
    expect(issue({ rrule: 'FREQ=WEEKLY;BYDAY=1FR', starts: rule.starts })?.message).toContain(
      'needs FREQ=MONTHLY',
    );
    // Each refusal points at the part to change.
    expect(issue({ rrule: 'FREQ=HOURLY' })).toMatchObject({
      path: ['rrule'],
      message: expect.stringContaining('FREQ=HOURLY is not supported'),
    });
    expect(issue({ rrule: rule.rrule, starts: '16 October at 9' })).toMatchObject({
      path: ['starts'],
      message: expect.stringContaining('starts is the first time'),
    });
  });
});
