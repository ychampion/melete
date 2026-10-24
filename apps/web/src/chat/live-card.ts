/**
 * The agent's computer, told inside the conversation: which work in a turn was
 * on its browser or desktop, where in the turn the picture of it belongs, what
 * the line over the composer says while that work goes on, and when the
 * picture may be read again. Pure functions, so the rules can be tested
 * without a screen.
 */
import { adapter } from '../experience/adapter.ts';
import { turnAgent } from '../experience/hooks.ts';
import { assistantName } from '../experience/instance.ts';
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type {
  Agent,
  CardAction,
  ComputerBrowser,
  SandboxComputer,
  TurnStatus,
} from '../experience/types.ts';
import type { LogItem } from './worklog.ts';

export type ComputerSurface = 'browser' | 'computer';

/**
 * Work on the agent's own desktop, as the service names it: opening a page,
 * looking at the screen, clicking, typing, pressing keys, scrolling, or a few
 * of those at once, "in its computer". Commands it ran there, what they sent
 * out, and measured tries are the terminal's, and are named otherwise.
 */
const SCREEN_WORK =
  /^(?:proposed )?(?:opening|opened|tried to open|looking at the screen of|took a screenshot of|clicking|clicked|typing|typed|pressing|pressed|scrolling|scrolled|doing a few steps|did a few steps)\b.*\bits computer\b/i;

/**
 * Whether a piece of work happened on the agent's own browser or desktop.
 * Commands it ran are the terminal's, and a browser on the person's own
 * computer is theirs to look at, not the agent's.
 */
export function isComputerTool(tool: ToolEntry): boolean {
  if (/\byour (browser|computer|screen)\b/i.test(tool.title)) return false;
  if (tool.kind === 'browser') return true;
  if (tool.kind !== 'sandbox') return false;
  return tool.detail?.type === 'screenshot' || SCREEN_WORK.test(tool.title);
}

/** The browser and desktop work of a turn, oldest first. */
export function computerTools(turn: TranscriptTurn): ToolEntry[] {
  const tools: ToolEntry[] = [];
  for (const step of turn.trail)
    if (step.type === 'action' && step.tool && isComputerTool(step.tool)) tools.push(step.tool);
  return tools;
}

/** Which screen the newest of that work was on. */
export const surfaceOf = (tools: ToolEntry[]): ComputerSurface =>
  tools.at(-1)?.kind === 'browser' ? 'browser' : 'computer';

/**
 * The work row the turn's one picture sits under: the last group of rows with
 * browser or desktop work in it. A turn has one picture however many steps it
 * took, so the transcript stays a list of messages and quiet rows.
 */
export function cardHost(items: LogItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (
      item?.type === 'work' &&
      item.work.some((work) => work.type === 'tool' && isComputerTool(work.tool))
    )
      return item.key;
  }
  return null;
}

/**
 * The newest picture the turn's own work took of the screen, when it took one,
 * and whether it is of the newest step: a picture taken before later clicks
 * is the screen as last seen, not as it is.
 */
export function turnStill(tools: ToolEntry[]): { src: string; newest: boolean } | null {
  for (let index = tools.length - 1; index >= 0; index--) {
    const detail = tools[index]?.detail;
    const newest = index === tools.length - 1;
    if (detail?.type === 'screenshot') return { src: adapter.screenshotUrl(detail.id), newest };
    if (detail?.type === 'artifact' && /screenshot|at the screen/i.test(tools[index]?.title ?? ''))
      return { src: adapter.artifactUrl(detail.id), newest };
  }
  return null;
}

/** A picture of the agent's browser, with the page it shows and when the agent saw it. */
export type Frame = { src: string; url: string | null; title: string | null; seenAt: string };

/** Room for an action's end being written a moment after the agent saw the page. */
const END_SLACK_MS = 5000;

/**
 * The browser's last picture, when it belongs to this turn. The service keeps
 * one picture per conversation, the newest, so a picture seen before this
 * turn's first browser step is an earlier turn's, and once the turn has ended
 * a picture seen after its last step is a later turn's.
 */
export function frameFor(
  turn: TranscriptTurn,
  tools: ToolEntry[],
  browser: ComputerBrowser | null | undefined,
  artifactUrl: (id: string) => string,
): Frame | null {
  if (!browser?.screenshot || !browser.seen_at) return null;
  const seen = Date.parse(browser.seen_at);
  const steps = tools.filter((tool) => tool.kind === 'browser');
  if (!steps.length || Number.isNaN(seen)) return null;
  const began = Math.min(...steps.map((tool) => Date.parse(tool.started_at)));
  if (!(seen >= began)) return null;
  if (!atWork(turn.status)) {
    const ends = steps.map((tool) => tool.ended_at);
    const stepEnd = ends.every((end) => end !== null)
      ? Math.max(...ends.map((end) => Date.parse(end ?? '')))
      : Number.NaN;
    const turnEnd = turn.ended_at ? Date.parse(turn.ended_at) : Number.NaN;
    // The stream's end of the turn comes after its last step, so nothing seen later is this
    // turn's; without it, the steps' own ends are the bound, with a little room.
    const bound = !Number.isNaN(turnEnd)
      ? Math.max(turnEnd, Number.isNaN(stepEnd) ? turnEnd : stepEnd)
      : stepEnd + END_SLACK_MS;
    if (!Number.isNaN(bound) && seen > bound) return null;
  }
  return {
    src: artifactUrl(browser.screenshot.artifact_id),
    url: browser.url,
    title: browser.title,
    seenAt: browser.seen_at,
  };
}

/** Whether the browser's picture was seen once the newest step had begun, so it shows that step. */
export const frameIsFresh = (frame: Frame, tools: ToolEntry[]): boolean => {
  const newest = tools.at(-1);
  return newest !== undefined && Date.parse(frame.seenAt) >= Date.parse(newest.started_at);
};

/**
 * What changes when the picture may have changed: a step added, or a step
 * finishing. Read from the turn the stream already keeps, so nothing new is
 * asked of the service to know it.
 */
export const cardPulse = (turn: TranscriptTurn, tools: ToolEntry[]): string =>
  `${turn.status}:${turn.trail.length}:${tools.map((tool) => tool.status[0]).join('')}`;

/** The turn is at work, not waiting on the person and not ended. */
const AT_WORK: TurnStatus[] = ['queued', 'working', 'streaming', 'stalled'];
export const atWork = (status: TurnStatus): boolean => AT_WORK.includes(status);

/**
 * The turn the line over the composer speaks for: the newest one at work that
 * has begun. A message waiting to be sent when the answer ends, or one with a
 * file, is a turn of its own that has not begun, and the turn still running
 * keeps the line.
 */
export function runningTurn(turns: TranscriptTurn[]): TranscriptTurn | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn && atWork(turn.status) && (turn.status !== 'queued' || turn.trail.length > 0))
      return turn;
  }
  return null;
}

/** Who the line over the composer names: the running turn's agent, else the chat's. */
export const workerName = (
  turn: TranscriptTurn | null | undefined,
  agents: Agent[],
  removed: Agent[] | undefined,
  chatAgent: Agent | null | undefined,
): string =>
  (turnAgent(agents, removed, turn?.turn.agent_id) ?? chatAgent)?.name ?? assistantName();

/**
 * The line over the composer while the agent is at work on its computer: the
 * step under way in the service's words, or, between steps, which screen it is
 * on. Null when the turn is not at work there, so the line goes away: once the
 * agent moves to other work, once its last step there failed (the screen may
 * not be there at all), and once it is writing its answer.
 */
export function workStep(
  turn: TranscriptTurn | null | undefined,
  agentName: string,
): { words: string; surface: ComputerSurface } | null {
  if (!turn || !atWork(turn.status)) return null;
  let latest: ToolEntry | null = null;
  for (let index = turn.trail.length - 1; index >= 0 && !latest; index--) {
    const step = turn.trail[index];
    if (step?.type === 'action' && step.tool && step.tool.kind !== 'model') latest = step.tool;
  }
  // The newest work decides: once the agent turns to something else, the line goes.
  if (!latest || !isComputerTool(latest)) return null;
  const surface: ComputerSurface = latest.kind === 'browser' ? 'browser' : 'computer';
  const under = turn.live && turn.live.id === latest.id ? turn.live.title : null;
  const running = latest.status === 'running' || latest.status === 'needs_approval';
  if (!under && !running) {
    if (latest.status === 'failed' || latest.status === 'unknown') return null;
    // Words written after its last step there: the agent is answering, not on its screen.
    if (turn.flow.at(-1)?.type === 'text') return null;
  }
  const words =
    under ??
    (running
      ? latest.title
      : surface === 'browser'
        ? `${agentName} is using the browser`
        : `${agentName} is using its computer`);
  return { words, surface };
}

/**
 * When the picture is read again: only while the turn is at work, the picture
 * is on screen and the tab is in view, and only once for each change on the
 * stream. Coming back on screen after changes it missed reads it once. A read
 * that fails leaves its change unread, so the next look reads it again: `read`
 * answers a promise of true once the picture was read.
 */
export function createRefresher(read: () => unknown) {
  let last: string | null = null;
  return (state: { live: boolean; onScreen: boolean; tabVisible: boolean; pulse: string }) => {
    if (!state.live || !state.onScreen || !state.tabVisible) return false;
    if (state.pulse === last) return false;
    const pulse = state.pulse;
    last = pulse;
    const reading = read();
    if (reading instanceof Promise)
      void reading.then((ok) => {
        if (ok !== true && last === pulse) last = null;
      });
    return true;
  };
}

type Calls = Pick<typeof adapter, 'computer' | 'sandboxComputers'>;

/**
 * The chat's own desktop. Every turn in a chat, an @mentioned agent's too,
 * works on the computer of the chat's agent, so `agentId` is the chat's agent,
 * never the turn's. A chat can also list desktops of helper work run by other
 * agents; one whose agent is not named may be anyone's, and another agent's is
 * never taken for the chat's.
 */
export const displayFor = (
  computers: SandboxComputer[],
  agentId: string | null | undefined,
): SandboxComputer | null =>
  agentId
    ? (computers.find((computer) => computer.agent_id === agentId) ??
      computers.find((computer) => computer.agent_id === null) ??
      null)
    : (computers[0] ?? null);

/**
 * The take-over the line over the composer offers, for the screen the agent is
 * on: the same action a hand-off card carries. No action when no session of
 * that screen is running, so the computer is shown instead; the reason when
 * the service could not be asked.
 */
export async function takeOverAction(
  conversationId: string,
  surface: ComputerSurface,
  agentId: string | null,
  calls: Calls = adapter,
): Promise<{ action: CardAction | null; error: string | null }> {
  if (surface === 'browser') {
    const result = await calls.computer(conversationId);
    if (!result.data) return { action: null, error: result.error ?? result.unavailable };
    const session = result.data.browser?.session_id;
    return {
      action: session
        ? { label: 'Take over', kind: 'take_over', handle: session, surface: 'browser' }
        : null,
      error: null,
    };
  }
  const result = await calls.sandboxComputers(conversationId);
  if (!result.data) return { action: null, error: result.error ?? result.unavailable };
  const session = displayFor(result.data.computers, agentId)?.session_id;
  return {
    action: session
      ? { label: 'Take over', kind: 'take_over', handle: session, surface: 'computer' }
      : null,
    error: null,
  };
}
