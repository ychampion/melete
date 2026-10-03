/**
 * How a turn folds and unfolds: open while it runs, one summary line once it
 * ends, three levels below that (messages and grouped rows, each piece of
 * work, its detail), decisions never folded away, motion that holds still for
 * a person who asked for less, and a summarised earlier part of a long chat
 * shown as a quiet line rather than set out.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyEvents, fromTurns, type TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import {
  EarlierMessages,
  logOpen,
  Reveal,
  readReducedMotion,
  summaryLine,
  WorkGroup,
  WorkLine,
  WorkLog,
} from './WorkLog.tsx';
import {
  countWork,
  foldedTurns,
  type LogItem,
  layoutTurn,
  summarisedBefore,
  type Work,
} from './worklog.ts';

const AT = '2026-10-01T09:00:00.000Z';
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
  started_at: AT,
  ended_at: AT,
  input_summary: null,
  output_summary: null,
  detail: null,
  parent: null,
  ...patch,
});
const read = (id: string) => entry(id, { kind: 'file', title: `Read ${id}.md` });
const page = (id: string) => entry(id, { kind: 'web', title: `Read the page ${id}` });
const only = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing');
  return value;
};
const QUESTION = {
  id: 'q_run',
  conversation_id: 'job_1',
  text: 'Run the second repetition now?',
  why: [],
  if_ignored: '',
  free_text: false,
  options: [],
  created_at: AT,
};

/** A finished turn: commands, reads and pages between messages, then the answer. */
function finished(extra: () => ExperienceEvent[] = () => []): TranscriptTurn {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    event({ type: 'text_delta', text: 'I’ll check the eval state.' }),
    ...['a', 'b', 'c'].map((id) => event({ type: 'tool', tool: read(id) })),
    ...[1, 2, 3, 4, 5, 6].map((n) => event({ type: 'tool', tool: entry(`run${n}`) })),
    event({ type: 'text_delta', text: '' }),
    ...extra(),
    ...['x', 'y', 'z'].map((id) => event({ type: 'tool', tool: page(id) })),
    event({ type: 'text_delta', text: 'All 70 cells are done.' }),
    event({ type: 'done', summary: 'Done.', elapsed_ms: 252_000, apps: [], source_count: 0 }),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  return only(transcript.turns[0]);
}

const restoreMatchMedia = globalThis.matchMedia;
afterEach(() => {
  globalThis.matchMedia = restoreMatchMedia;
});

test('the summary line counts what the whole turn did, each kind once, in the order it did them', () => {
  const turn = finished();
  const layout = layoutTurn(turn);
  expect(countWork(layout.log)).toBe('read 3 files, ran 6 commands, read 3 pages');
  expect(summaryLine(turn, 0, layout.log)).toBe(
    'Worked for 4m 12s · read 3 files, ran 6 commands, read 3 pages',
  );
  const one: LogItem[] = [{ type: 'work', key: 'w', work: [{ type: 'tool', tool: entry('r') }] }];
  expect(countWork(one)).toBe('ran a command');
  // Beyond three kinds the line stops; the log holds the rest.
  const many: LogItem[] = [
    {
      type: 'work',
      key: 'w',
      work: [
        entry('1'),
        read('2'),
        page('3'),
        entry('4', { kind: 'web', title: 'Searched the web for “x”' }),
      ].map((tool): Work => ({ type: 'tool', tool })),
    },
  ];
  expect(countWork(many)).toBe('ran a command, read a file, read a page');
  expect(countWork([])).toBe('');
});

test('a log is open while the turn runs and folded once it ends, until the person opens it', () => {
  expect(logOpen(false, null)).toBe(true);
  expect(logOpen(false, false)).toBe(true);
  expect(logOpen(true, null)).toBe(false);
  expect(logOpen(true, true)).toBe(true);
  expect(logOpen(true, false)).toBe(false);
});

test('folded, a finished turn is one line with the arrow; its log is drawn but not reachable', () => {
  const turn = finished();
  const layout = layoutTurn(turn);
  const html = renderToStaticMarkup(
    <WorkLog turn={turn} now={0} items={layout.log} finished renderBlock={() => null} />,
  );
  expect(html).toContain('class="worklog-head" aria-expanded="false"');
  expect(html).toContain('Worked for 4m 12s · read 3 files, ran 6 commands, read 3 pages');
  expect(html).toContain('data-open="false"');
  expect(html).toContain('inert=""');
  expect(html).not.toContain('I’ll check the eval state.');
});

test('drill-down: a group opens onto its rows, a command onto its command, output and exit', () => {
  const work: Work[] = [1, 2, 3].map((n) => ({
    type: 'tool',
    tool: entry(`run${n}`, {
      title: `Ran \`step ${n}\``,
      input_excerpt: { text: `step ${n}`, from: 'request', more: false },
      output_excerpt: { text: `out ${n}`, from: 'app', more: false },
    }),
  }));
  // Level two, folded: one row that says what the work was.
  const closed = renderToStaticMarkup(<WorkGroup work={work} live={false} />);
  expect(closed).toContain('Ran commands');
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain('step 2');
  // Level three: the list of commands, each still folded.
  const rows = renderToStaticMarkup(<WorkGroup work={work} live={false} initiallyOpen />);
  expect(rows).toContain('Ran <code class="log-code">step 1</code>');
  expect(rows).toContain('Ran <code class="log-code">step 3</code>');
  expect(rows).not.toContain('out 2');
  // Level four: one command's detail.
  const detail = renderToStaticMarkup(<WorkLine work={only(work[1])} live={false} initiallyOpen />);
  expect(detail).toContain('aria-expanded="true"');
  expect(detail).toContain('step 2');
  expect(detail).toContain('out 2');
  expect(detail).toContain('Success');
  expect(detail).toContain('data-open="true"');
  // A read and a web search drill down the same way.
  const search = renderToStaticMarkup(
    <WorkLine
      work={{
        type: 'tool',
        tool: entry('s', {
          kind: 'web',
          title: 'Searched the web for “durable waits”',
          output_excerpt: { text: 'Durable timers', from: 'page', more: false },
        }),
      }}
      live={false}
      initiallyOpen
    />,
  );
  expect(search).toContain('Durable timers');
});

test('a decision waiting on the person stays in view when the turn folds, and is drawn once', () => {
  const turn = finished(() => [event({ type: 'question', question: QUESTION })]);
  const layout = layoutTurn(turn);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={0}
      items={layout.log}
      finished
      renderBlock={(block) => <div data-decision="yes">{block.type}</div>}
    />,
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html.match(/data-decision/g)?.length).toBe(1);
  // It sits under the summary line, outside the folded log.
  const kept = html.slice(html.indexOf('worklog-kept'));
  expect(kept).toContain('data-decision');
});

test('reduced motion: a reveal opens at once, and the styles hold every animation still', () => {
  const query = (matches: boolean) =>
    ((media: string) => ({
      matches,
      media,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof globalThis.matchMedia;
  globalThis.matchMedia = query(true);
  expect(readReducedMotion()).toBe(true);
  expect(renderToStaticMarkup(<Reveal open>x</Reveal>)).toContain('data-motion="off"');
  globalThis.matchMedia = query(false);
  expect(readReducedMotion()).toBe(false);
  expect(renderToStaticMarkup(<Reveal open>x</Reveal>)).not.toContain('data-motion');
  const css = readFileSync(join(import.meta.dir, 'chat.css'), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .reveal'));
  expect(reduced).toContain('.reveal');
  expect(reduced).toContain('.shimmer-text');
  expect(reduced).toContain('animation: none');
  expect(reduced).toContain('transition: none');
});

test('a summarised earlier part folds behind a quiet line that opens, never the summary itself', () => {
  const turns = Array.from({ length: 5 }, (_, index) => ({
    ...TURN,
    id: `t${index}`,
    status: 'done' as const,
    answer: 'Done.',
  }));
  const transcript = applyEvents(fromTurns(turns, 'send', 'done'), [
    event({ type: 'compacted' }, 't3'),
  ]);
  expect(transcript.turns[3]?.compacted).toBe(true);
  expect(summarisedBefore(transcript.turns)).toBe(3);
  expect(foldedTurns(transcript.turns)).toEqual({ count: 3, messages: 6, summarised: 3 });
  const closed = renderToStaticMarkup(
    <EarlierMessages summarised messages={6} open={false} onToggle={() => {}} />,
  );
  expect(closed).toContain('Earlier messages summarised · 6 messages');
  expect(closed).toContain('aria-expanded="false"');
  const open = renderToStaticMarkup(
    <EarlierMessages summarised messages={6} open onToggle={() => {}} />,
  );
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('>Earlier messages summarised<');
  // A long chat with nothing summarised keeps its plain fold.
  expect(
    renderToStaticMarkup(
      <EarlierMessages summarised={false} messages={4} open={false} onToggle={() => {}} />,
    ),
  ).toContain('4 previous messages');
  // A summary before the first turn leaves nothing to fold.
  const first = applyEvents(fromTurns(turns, 'send', 'done'), [event({ type: 'compacted' }, 't0')]);
  expect(foldedTurns(first.turns).count).toBe(0);
});
