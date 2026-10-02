/**
 * A turn as a work log: each message the agent writes between tool calls is
 * its own message, in order; the work between two messages is one row whose
 * words say what it was; a finished turn folds behind how long it worked and
 * keeps its final answer below; reasoning is never drawn.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyEvents, applyHistory, fromTurns, type TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import { EditCard, ShellBlock, WorkGroup, WorkLine, WorkLog } from './WorkLog.tsx';
import {
  editOf,
  foldedTurns,
  layoutTurn,
  logItems,
  longMessage,
  readDiff,
  summarize,
  type Work,
  workedFor,
} from './worklog.ts';

const AT = '2026-10-01T09:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'How far is the eval run?',
  answer: '',
  status: 'working',
  delivery: null,
  created_at: AT,
};
let seq = 0;
const event = (item: ExperienceEvent['item'], turn = 'turn_1'): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turn,
  created_at: AT,
  item,
});
const entry = (id: string, patch: Partial<ToolEntry> = {}): ToolEntry => ({
  id,
  kind: 'sandbox',
  title: 'Ran `python3 progress.py`',
  status: 'done',
  started_at: at(0),
  ended_at: at(1),
  input_summary: null,
  output_summary: null,
  detail: null,
  parent: null,
  ...patch,
});
const tool = (t: ToolEntry) => event({ type: 'tool', tool: t });
const say = (text: string) => event({ type: 'text_delta', text });
const only = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing');
  return value;
};
const DIFF =
  '--- a/EVALS.md\n+++ b/EVALS.md\n@@ -1,3 +1,3 @@\n same\n-old line\n-old two\n+new line\n+new two';

/** A turn the agent worked through: a message, a read and a command, a message, more, the answer. */
function worked(): TranscriptTurn {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    event({ type: 'reasoning', text: 'Check the state file first.' }),
    say('I’ll check the '),
    say('eval state.'),
    tool(entry('call:read', { kind: 'file', title: 'Read progress.json' })),
    tool(entry('call:run1')),
    say('57 cells are complete.'),
    event({ type: 'reasoning', text: 'Now the failing watch case.' }),
    tool(entry('call:run2')),
    say('60 cells are complete.'),
    tool(entry('call:run3', { title: 'Ran `bun test`', status: 'failed' })),
    tool(entry('call:run4', { title: 'Ran `bun test` again' })),
    say('All 70 cells are done.'),
  ]);
  return only(transcript.turns[0]);
}

test('each message between tool calls is its own entry, in order, and reasoning is not one', () => {
  const items = logItems(worked());
  expect(items.map((item) => (item.type === 'message' ? item.text : item.type))).toEqual([
    'I’ll check the eval state.',
    'work',
    '57 cells are complete.',
    'work',
    '60 cells are complete.',
    'work',
    'All 70 cells are done.',
  ]);
});

test('the work between two messages is one row; a single call is its own line', () => {
  const items = logItems(worked());
  const runs = items.flatMap((item) => (item.type === 'work' ? [item.work.length] : []));
  expect(runs).toEqual([2, 1, 2]);
});

test('a summary says each kind once, in the order the work first did it', () => {
  const work = (patch: Partial<ToolEntry>): Work => ({ type: 'tool', tool: entry('x', patch) });
  expect(
    summarize([
      work({ kind: 'file', title: 'Read a.ts' }),
      work({}),
      work({ kind: 'file', title: 'Read b.ts' }),
    ]),
  ).toBe('Read files, ran a command');
  expect(summarize([work({}), work({})])).toBe('Ran commands');
  expect(
    summarize([
      work({ kind: 'file', title: 'Edited EVALS.md' }),
      work({ kind: 'web', title: 'Searched the web for “x”' }),
      work({ title: 'Took a screenshot of its computer' }),
    ]),
  ).toBe('Edited a file, searched the web, took a screenshot');
});

test('a finished turn folds its work behind how long it worked, the answer kept below', () => {
  const done = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say('I’ll check the eval state.'),
    tool(entry('call:run1')),
    say('All 70 cells are done.'),
    event({ type: 'done', summary: 'Done.', elapsed_ms: 1_602_000, apps: [], source_count: 0 }),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  const turn = only(done.turns[0]);
  const layout = layoutTurn(turn);
  expect(layout.answer).toBe('All 70 cells are done.');
  expect(layout.log.map((item) => item.type)).toEqual(['message', 'work']);
  const html = renderToStaticMarkup(
    <WorkLog turn={turn} now={0} items={layout.log} finished renderBlock={() => null} />,
  );
  expect(html).toContain('Worked for 26m 42s');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('I’ll check the eval state.');
});

test('while the turn runs the log is open, with every message and the work under way', () => {
  const running = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say('I’ll check the eval state.'),
    tool(
      entry('call:run1', {
        status: 'running',
        ended_at: null,
        title: 'Running `python3 progress.py`',
      }),
    ),
  ]);
  const turn = only(running.turns[0]);
  const layout = layoutTurn(turn);
  expect(layout.answer).toBe('');
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(at(12))}
      items={layout.log}
      finished={false}
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('Working for 12s');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('I’ll check the eval state.');
  expect(html).toContain('Running <code class="log-code">python3 progress.py</code>');
  expect(html).toContain('class="spin"');
});

test('reasoning is never drawn, open or folded', () => {
  const turn = worked();
  const layout = layoutTurn(turn);
  const html = renderToStaticMarkup(
    <WorkLog turn={turn} now={0} items={layout.log} finished={false} renderBlock={() => null} />,
  );
  expect(html).not.toContain('Check the state file first.');
  expect(html).not.toContain('Now the failing watch case.');
  expect(html).not.toContain('Thinking');
});

test('a reload of a finished turn still has its messages in order, the answer last', () => {
  const saved: Turn = { ...TURN, status: 'done', answer: 'All 70 cells are done.' };
  const transcript = applyHistory(fromTurns([saved], 'send', 'done'), [
    say('I’ll check the eval state.'),
    tool(entry('call:run1')),
    say('All 70 cells are done.'),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  const layout = layoutTurn(only(transcript.turns[0]));
  expect(layout.log.map((item) => (item.type === 'message' ? item.text : item.type))).toEqual([
    'I’ll check the eval state.',
    'work',
  ]);
  expect(layout.answer).toBe('All 70 cells are done.');
});

test('a retried attempt replaces what the lost one said', () => {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say('Half a sent'),
    tool(entry('call:run1')),
    event({ type: 'text_delta', text: 'Fresh start.', restart: true }),
  ]);
  const items = logItems(only(transcript.turns[0]));
  expect(
    items
      .filter((item) => item.type === 'message')
      .map((item) => item.type === 'message' && item.text),
  ).toEqual(['Fresh start.']);
});

test('worked-for reads like a clock', () => {
  expect(workedFor(0)).toBe('0s');
  expect(workedFor(45.4)).toBe('45s');
  expect(workedFor(60)).toBe('1m');
  expect(workedFor(1602)).toBe('26m 42s');
  expect(workedFor(3900)).toBe('1h 5m');
  expect(workedFor(7200)).toBe('2h');
});

test('a command opens onto its shell: the command, the output, and how it ended', () => {
  const html = renderToStaticMarkup(
    <ShellBlock
      tool={entry('call:run', {
        input_excerpt: { text: 'python3 progress.py', from: 'request', more: false },
        output_excerpt: { text: '{"completed": 81} <b>raw</b>', from: 'app', more: false },
      })}
      live={false}
    />,
  );
  expect(html).toContain('>Shell<');
  expect(html).toContain('python3 progress.py');
  expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
  expect(html).toContain('Success');
  const failed = renderToStaticMarkup(
    <ShellBlock
      tool={entry('call:f', { status: 'failed', output_summary: { text: 'Exit code 1' } })}
      live={false}
    />,
  );
  expect(failed).toContain('Failed · Exit code 1');
  const running = renderToStaticMarkup(
    <ShellBlock tool={entry('call:r', { status: 'running', ended_at: null })} live />,
  );
  expect(running).toContain('Running…');
  expect(running).toContain('class="spin"');
});

test('a group opens onto each row; a read opens onto what came back, never as markup', () => {
  const work: Work[] = [
    {
      type: 'tool',
      tool: entry('a', {
        kind: 'file',
        title: 'Read a.ts',
        output_excerpt: { text: '<i>x</i>', from: 'file', more: false },
      }),
    },
    { type: 'tool', tool: entry('b') },
  ];
  const closed = renderToStaticMarkup(<WorkGroup work={work} live={false} />);
  expect(closed).toContain('Read a file, ran a command');
  expect(closed).not.toContain('Read a.ts');
  const open = renderToStaticMarkup(<WorkGroup work={work} live={false} initiallyOpen />);
  expect(open).toContain('Read a.ts');
  const read = renderToStaticMarkup(<WorkLine work={only(work[0])} live={false} initiallyOpen />);
  expect(read).toContain('&lt;i&gt;x&lt;/i&gt;');
});

test('an edit with a diff is a card with its counts and a way to see the changes, and no undo', () => {
  const edit = entry('call:e', {
    kind: 'file',
    title: 'Edited EVALS.md',
    output_excerpt: { text: DIFF, from: 'file', more: false },
  });
  const diff = only(editOf(edit) ?? undefined);
  expect(diff.added).toBe(2);
  expect(diff.removed).toBe(2);
  const html = renderToStaticMarkup(<EditCard tool={edit} diff={diff} />);
  expect(html).toContain('Edited EVALS.md');
  expect(html).toContain('+2');
  expect(html).toContain('−2');
  expect(html).toContain('View changes');
  expect(html).not.toContain('Undo');
  expect(readDiff('just words')).toBeNull();
  expect(editOf(entry('call:w', { kind: 'file', title: 'Edited a.md' }))).toBeNull();
});

test('a long chat folds its oldest turns, never one still waiting on the person', () => {
  const turns = Array.from({ length: 12 }, (_, index) => ({
    ...fromTurns([{ ...TURN, id: `t${index}`, status: 'done', answer: 'Done.' }], 'send', 'done')
      .turns[0],
  })) as TranscriptTurn[];
  expect(foldedTurns(turns)).toEqual({ count: 6, messages: 12 });
  expect(foldedTurns(turns.slice(0, 5)).count).toBe(0);
  const waiting = turns.map((turn, index) =>
    index === 2
      ? {
          ...turn,
          blocks: [
            {
              type: 'question' as const,
              question: {
                id: 'q',
                conversation_id: 'job_1',
                text: 'Now?',
                why: [],
                if_ignored: '',
                free_text: false,
                options: [],
                created_at: AT,
              },
              answered: null,
            },
          ],
        }
      : turn,
  ) as TranscriptTurn[];
  expect(foldedTurns(waiting).count).toBe(2);
});

test('a long message folds under "Show more"', () => {
  expect(longMessage('short')).toBe(false);
  expect(longMessage('x'.repeat(700))).toBe(true);
  expect(longMessage(Array.from({ length: 12 }, () => 'line').join('\n'))).toBe(true);
});
