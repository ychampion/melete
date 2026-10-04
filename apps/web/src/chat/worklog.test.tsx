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
import { EditCard, ShellBlock, SourcesLine, WorkGroup, WorkLine, WorkLog } from './WorkLog.tsx';
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
  expect(html).toContain('Worked for 26m 42s · ran a command');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('inert=""');
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
  // Inline in the conversation: no summary line over it, nothing folded.
  expect(html).not.toContain('worklog-head');
  expect(html).toMatch(
    /class="worklog" data-state="live"><div id="[^"]+" class="reveal" data-open="true">/,
  );
  expect(html).toContain('I’ll check the eval state.');
  expect(html).toContain('Running <code class="log-code">python3 progress.py</code>');
  // Motion, not a spinner or a box: the live words shimmer.
  expect(html).toContain('class="shimmer-text"');
  expect(html).not.toContain('class="spin"');
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
  expect(running).toContain('class="shimmer-text"');
  expect(running).not.toContain('class="spin"');
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
  expect(foldedTurns(turns)).toEqual({ count: 6, messages: 12, summarised: 0 });
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

/** A page a search found, as the service sends it: a link and nothing to act on. */
const page = (n: number, url: string, title: string) => ({
  id: `act_${n}:0`,
  title,
  meta: 'Web',
  facts: [],
  primary_action: { kind: 'open' as const, label: 'Open', handle: `act_${n}:0`, url },
  secondary_actions: [],
  source_connection: 'conn_web',
});

test('the last word of a message drawn after a tool row joins its message', () => {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say("I'll check the current date and look up Bun's latest"),
    tool(entry('call:date', { title: 'Ran `date`' })),
    say(' release.'),
    tool(entry('call:search', { kind: 'web', title: 'Searched the web for “Bun release”' })),
    say('Bun 1.4.2 is the latest.'),
  ]);
  const items = logItems(only(transcript.turns[0]));
  expect(items.map((item) => item.type)).toEqual(['message', 'work', 'message']);
  expect(items[0]).toMatchObject({
    text: "I'll check the current date and look up Bun's latest release.",
  });
  expect(items[1]).toMatchObject({
    work: [{ tool: { id: 'call:date' } }, { tool: { id: 'call:search' } }],
  });
  // A message that ended is never joined, whatever the next one starts with.
  const ended = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say('I checked the date.'),
    tool(entry('call:date')),
    say('then'),
  ]);
  expect(logItems(only(ended.turns[0])).map((item) => item.type)).toEqual([
    'message',
    'work',
    'message',
  ]);
});

test('the pages a search found are one quiet row of links, not a card each', () => {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('call:search', { kind: 'web', title: 'Searched the web for “Bun release”' })),
    event({ type: 'card', card: page(1, 'https://github.com/oven-sh/bun/releases', 'Releases') }),
    event({ type: 'card', card: page(2, 'https://www.bun.com/blog/bun-v1.4', 'Bun 1.4') }),
    event({ type: 'card', card: page(3, 'https://npmjs.com/package/bun', 'bun - npm') }),
    event({ type: 'card', card: page(4, 'https://api.github.com/repos/x', 'api.github.com') }),
  ]);
  const items = logItems(only(transcript.turns[0]));
  expect(items.map((item) => item.type)).toEqual(['work', 'sources']);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={only(transcript.turns[0])}
      now={0}
      items={items}
      finished={false}
      renderBlock={() => 'CARD'}
    />,
  );
  expect(html).toContain('4 sources');
  expect(html).toContain('github.com, bun.com, npmjs.com +1');
  expect(html).not.toContain('CARD');
  const sources = only(items[1]);
  if (sources.type !== 'sources') throw new Error('not sources');
  const opened = renderToStaticMarkup(<SourcesLine cards={sources.cards} initiallyOpen />);
  expect(opened).toContain('href="https://www.bun.com/blog/bun-v1.4"');
  expect(opened).toContain('Releases');
});

test('the pages a search found are named once, not again by the grouped work after them', () => {
  const pageSource = (url: string, title: string) => ({
    app: 'Web',
    title,
    kind: 'page' as const,
    connection_id: 'conn_web',
    url,
  });
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('call:search', { kind: 'web', title: 'Searched the web for “SF weather”' })),
    event({ type: 'card', card: page(1, 'https://weather.com/sf', 'SF Weather | weather.com') }),
    event({ type: 'card', card: page(2, 'https://www.accuweather.com/sf', 'SF | AccuWeather') }),
    tool(entry('call:date', { title: 'Ran `date`' })),
    event({
      type: 'action',
      label: 'Searched the web, Ran a command',
      meta: '2 sources',
      sources: [
        pageSource('https://weather.com/sf', 'SF Weather | weather.com'),
        pageSource('https://www.accuweather.com/sf', 'SF | AccuWeather'),
      ],
    }),
  ]);
  const turn = only(transcript.turns[0]);
  const items = logItems(turn);
  expect(items.map((item) => item.type)).toEqual(['work', 'sources', 'work']);
  // The work after the sources is the command alone: the group repeats it and the pages.
  const after = only(items[2]);
  if (after.type !== 'work') throw new Error('not work');
  expect(after.work).toEqual([
    { type: 'tool', tool: expect.objectContaining({ id: 'call:date' }) },
  ]);
  const html = renderToStaticMarkup(
    <WorkLog turn={turn} now={0} items={items} finished={false} renderBlock={() => 'CARD'} />,
  );
  expect(html).toContain('2 sources');
  expect(html).not.toContain('Searched the web, Ran a command');
  expect(html).not.toContain('used an app');
  const sources = only(items[1]);
  if (sources.type !== 'sources') throw new Error('not sources');
  const opened = renderToStaticMarkup(<SourcesLine cards={sources.cards} initiallyOpen />);
  expect(opened).toContain('href="https://www.accuweather.com/sf"');
  expect(opened).toContain('SF | AccuWeather');

  // Grouped work whose sources no card shows still tells them.
  const unseen = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('call:cal', { kind: 'connector', title: 'Looked at your calendar' })),
    event({
      type: 'action',
      label: 'Looked at your calendar',
      meta: '1 source',
      sources: [{ app: 'Calendar', title: 'Standup', kind: 'event', connection_id: 'conn_cal' }],
    }),
  ]);
  expect(only(logItems(only(unseen.turns[0]))[0])).toMatchObject({
    type: 'work',
    work: [{ type: 'tool' }, { type: 'group' }],
  });
});

test('a question that repeats the message before it is told once', () => {
  const words =
    'This conversation looks like it is about personal finances. There is no local model set up.';
  const question = {
    id: 'q_privacy',
    conversation_id: 'job_1',
    text: words,
    why: [],
    if_ignored: 'Nothing is sent to a cloud model until you answer.',
    free_text: false,
    options: [],
    created_at: AT,
  };
  const waiting = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say(words),
    event({ type: 'question', question }),
    event({ type: 'status', status: 'needs_you', composer: 'send' }),
  ]);
  const turn = only(waiting.turns[0]);
  expect(layoutTurn(turn).log.map((item) => item.type)).toEqual(['block']);
  // Saved as the answer too, it is still told once.
  const saved = { ...turn, status: 'done' as const, turn: { ...turn.turn, answer: words } };
  expect(layoutTurn(saved).answer).toBe('');
});

test('a search held back is its own quiet row and is counted as held back', () => {
  const held = entry('held-search:1', {
    kind: 'web',
    title: 'Search held back: it named something private',
    output_summary: { text: 'Nothing was sent to a search service.' },
  });
  expect(summarize([{ type: 'tool', tool: held }])).toBe('Held back a search');
  const html = renderToStaticMarkup(<WorkLine work={{ type: 'tool', tool: held }} live={false} />);
  expect(html).toContain('Search held back: it named something private');
  expect(html).not.toContain('Didn’t work');
});
