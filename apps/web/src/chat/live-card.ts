/**
 * The agent's computer, told inside the conversation: which work in a turn was
 * on its browser or desktop, where in the turn the picture of it belongs, what
 * the line over the composer says while that work goes on, and when the
 * picture may be read again. Pure functions, so the rules can be tested
 * without a screen.
 */
import { adapter } from '../experience/adapter.ts';
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { CardAction, TurnStatus } from '../experience/types.ts';
import type { LogItem } from './worklog.ts';

export type ComputerSurface = 'browser' | 'computer';

/**
 * Whether a piece of work happened on the agent's own browser or desktop.
 * Commands it ran are the terminal's, and a browser on the person's own
 * computer is theirs to look at, not the agent's.
 */
export function isComputerTool(tool: ToolEntry): boolean {
  if (/\byour (browser|computer|screen)\b/i.test(tool.title)) return false;
  if (tool.kind === 'browser') return true;
  if (tool.kind !== 'sandbox') return false;
  // A command run in the sandbox is told by the terminal, not by a picture.
  return !/^(Ran|Running)\b/.test(tool.title) && !tool.title.includes('`');
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

/** The newest picture the turn's own work took of the screen, when it took one. */
export function turnStill(tools: ToolEntry[]): string | null {
  for (let index = tools.length - 1; index >= 0; index--) {
    const detail = tools[index]?.detail;
    if (detail?.type === 'screenshot') return adapter.screenshotUrl(detail.id);
    if (detail?.type === 'artifact' && /screenshot|at the screen/i.test(tools[index]?.title ?? ''))
      return adapter.artifactUrl(detail.id);
  }
  return null;
}

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
 * The line over the composer while the agent is at work on its computer: the
 * step under way in the service's words, or, between steps, which screen it is
 * on. Null when the turn is not at work there, so the line goes away.
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
 * stream. Coming back on screen after changes it missed reads it once.
 */
export function createRefresher(read: () => void) {
  let last: string | null = null;
  return (state: { live: boolean; onScreen: boolean; tabVisible: boolean; pulse: string }) => {
    if (!state.live || !state.onScreen || !state.tabVisible) return false;
    if (state.pulse === last) return false;
    last = state.pulse;
    read();
    return true;
  };
}

type Calls = Pick<typeof adapter, 'computer' | 'sandboxComputers'>;

/**
 * The take-over the line over the composer offers, for the screen the agent is
 * on: the same action a hand-off card carries. Null when no session of that
 * screen is running, so the computer is shown instead.
 */
export async function takeOverAction(
  conversationId: string,
  surface: ComputerSurface,
  calls: Calls = adapter,
): Promise<CardAction | null> {
  if (surface === 'browser') {
    const result = await calls.computer(conversationId);
    const session = result.data?.browser?.session_id;
    return session
      ? { label: 'Take over', kind: 'take_over', handle: session, surface: 'browser' }
      : null;
  }
  const result = await calls.sandboxComputers(conversationId);
  const session = result.data?.computers[0]?.session_id;
  return session
    ? { label: 'Take over', kind: 'take_over', handle: session, surface: 'computer' }
    : null;
}
