/**
 * The agent's computer inside the conversation: a picture under the turn's
 * browser work that follows it while the turn is at work and keeps its last
 * frame once it ends, and the line over the composer that says what the agent
 * is doing there, with Stop and Take over.
 */
import { expect, test } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Result } from '../experience/adapter.ts';
import { applyEvents, fromTurns, type TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type {
  AgentComputer,
  CardAction,
  ExperienceEvent,
  SandboxComputer,
  Turn,
} from '../experience/types.ts';
import { keepFrame, LiveCardView } from './LiveBrowserCard.tsx';
import {
  cardHost,
  computerTools,
  createRefresher,
  isComputerTool,
  takeOverAction,
  workStep,
} from './live-card.ts';
import { WorkLog } from './WorkLog.tsx';
import { WorkPill } from './WorkPill.tsx';
import { layoutTurn, logItems } from './worklog.ts';

const AT = '2026-10-11T09:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Pick two seats together on tomorrow’s flight',
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
const entry = (id: string, patch: Partial<ToolEntry> = {}): ToolEntry => ({
  id,
  kind: 'browser',
  title: 'Opened flights.example in the browser',
  status: 'done',
  started_at: AT,
  ended_at: AT,
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

/** A turn choosing seats in the agent's browser, still at work on the newest step. */
function browsing(extra: () => ExperienceEvent[] = () => []): TranscriptTurn {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    say('Opening the airline’s site to choose your seats.'),
    tool(entry('call:open')),
    tool(
      entry('call:seat', {
        title: 'Choosing seats on flights.example',
        status: 'running',
        ended_at: null,
      }),
    ),
    ...extra(),
  ]);
  return only(transcript.turns[0]);
}

const ended = (): TranscriptTurn =>
  browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B' })),
    say('Seats 14A and 14B are yours.'),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);

const OPEN = { agentName: 'Nova', open: () => {} };
const renderLog = (turn: TranscriptTurn, computer: typeof OPEN | null = OPEN) => {
  const layout = layoutTurn(turn);
  return renderToStaticMarkup(
    <WorkLog
      turn={turn}
      now={Date.parse(AT)}
      items={layout.log}
      finished={layout.finished}
      renderBlock={() => null}
      computer={computer ?? undefined}
    />,
  );
};

/** Every element in a tree drawn without a screen, so its buttons can be pressed. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
const button = (node: ReactNode, label: RegExp) => {
  const found = elements(node).find(
    (element) => element.type === 'button' && label.test(String(element.props['aria-label'])),
  );
  if (!found) throw new Error(`no button ${label}`);
  return found.props.onClick as () => void;
};

/* ---------- the picture in the turn ---------- */

test('browser and desktop work is the computer’s; commands and the person’s own browser are not', () => {
  expect(isComputerTool(entry('a'))).toBe(true);
  expect(isComputerTool(entry('b', { kind: 'sandbox', title: 'Clicked in its computer' }))).toBe(
    true,
  );
  expect(isComputerTool(entry('c', { kind: 'sandbox', title: 'Ran `bun test`' }))).toBe(false);
  expect(
    isComputerTool(entry('d', { kind: 'sandbox', title: 'Ran Python code in its computer' })),
  ).toBe(false);
  expect(isComputerTool(entry('e', { title: 'Opened example.com in your browser' }))).toBe(false);
  expect(isComputerTool(entry('f', { kind: 'web', title: 'Read page example.com' }))).toBe(false);
});

test('during a computer turn the live picture sits under that turn’s browser rows, once', () => {
  const turn = browsing();
  const html = renderLog(turn);
  expect(html.match(/class="live-card"/g)?.length).toBe(1);
  expect(html).toContain('data-live="true"');
  expect(html).toContain('Nova’s browser, live. Open the computer to watch or take over.');
  // After the browser rows, not before them.
  expect(html.indexOf('live-card')).toBeGreaterThan(html.indexOf('Choosing seats'));
  expect(cardHost(logItems(turn))).toBe('work-call:open');
});

test('only the last group of computer work in a turn carries the picture', () => {
  const turn = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B' })),
    say('Now the luggage.'),
    tool(entry('call:bags', { title: 'Adding a bag on flights.example', status: 'running' })),
  ]);
  expect(cardHost(logItems(turn))).toBe('work-call:bags');
  expect(renderLog(turn).match(/class="live-card"/g)?.length).toBe(1);
});

test('a turn with no browser or desktop work has no picture, nor does a log not given the computer', () => {
  const commands = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('call:run', { kind: 'sandbox', title: 'Ran `bun test`' })),
  ]);
  expect(renderLog(only(commands.turns[0]))).not.toContain('live-card');
  expect(renderLog(browsing(), null)).not.toContain('live-card');
});

test('when the turn ends the picture stays in view, frozen on its last frame', () => {
  const turn = ended();
  keepFrame(turn.id, {
    src: 'http://localhost:3210/artifacts/art_last/content',
    url: 'https://flights.example/seats',
    title: 'Choose your seats',
  });
  const html = renderLog(turn);
  // The log folds, and the picture is kept under its summary line.
  expect(html).toContain('data-state="closed"');
  expect(html).toContain('worklog-kept');
  expect(html).toContain('/artifacts/art_last/content');
  expect(html).not.toContain('data-live');
  expect(html).not.toContain('>Live<');
  expect(html).toContain('Nova’s browser when the work ended, on flights.example/seats.');
});

test('on the desktop, the newest screenshot the work took is the picture', () => {
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(
      entry('call:shot', {
        kind: 'sandbox',
        title: 'Took a screenshot of its computer',
        detail: { type: 'screenshot', id: 'act_shot' },
      }),
    ),
    tool(entry('call:click', { kind: 'sandbox', title: 'Clicking in its computer' })),
  ]);
  const html = renderLog(only(transcript.turns[0]));
  expect(html).toContain('/screenshots/act_shot');
  expect(html).toContain('Nova’s computer, live.');
});

test('tapping the picture opens the computer, live or ended', () => {
  for (const live of [true, false]) {
    let opened = 0;
    const view = LiveCardView({
      src: null,
      live,
      surface: 'browser',
      address: '',
      agentName: 'Nova',
      onOpen: () => {
        opened += 1;
      },
    });
    button(view, /Nova’s browser/)();
    expect(opened).toBe(1);
  }
});

/* ---------- when the picture is read ---------- */

test('the picture is read once per change on the stream while live and in view', () => {
  let reads = 0;
  const refresh = createRefresher(() => {
    reads += 1;
  });
  const state = { live: true, onScreen: true, tabVisible: true, pulse: 'working:2:dr' };
  expect(refresh(state)).toBe(true);
  // The same moment on the stream reads nothing again: there is no timer.
  expect(refresh(state)).toBe(false);
  expect(refresh({ ...state, pulse: 'working:3:ddr' })).toBe(true);
  expect(reads).toBe(2);
});

test('nothing is read while the picture is off screen, the tab is hidden, or the turn has ended', () => {
  let reads = 0;
  const refresh = createRefresher(() => {
    reads += 1;
  });
  const state = { live: true, onScreen: false, tabVisible: true, pulse: 'working:2:dr' };
  expect(refresh(state)).toBe(false);
  expect(refresh({ ...state, pulse: 'working:3:dd', onScreen: true, tabVisible: false })).toBe(
    false,
  );
  expect(refresh({ ...state, pulse: 'done:4:ddd', onScreen: true, live: false })).toBe(false);
  expect(reads).toBe(0);
  // Back on screen while still at work, the changes it missed are read once.
  expect(refresh({ ...state, pulse: 'working:5:ddr', onScreen: true })).toBe(true);
  expect(reads).toBe(1);
});

/* ---------- the line over the composer ---------- */

test('the line says the step under way in the service’s words', () => {
  expect(workStep(browsing(), 'Nova')).toEqual({
    words: 'Choosing seats on flights.example',
    surface: 'browser',
  });
});

test('between steps it says which screen the agent is on; it goes once the work moves or ends', () => {
  const between = browsing(() => [tool(entry('call:seat', { title: 'Chose seats 14A and 14B' }))]);
  expect(workStep(between, 'Nova')?.words).toBe('Nova is using the browser');
  const moved = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B' })),
    tool(entry('call:run', { kind: 'sandbox', title: 'Ran `python3 fare.py`', status: 'running' })),
  ]);
  expect(workStep(moved, 'Nova')).toBeNull();
  expect(workStep(ended(), 'Nova')).toBeNull();
  expect(workStep(null, 'Nova')).toBeNull();
});

test('the line names its buttons and draws the step', () => {
  const html = renderToStaticMarkup(
    <WorkPill
      turn={browsing()}
      conversationId="job_1"
      agentName="Nova"
      onStop={() => {}}
      onTakeOver={() => {}}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain('Choosing seats on flights.example');
  expect(html).toContain('aria-label="Take over the browser"');
  expect(html).toContain('aria-label="Stop Nova"');
  expect(html).toContain('aria-label="Choosing seats on flights.example. Show Nova’s browser"');
  expect(
    renderToStaticMarkup(
      <WorkPill
        turn={ended()}
        conversationId="job_1"
        agentName="Nova"
        onStop={() => {}}
        onTakeOver={() => {}}
        onOpen={() => {}}
      />,
    ),
  ).toBe('');
});

const computerWith = (session: string | null): AgentComputer => ({
  browser: session
    ? {
        session_id: session,
        control: 'agent',
        url: 'https://flights.example/seats',
        title: 'Seats',
        screenshot: null,
        seen_at: AT,
      }
    : null,
  terminal: [],
  processes: [],
  available: { browser: true, terminal: true },
});
const ok = <T,>(data: T): Result<T> => ({ data, error: null, unavailable: null });
const desktopNamed = (session: string): SandboxComputer => ({
  session_id: session,
  job_id: 'job_1',
  agent_id: 'nova',
  status: 'ready',
  running: true,
  control: 'agent',
  control_epoch: 1,
  viewport: { width: 1024, height: 768 },
  egress: 'open',
});
const fakeCalls = (session: string | null, desktop: string | null = null) => ({
  computer: async () => ok(computerWith(session)),
  sandboxComputers: async () => ok({ computers: desktop ? [desktopNamed(desktop)] : [] }),
});

test('Stop and Take over call the conversation’s own stop and take-over', async () => {
  let stopped = 0;
  const taken: CardAction[] = [];
  let opened = 0;
  const pill = WorkPill({
    turn: browsing(),
    conversationId: 'job_1',
    agentName: 'Nova',
    onStop: () => {
      stopped += 1;
    },
    onTakeOver: (action) => taken.push(action),
    onOpen: () => {
      opened += 1;
    },
    calls: fakeCalls('bs_1'),
  });
  button(pill, /^Stop Nova$/)();
  expect(stopped).toBe(1);
  button(pill, /^Take over the browser$/)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(taken).toEqual([
    { label: 'Take over', kind: 'take_over', handle: 'bs_1', surface: 'browser' },
  ]);
  button(pill, /Show Nova’s browser$/)();
  expect(opened).toBe(1);
});

test('take-over finds the desktop’s session, and with none running shows the computer', async () => {
  expect(await takeOverAction('job_1', 'computer', fakeCalls(null, 'sbx_1'))).toEqual({
    label: 'Take over',
    kind: 'take_over',
    handle: 'sbx_1',
    surface: 'computer',
  });
  expect(await takeOverAction('job_1', 'browser', fakeCalls(null))).toBeNull();
  let opened = 0;
  const pill = WorkPill({
    turn: browsing(),
    conversationId: 'job_1',
    agentName: 'Nova',
    onStop: () => {},
    onTakeOver: () => {
      throw new Error('nothing to take over');
    },
    onOpen: () => {
      opened += 1;
    },
    calls: fakeCalls(null),
  });
  button(pill, /^Take over the browser$/)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(1);
});

test('the turn’s computer work is listed oldest first', () => {
  expect(computerTools(browsing()).map((t) => t.id)).toEqual(['call:open', 'call:seat']);
});
