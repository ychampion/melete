/**
 * A turn's activity: tool entries become rows as they start and finish in
 * place, out-of-order copies never take a finished row back, and a failure
 * says it did not work.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyEvent, applyEvents, fromTurns, newerTool } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { ExperienceEvent, Turn } from '../experience/types.ts';
import { WorkGroup, WorkLine, WorkLog } from './WorkLog.tsx';
import { layoutTurn } from './worklog.ts';

const AT = '2026-10-01T09:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Find this month’s rent prices, make a report and mail it to Sam.',
  answer: '',
  status: 'working',
  delivery: null,
  created_at: AT,
};

let seq = 0;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});
const entry = (id: string, patch: Partial<ToolEntry>): ToolEntry => ({
  id,
  kind: 'web',
  title: 'Searching the web for “rent Lisbon”',
  status: 'running',
  started_at: at(0),
  ended_at: null,
  input_summary: null,
  output_summary: null,
  detail: null,
  parent: null,
  ...patch,
});
const tool = (t: ToolEntry) => event({ type: 'tool', tool: t });
const finishedStep = (t: ToolEntry) =>
  event({ type: 'action', label: t.title, meta: '', sources: [], tool: t });
const only = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing');
  return value;
};

test('a row appears when work starts and finishes in place, once', () => {
  const search = entry('call:a:1', {});
  const searched = entry('call:a:1', {
    title: 'Searched the web for “rent Lisbon”',
    status: 'done',
    ended_at: at(2),
  });
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvent(transcript, tool(search));
  const live = only(transcript.turns[0]);
  expect(live.trail).toHaveLength(1);
  expect(live.live?.title).toBe('Searching the web for “rent Lisbon”');
  transcript = applyEvents(transcript, [tool(searched), finishedStep(searched)]);
  const turn = only(transcript.turns[0]);
  expect(turn.trail).toHaveLength(1);
  expect(turn.trail[0]).toMatchObject({ type: 'action', tool: { status: 'done' } });
  expect(turn.live).toBeNull();
});

test('rows keep the order work started in, with reasoning between them', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvents(transcript, [
    event({ type: 'reasoning', text: 'Search first. ' }),
    tool(entry('call:a:1', {})),
    event({ type: 'reasoning', text: 'Now read the best two.' }),
    tool(entry('action:act_2', { title: 'Reading page idealista.pt/rent' })),
    tool(entry('call:a:1', { status: 'done', ended_at: at(1), title: 'Searched' })),
  ]);
  const kinds = only(transcript.turns[0]).trail.map((step) =>
    step.type === 'action' ? step.tool?.id : step.type,
  );
  expect(kinds).toEqual(['reasoning', 'call:a:1', 'reasoning', 'action:act_2']);
});

test('a copy read again after the finished one never takes the row back', () => {
  const done = entry('action:act_1', { status: 'done', ended_at: at(3), title: 'Read page x' });
  const running = entry('action:act_1', { title: 'Reading page x' });
  expect(newerTool(done, running)).toBe(done);
  expect(newerTool(running, done)).toBe(done);
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvents(transcript, [tool(done), tool(running)]);
  expect(only(transcript.turns[0]).trail[0]).toMatchObject({ tool: { status: 'done' } });
});

test('an approval waits on its row, then the row finishes when the person decides', () => {
  const waiting = entry('action:act_9', {
    kind: 'connector',
    title: 'Proposed sending an email to sam@example.com — waiting for you',
    status: 'needs_approval',
    detail: { type: 'permission', id: 'apr_1' },
    output_summary: { text: 'Waiting for your OK' },
  });
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvent(transcript, tool(waiting));
  expect(transcript.approvals['action:act_9']).toBe('apr_1');
  const waitingTurn = only(transcript.turns[0]);
  const html = renderToStaticMarkup(
    <WorkLog
      turn={waitingTurn}
      now={Date.parse(at(5))}
      items={layoutTurn(waitingTurn).log}
      finished={false}
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('>Waiting for you<');
  transcript = applyEvent(
    transcript,
    tool({
      ...waiting,
      status: 'failed',
      failure: 'declined',
      title: 'Sending an email to sam@example.com',
      ended_at: at(9),
      output_summary: { text: 'You declined this.' },
      detail: null,
    }),
  );
  expect(transcript.approvals['action:act_9']).toBeUndefined();
  expect(only(transcript.turns[0]).trail).toHaveLength(1);
});

test('the model and scheduled retries are not rows; a wait for your computer is', () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  transcript = applyEvents(transcript, [
    tool(entry('model:bl_1', { kind: 'model', title: 'Thinking' })),
    tool(entry('retry:x', { kind: 'retry', title: 'Scheduled another try', status: 'done' })),
    tool(entry('wait:y', { kind: 'retry', title: 'Waiting for Laptop', status: 'done' })),
  ]);
  const ids = only(transcript.turns[0]).trail.map((step) =>
    step.type === 'action' ? step.tool?.id : step.type,
  );
  expect(ids).toEqual(['wait:y']);
});

const runOf = () => {
  let transcript = fromTurns([TURN], 'pause', 'working');
  const rows: ToolEntry[] = [
    entry('call:a:1', {
      title: 'Searched the web for “rent Lisbon”',
      status: 'done',
      ended_at: at(2),
    }),
    entry('action:a2', {
      title: 'Read page idealista.pt/rent',
      status: 'done',
      started_at: at(2),
      ended_at: at(3),
      detail: { type: 'page', id: 'a2', url: 'https://idealista.pt/rent' },
      output_summary: { text: 'Page read', quote: { text: 'Rent in Lisbon', from: 'page' } },
    }),
    entry('action:a3', {
      title: 'Reading page example.org/blocked',
      status: 'failed',
      failure: 'error',
      started_at: at(3),
      ended_at: at(4),
      output_summary: { text: 'This did not go through.' },
    }),
    entry('action:a4', {
      kind: 'sandbox',
      title: 'Ran `python report.py` in its computer',
      status: 'done',
      started_at: at(4),
      ended_at: at(9),
      input_excerpt: { text: 'python report.py', from: 'request', more: false },
      output_excerpt: {
        text: Array.from({ length: 12 }, (_, i) => `row ${i} <b>ok</b>`).join('\n'),
        from: 'app',
        more: false,
      },
      output_summary: { text: 'Finished', quote: { text: 'row 0', from: 'app' } },
    }),
    entry('action:a5', {
      kind: 'file',
      title: 'Wrote report.md (2 KB)',
      status: 'done',
      started_at: at(9),
      ended_at: at(10),
      detail: { type: 'artifact', id: 'art_1' },
    }),
  ];
  transcript = applyEvents(transcript, [
    event({ type: 'reasoning', text: 'Search, read, run, write.' }),
    ...rows.map(tool),
    event({ type: 'done', summary: 'Sent.', elapsed_ms: 12_000, apps: [], source_count: 0 }),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  return { turn: only(transcript.turns[0]), rows };
};

test('a finished run folds to how long it worked', () => {
  const { turn } = runOf();
  const html = renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(at(20))}
      items={layoutTurn(turn).log}
      finished
      renderBlock={() => null}
    />,
  );
  expect(html).toContain('Worked for 12s');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Read page idealista.pt/rent');
});

test('opened, the work says what it was, and a failure says it did not work', () => {
  const { rows } = runOf();
  const work = rows.map((tool) => ({ type: 'tool' as const, tool }));
  const html = renderToStaticMarkup(<WorkGroup work={work} live={false} initiallyOpen />);
  expect(html).toContain('Searched the web, read pages, ran a command, edited a file');
  expect(html).toContain('Searched the web for “rent Lisbon”');
  expect(html).toContain('Ran <code class="log-code">python report.py</code> in its computer');
  expect(html).toContain('1 didn’t work');
  expect(html).toContain('Didn’t work');
  expect(html).not.toContain('Search, read, run, write.');
});

test('an opened row shows its output as plain monospace text', () => {
  const { rows } = runOf();
  const html = renderToStaticMarkup(
    <WorkLine work={{ type: 'tool', tool: only(rows[3]) }} live={false} initiallyOpen />,
  );
  expect(html).toContain('class="log-shell-pre"');
  expect(html).toContain('python report.py');
  expect(html).toContain('row 11');
  // Outside text is never markup.
  expect(html).toContain('&lt;b&gt;ok&lt;/b&gt;');
  const page = renderToStaticMarkup(
    <WorkLine work={{ type: 'tool', tool: only(rows[1]) }} live={false} initiallyOpen />,
  );
  expect(page).toContain('href="https://idealista.pt/rent"');
  expect(page).toContain('rel="noopener noreferrer"');
  const file = renderToStaticMarkup(
    <WorkLine work={{ type: 'tool', tool: only(rows[4]) }} live={false} initiallyOpen />,
  );
  expect(file).toContain('Download the file');
});

test('a running row shimmers while the turn runs', () => {
  const running = entry('call:a:1', {});
  const html = renderToStaticMarkup(<WorkLine work={{ type: 'tool', tool: running }} live />);
  expect(html).toContain('class="shimmer-text"');
  expect(html).toContain('Searching the web for “rent Lisbon”');
});
