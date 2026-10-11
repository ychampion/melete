/**
 * A picture of the agent's browser or desktop in the conversation, under the
 * rows of the work it did there. While the turn is at work it follows the
 * screen; once the turn ends it keeps the last picture, so the transcript
 * shows what was done, or says plainly that no picture was kept. Tapping it
 * opens the agent's computer beside the chat.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { AgentComputer } from '../experience/types.ts';
import { shownAddress } from './live.ts';
import {
  atWork,
  type ComputerSurface,
  cardPulse,
  createRefresher,
  type Frame,
  frameFor,
  frameIsFresh,
  surfaceOf,
  turnStill,
} from './live-card.ts';
import './live-card.css';

export type { Frame } from './live-card.ts';

/**
 * The last picture each turn showed, kept past the card itself: a turn that
 * ends folds its work away and draws the picture again under the summary.
 */
const lastFrames = new Map<string, Frame>();
const FRAMES_KEPT = 50;
export const keepFrame = (turnId: string, frame: Frame) => {
  // A read that lands late never puts an older picture over a newer one.
  const kept = lastFrames.get(turnId);
  if (kept && Date.parse(kept.seenAt) > Date.parse(frame.seenAt)) return;
  lastFrames.delete(turnId);
  lastFrames.set(turnId, frame);
  if (lastFrames.size > FRAMES_KEPT) {
    const oldest = lastFrames.keys().next().value;
    if (oldest !== undefined) lastFrames.delete(oldest);
  }
};

type Calls = Pick<typeof adapter, 'computer' | 'artifactUrl'>;

const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * A read of a conversation's computer in flight, shared only with callers whose
 * change it can answer: one that began at or after `since`. An older read
 * may show the page from before that change, so a new one is made instead.
 */
const reading = new Map<string, { started: number; result: Promise<Result<AgentComputer>> }>();
function readComputer(
  conversationId: string,
  calls: Calls,
  since: number,
): Promise<Result<AgentComputer>> {
  const pending = reading.get(conversationId);
  if (pending && pending.started >= since) return pending.result;
  const started = clock();
  const result = calls.computer(conversationId).finally(() => {
    if (reading.get(conversationId)?.result === result) reading.delete(conversationId);
  });
  reading.set(conversationId, { started, result });
  return result;
}

/** When this tab first saw each turn ended, so a look for its picture asks after that. */
const endSeen = new Map<string, number>();
const ENDS_KEPT = 200;
const sawEnd = (turnId: string) => {
  if (endSeen.has(turnId)) return;
  endSeen.set(turnId, clock());
  if (endSeen.size > ENDS_KEPT) {
    const oldest = endSeen.keys().next().value;
    if (oldest !== undefined) endSeen.delete(oldest);
  }
};

/**
 * Looks once for the picture of an ended turn this tab never kept, as after a
 * reload: the service's newest picture, when it was seen during this turn.
 */
export async function lookUpFrame(
  turn: TranscriptTurn,
  tools: ToolEntry[],
  calls: Calls = adapter,
  /** When the turn was seen ended; a read begun before then cannot answer for it. */
  since: number = endSeen.get(turn.id) ?? clock(),
): Promise<Frame | null> {
  const result = await readComputer(turn.turn.conversation_id, calls, since);
  const found = frameFor(turn, tools, result.data?.browser, calls.artifactUrl);
  if (found) keepFrame(turn.id, found);
  return found;
}

/** Whether the element is in view, while `watch` asks for it; nothing is observed otherwise. */
function useOnScreen(ref: RefObject<HTMLElement | null>, watch: boolean): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!watch || !node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, watch]);
  return onScreen;
}

const tabInView = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Whether this tab is the one in view. */
function useTabVisible(): boolean {
  const [visible, setVisible] = useState(tabInView);
  useEffect(() => {
    const change = () => setVisible(tabInView());
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return visible;
}

/** How long a failed read waits before it is tried again, and how many times in a row. */
const RETRY_MS = 3000;
const RETRIES = 2;

export function LiveBrowserCard({
  turn,
  tools,
  agentName,
  onOpen,
  calls = adapter,
}: {
  turn: TranscriptTurn;
  /** The turn's browser and desktop work, oldest first. */
  tools: ToolEntry[];
  agentName: string;
  /** Shows the agent's computer beside the chat. */
  onOpen: () => void;
  calls?: Calls;
}) {
  const live = atWork(turn.status);
  if (!live) sawEnd(turn.id);
  const surface = surfaceOf(tools);
  const [frame, setFrame] = useState<Frame | null>(() => lastFrames.get(turn.id) ?? null);
  const box = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(box, live);
  const tabVisible = useTabVisible();
  const pulse = cardPulse(turn, tools);
  const conversationId = turn.turn.conversation_id;
  const turnId = turn.id;
  const ticket = useRef(0);
  // A read is judged against the turn as it is when the answer lands, not as it was when asked.
  const current = useRef({ turn, tools });
  current.current = { turn, tools };
  const [retry, setRetry] = useState(0);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  // The browser's picture is read from the same place the computer panel reads it.
  const refresh = useRef(
    createRefresher(() => {
      const mine = ++ticket.current;
      // A change on the stream is answered by a read begun after it, never one already under way.
      return readComputer(conversationId, calls, clock()).then((result) => {
        if (!result.data) {
          // Tried again shortly, a couple of times; after that, at the next step.
          if (retries.current < RETRIES) {
            retries.current += 1;
            retryTimer.current = setTimeout(() => setRetry((count) => count + 1), RETRY_MS);
          }
          return false;
        }
        retries.current = 0;
        const now = current.current;
        const next = frameFor(now.turn, now.tools, result.data.browser, calls.artifactUrl);
        if (next) keepFrame(turnId, next);
        if (mine === ticket.current && next) setFrame(lastFrames.get(turnId) ?? next);
        return true;
      });
    }),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is the trigger for a read that failed
  useEffect(() => {
    if (surface !== 'browser') return;
    refresh.current({ live, onScreen, tabVisible, pulse });
  }, [surface, live, onScreen, tabVisible, pulse, retry]);

  // On the desktop, the newest screenshot the work took is the picture; it comes with the stream.
  const still = turnStill(tools);
  // An ended browser turn this tab kept no picture of asks the service once.
  const lookUp = !live && surface === 'browser' && !frame && !still;
  const [looking, setLooking] = useState(lookUp);
  const looked = useRef(false);
  useEffect(() => {
    if (!lookUp || looked.current) return;
    looked.current = true;
    setLooking(true);
    void lookUpFrame(current.current.turn, current.current.tools, calls).then((found) => {
      if (found) setFrame(found);
      setLooking(false);
    });
  }, [lookUp, calls]);

  const fromFrame = surface === 'browser' ? Boolean(frame) : !still && Boolean(frame);
  const src = fromFrame ? (frame?.src ?? null) : (still?.src ?? null);
  const fresh = fromFrame ? Boolean(frame && frameIsFresh(frame, tools)) : Boolean(still?.newest);
  const address = surface === 'browser' && frame?.url ? shownAddress(frame.url) : '';
  return (
    <LiveCardView
      boxRef={box}
      src={src}
      live={live}
      fresh={fresh}
      looking={lookUp && (looking || !looked.current)}
      surface={surface}
      address={address}
      agentName={agentName}
      onOpen={onOpen}
    />
  );
}

/** The picture itself, drawn from what the card knows; tapping it shows the computer. */
export function LiveCardView({
  boxRef,
  src,
  live,
  fresh,
  looking = false,
  surface,
  address,
  agentName,
  onOpen,
}: {
  boxRef?: RefObject<HTMLButtonElement | null>;
  src: string | null;
  live: boolean;
  /** The picture shows the newest step, not the screen as it was before it. */
  fresh: boolean;
  /** An ended turn's picture is still being looked for. */
  looking?: boolean;
  surface: ComputerSurface;
  /** The page's address, when the browser's picture was read with it. */
  address: string;
  agentName: string;
  onOpen: () => void;
}) {
  const where = surface === 'browser' ? `${agentName}’s browser` : `${agentName}’s computer`;
  const caption = address || (surface === 'browser' ? 'Browser' : 'Desktop');
  const on = address ? ` on ${address}` : '';
  const badge = live && src ? (fresh ? 'Live' : 'Last seen') : null;
  const none = !live && !src && !looking;
  const label = live
    ? `${where}, ${src ? (fresh ? 'live' : 'last seen') : 'at work'}${on}. Open the computer to watch or take over.`
    : none
      ? `${where}. No picture was kept. Open the computer.`
      : `${where} when the work ended${address ? `, on ${address}` : ''}. Open the computer.`;
  return (
    <button
      ref={boxRef}
      type="button"
      className="live-card"
      data-live={live ? 'true' : undefined}
      data-surface={surface}
      aria-label={label}
      onClick={onOpen}
    >
      <span className="live-card-screen" data-none={none ? 'true' : undefined}>
        {src ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <span className="live-card-empty">
            <Icon name={surface === 'browser' ? 'globe' : 'monitor'} size={20} />
          </span>
        )}
        {none ? <span className="live-card-none">No picture was kept</span> : null}
        {badge ? (
          <span
            className="live-card-badge"
            data-fresh={fresh ? 'true' : undefined}
            aria-hidden="true"
          >
            {fresh ? <span className="live-card-dot" /> : null}
            {badge}
          </span>
        ) : null}
      </span>
      <span className="live-card-foot" aria-hidden="true">
        <Icon name={surface === 'browser' ? 'globe' : 'monitor'} size={13} />
        <span className="live-card-address clamp1">{caption}</span>
        <span className="live-card-open">
          {live ? 'Watch' : 'Open'}
          <Icon name="arrowUpRight" size={12} />
        </span>
      </span>
    </button>
  );
}
