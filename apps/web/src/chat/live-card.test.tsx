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
import {
  addLocalTurn,
  applyEvents,
  fromTurns,
  latestTurn,
  type TranscriptTurn,
} from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type {
  Agent,
  AgentComputer,
  CardAction,
  ExperienceEvent,
  SandboxComputer,
  Turn,
} from '../experience/types.ts';
import { keepFrame, LiveCardView, lookUpFrame } from './LiveBrowserCard.tsx';
import {
  cardHost,
  computerTools,
  createRefresher,
  displayFor,
  frameFor,
  frameIsFresh,
  isComputerTool,
  runningTurn,
  takeOverAction,
  workerName,
  workStep,
} from './live-card.ts';
import { WorkLog } from './WorkLog.tsx';
import { takeOverFromPill, WorkPill } from './WorkPill.tsx';
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
  // No picture has been read yet, so nothing is called live.
  expect(html).toContain('Nova’s browser, at work. Open the computer to watch or take over.');
  expect(html).not.toContain('>Live<');
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
    seenAt: AT,
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

test('on the desktop, the newest screenshot the work took is the picture, last seen once it clicks on', () => {
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
  // The picture was taken before the click under way: it is the screen as last seen.
  expect(html).toContain('Nova’s computer, last seen.');
  expect(html).toContain('>Last seen<');
  expect(html).not.toContain('>Live<');
});

test('tapping the picture opens the computer, live or ended', () => {
  for (const live of [true, false]) {
    let opened = 0;
    const view = LiveCardView({
      src: null,
      live,
      fresh: false,
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
      onError={() => {}}
      chatAgentId="nova"
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
        onError={() => {}}
        chatAgentId="nova"
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
const desktopNamed = (session: string, agent: string | null = 'nova'): SandboxComputer => ({
  session_id: session,
  job_id: 'job_1',
  agent_id: agent,
  status: 'ready',
  running: true,
  control: 'agent',
  control_epoch: 1,
  viewport: { width: 1024, height: 768 },
  egress: 'open',
  view: 'stream',
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
    onError: () => {
      throw new Error('no error expected');
    },
    chatAgentId: 'nova',
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
  expect(await takeOverAction('job_1', 'computer', 'nova', fakeCalls(null, 'sbx_1'))).toEqual({
    action: { label: 'Take over', kind: 'take_over', handle: 'sbx_1', surface: 'computer' },
    error: null,
  });
  expect(await takeOverAction('job_1', 'browser', 'nova', fakeCalls(null))).toEqual({
    action: null,
    error: null,
  });
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
    onError: () => {
      throw new Error('no error expected');
    },
    chatAgentId: 'nova',
    calls: fakeCalls(null),
  });
  button(pill, /^Take over the browser$/)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(1);
});

test('the turn’s computer work is listed oldest first', () => {
  expect(computerTools(browsing()).map((t) => t.id)).toEqual(['call:open', 'call:seat']);
});

/* ---------- whose turn, whose desktop, and which picture ---------- */

const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const seenBrowser = (seenAt: string | null, artifact = 'art_seen'): AgentComputer['browser'] => ({
  session_id: 'bs_1',
  control: 'agent',
  url: 'https://flights.example/seats',
  title: 'Seats',
  screenshot: { artifact_id: artifact },
  seen_at: seenAt,
});
const artifactUrl = (id: string) => `/artifacts/${id}/content`;

test('a message waiting for the answer, or one with a file, leaves the line with the running turn', () => {
  const running = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('call:up', { title: 'Uploading 8 receipts', status: 'running', ended_at: null })),
  ]);
  for (const delivery of ['waiting_turn', null] as const) {
    const transcript = addLocalTurn(running, '@Scout check the totals', 'scout', 'job_1', delivery);
    // The newest turn is the message waiting to go; it has not begun.
    expect(workStep(latestTurn(transcript), 'Nova')).toBeNull();
    const turn = runningTurn(transcript.turns);
    expect(turn?.id).toBe('turn_1');
    const html = renderToStaticMarkup(
      <WorkPill
        turn={turn}
        conversationId="job_1"
        agentName="Nova"
        onStop={() => {}}
        onTakeOver={() => {}}
        onOpen={() => {}}
        onError={() => {}}
        chatAgentId="nova"
      />,
    );
    expect(html).toContain('Uploading 8 receipts');
    expect(html).toContain('aria-label="Take over the browser"');
  }
  // With no turn at work, there is no line.
  const ended = applyEvents(fromTurns([{ ...TURN, status: 'done' }], 'send', 'done'), []);
  expect(runningTurn(ended.turns)).toBeNull();
});

test('what a command sent out and a measured try are not screen work, so they draw no picture and no line', () => {
  const sent = entry('sent:act_1:api.example', {
    kind: 'sandbox',
    title: 'Sent 2.1 KB to api.example from its computer',
    parent: 'action:act_1',
  });
  expect(isComputerTool(sent)).toBe(false);
  for (const title of ['Trying something and measuring it', 'Tried something and measured it'])
    expect(isComputerTool(entry('try', { kind: 'sandbox', title }))).toBe(false);
  for (const title of [
    'Running `pip install requests` in its computer',
    'Proposed running a command in its computer — waiting for you',
    'Ran code',
  ])
    expect(isComputerTool(entry('cmd', { kind: 'sandbox', title }))).toBe(false);
  const transcript = applyEvents(fromTurns([TURN], 'pause', 'working'), [
    tool(entry('action:act_1', { kind: 'sandbox', title: 'Ran `curl` in its computer' })),
    tool(sent),
  ]);
  const turn = only(transcript.turns[0]);
  expect(cardHost(logItems(turn))).toBeNull();
  expect(renderLog(turn)).not.toContain('live-card');
  expect(workStep(turn, 'Nova')).toBeNull();
});

test('every way the service names desktop work counts as screen work', () => {
  for (const title of [
    'Opening flights.example in its computer',
    'Opened a page in its computer',
    'Tried to open a page in its computer; the window did not change',
    'Looking at the screen of its computer',
    'Took a screenshot of its computer',
    'Clicking in its computer',
    'Typed in its computer',
    'Pressed Ctrl+L in its computer',
    'Scrolling in its computer',
    'Did a few steps in its computer',
    'Proposed clicking in its computer — waiting for you',
  ])
    expect(isComputerTool(entry('screen', { kind: 'sandbox', title }))).toBe(true);
});

test('take-over picks the desktop of the agent at work, never another agent’s', async () => {
  const both = [desktopNamed('sbd_scout', 'scout'), desktopNamed('sbd_nova', 'nova')];
  expect(displayFor(both, 'nova')?.session_id).toBe('sbd_nova');
  expect(displayFor([desktopNamed('sbd_scout', 'scout')], 'nova')).toBeNull();
  expect(displayFor([desktopNamed('sbd_any', null)], 'nova')?.session_id).toBe('sbd_any');
  const calls = {
    computer: async () => ok(computerWith(null)),
    sandboxComputers: async () => ok({ computers: both }),
  };
  expect((await takeOverAction('job_1', 'computer', 'nova', calls)).action?.handle).toBe(
    'sbd_nova',
  );
});

test('an ended browser turn this tab kept no picture of looks for it once, and says so when there is none', async () => {
  const turn = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B', ended_at: at(20) })),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  const tools = computerTools(turn);
  let reads = 0;
  const calls = (seenAt: string | null) => ({
    computer: async () => {
      reads += 1;
      return ok({ ...computerWith('bs_1'), browser: seenBrowser(seenAt) });
    },
    artifactUrl,
  });
  // Seen during the turn: the picture is the record.
  expect((await lookUpFrame(turn, tools, calls(at(10))))?.src).toBe('/artifacts/art_seen/content');
  // Seen long after the turn ended, by a later turn: not this turn's.
  expect(await lookUpFrame({ ...turn, id: 'turn_other' }, tools, calls(at(600)))).toBeNull();
  expect(reads).toBe(2);
  // With nothing kept, the card says so instead of showing an empty screen.
  const none = renderToStaticMarkup(
    <LiveCardView
      src={null}
      live={false}
      fresh={false}
      surface="browser"
      address=""
      agentName="Nova"
      onOpen={() => {}}
    />,
  );
  expect(none).toContain('No picture was kept');
  expect(none).toContain('aria-label="Nova’s browser. No picture was kept. Open the computer."');
  // An ended desktop turn that took no screenshot says the same, with nothing to ask.
  const desk = (item: ExperienceEvent['item']) => ({ ...event(item), turn_id: 'turn_desk' });
  const desktop = applyEvents(fromTurns([{ ...TURN, id: 'turn_desk' }], 'pause', 'working'), [
    desk({
      type: 'tool',
      tool: entry('call:click', { kind: 'sandbox', title: 'Clicked in its computer' }),
    }),
    desk({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  const html = renderLog(only(desktop.turns[0]));
  expect(html).toContain('worklog-kept');
  expect(html).toContain('No picture was kept');
});

test('the previous turn’s picture is never filed under a new turn', () => {
  const turn = browsing();
  const tools = computerTools(turn);
  // Seen before this turn's first browser step began: an earlier turn's page.
  expect(frameFor(turn, tools, seenBrowser(at(-30)), artifactUrl)).toBeNull();
  expect(frameFor(turn, tools, seenBrowser(null), artifactUrl)).toBeNull();
  expect(frameFor(turn, tools, seenBrowser(at(5)), artifactUrl)?.seenAt).toBe(at(5));
  // A late read never puts an older picture over a newer one.
  keepFrame('turn_race', { src: '/new', url: null, title: null, seenAt: at(9) });
  keepFrame('turn_race', { src: '/old', url: null, title: null, seenAt: at(3) });
  const kept = renderLog({ ...ended(), id: 'turn_race' });
  expect(kept).toContain('/new');
  expect(kept).not.toContain('/old');
});

test('a read that fails is tried again on the next look', async () => {
  let reads = 0;
  let answer = false;
  const refresh = createRefresher(() => {
    reads += 1;
    return Promise.resolve(answer);
  });
  const state = { live: true, onScreen: true, tabVisible: true, pulse: 'working:2:dr' };
  expect(refresh(state)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Same change on the stream, but the read failed: it is read again.
  answer = true;
  expect(refresh(state)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(refresh(state)).toBe(false);
  expect(reads).toBe(2);
});

test('after a failed step the line does not claim the agent is using the browser', () => {
  const failed = browsing(() => [
    tool(entry('call:seat', { title: 'Choosing seats on flights.example', status: 'failed' })),
  ]);
  expect(workStep(failed, 'Nova')).toBeNull();
});

test('a take-over the service could not look up is reported, and the computer shown', async () => {
  const errors: string[] = [];
  let opened = 0;
  const calls = {
    computer: async (): Promise<Result<AgentComputer>> => ({
      data: null,
      error: 'Couldn’t reach the service',
      unavailable: null,
    }),
    sandboxComputers: async () => ok({ computers: [] }),
  };
  await takeOverFromPill(
    'job_1',
    'browser',
    'nova',
    {
      onTakeOver: () => {
        throw new Error('nothing to take over');
      },
      onOpen: () => {
        opened += 1;
      },
      onError: (reason) => errors.push(reason),
    },
    calls,
  );
  expect(errors).toEqual(['Couldn’t reach the service']);
  expect(opened).toBe(1);
});

test('a picture from before the newest step is labelled last seen, not live', () => {
  const turn = browsing();
  const tools = computerTools(turn);
  const frame = { src: '/p', url: null, title: null, seenAt: at(-1) };
  // The step under way began at AT; a picture seen before it is not of it.
  expect(frameIsFresh(frame, tools)).toBe(false);
  expect(frameIsFresh({ ...frame, seenAt: at(1) }, tools)).toBe(true);
  const view = (fresh: boolean) =>
    renderToStaticMarkup(
      <LiveCardView
        src="/p"
        live
        fresh={fresh}
        surface="browser"
        address="flights.example"
        agentName="Nova"
        onOpen={() => {}}
      />,
    );
  expect(view(false)).toContain('>Last seen<');
  expect(view(false)).not.toContain('>Live<');
  expect(view(false)).toContain('Nova’s browser, last seen on flights.example.');
  expect(view(true)).toContain('Live<');
});

test('the line goes once the agent is writing its answer', () => {
  const answering = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B' })),
    say('Seats 14A and 14B are yours.'),
    event({ type: 'status', status: 'streaming', composer: 'pause' }),
  ]);
  expect(answering.status).toBe('streaming');
  expect(workStep(answering, 'Nova')).toBeNull();
});

test('the line names the agent whose turn is at work, not the chat’s own', () => {
  const agent = (id: string, name: string) => ({ id, name }) as Agent;
  const agents = [agent('nova', 'Nova'), agent('scout', 'Scout')];
  const scouting = {
    ...browsing(() => [tool(entry('call:seat', { title: 'Chose seats 14A and 14B' }))]),
  };
  const turn = { ...scouting, turn: { ...scouting.turn, agent_id: 'scout' } };
  const name = workerName(turn, agents, [], agents[0]);
  expect(name).toBe('Scout');
  const html = renderToStaticMarkup(
    <WorkPill
      turn={turn}
      conversationId="job_1"
      agentName={name}
      onStop={() => {}}
      onTakeOver={() => {}}
      onOpen={() => {}}
      onError={() => {}}
      chatAgentId="nova"
    />,
  );
  expect(html).toContain('Scout is using the browser');
  expect(html).toContain('aria-label="Stop Scout"');
  // An agent no longer listed is still named; with no turn, the chat’s agent is.
  expect(workerName(turn, [agents[0] as Agent], [agent('scout', 'Scout')], agents[0])).toBe(
    'Scout (removed)',
  );
  expect(workerName(null, agents, [], agents[0])).toBe('Nova');
});

test('a turn handed to an @mentioned agent takes over the chat agent’s desktop', async () => {
  // Every turn in Nova's chat works on Nova's computer, Scout's included.
  const scouting = browsing(() => [
    tool(
      entry('call:click', {
        kind: 'sandbox',
        title: 'Clicking in its computer',
        status: 'running',
      }),
    ),
  ]);
  const turn = { ...scouting, turn: { ...scouting.turn, agent_id: 'scout' } };
  const taken: CardAction[] = [];
  let opened = 0;
  const pill = WorkPill({
    turn,
    conversationId: 'job_1',
    agentName: 'Scout',
    onStop: () => {},
    onTakeOver: (action) => taken.push(action),
    onOpen: () => {
      opened += 1;
    },
    onError: () => {
      throw new Error('no error expected');
    },
    chatAgentId: 'nova',
    calls: {
      computer: async () => ok(computerWith(null)),
      sandboxComputers: async () => ok({ computers: [desktopNamed('sbd_chat', 'nova')] }),
    },
  });
  button(pill, /^Take over the computer$/)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(taken.map((action) => action.handle)).toEqual(['sbd_chat']);
  expect(opened).toBe(0);
});

test('a look for a picture never takes the answer of a read begun before it', async () => {
  const turn = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B', ended_at: at(20) })),
    event({ type: 'status', status: 'done', composer: 'send' }),
  ]);
  const tools = computerTools(turn);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let newer = 0;
  const olderCalls = {
    computer: async () => {
      await gate;
      return ok({ ...computerWith('bs_1'), browser: seenBrowser(at(2), 'art_before_last') });
    },
    artifactUrl,
  };
  const newerCalls = {
    computer: async () => {
      newer += 1;
      return ok({ ...computerWith('bs_1'), browser: seenBrowser(at(19), 'art_last') });
    },
    artifactUrl,
  };
  const first = lookUpFrame({ ...turn, id: 'turn_r3a' }, tools, olderCalls);
  await new Promise((resolve) => setTimeout(resolve, 1));
  const second = lookUpFrame({ ...turn, id: 'turn_r3b' }, tools, newerCalls);
  release();
  expect((await first)?.src).toBe('/artifacts/art_before_last/content');
  // The second look began after the first read did, so it made its own.
  expect(newer).toBe(1);
  expect((await second)?.src).toBe('/artifacts/art_last/content');
});

test('once the stream says a turn ended, a picture seen after that is a later turn’s', () => {
  const turn = browsing(() => [
    tool(entry('call:seat', { title: 'Chose seats 14A and 14B', ended_at: at(10) })),
    { ...event({ type: 'status', status: 'done', composer: 'send' }), created_at: at(11) },
  ]);
  expect(turn.ended_at).toBe(at(11));
  const tools = computerTools(turn);
  expect(frameFor(turn, tools, seenBrowser(at(15)), artifactUrl)).toBeNull();
  expect(frameFor(turn, tools, seenBrowser(at(10)), artifactUrl)?.seenAt).toBe(at(10));
});
