/**
 * A picture of the agent's browser or desktop in the conversation, under the
 * rows of the work it did there. While the turn is at work it follows the
 * screen; once the turn ends it keeps the last picture, so the transcript
 * shows what was done. Tapping it opens the agent's computer beside the chat.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import { shownAddress } from './live.ts';
import {
  atWork,
  type ComputerSurface,
  cardPulse,
  createRefresher,
  surfaceOf,
  turnStill,
} from './live-card.ts';
import './live-card.css';

export type Frame = { src: string; url: string | null; title: string | null };

/**
 * The last picture each turn showed, kept past the card itself: a turn that
 * ends folds its work away and draws the picture again under the summary.
 */
const lastFrames = new Map<string, Frame>();
const FRAMES_KEPT = 50;
export const keepFrame = (turnId: string, frame: Frame) => {
  lastFrames.delete(turnId);
  lastFrames.set(turnId, frame);
  if (lastFrames.size > FRAMES_KEPT) {
    const oldest = lastFrames.keys().next().value;
    if (oldest !== undefined) lastFrames.delete(oldest);
  }
};

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
  calls?: Pick<typeof adapter, 'computer' | 'artifactUrl'>;
}) {
  const live = atWork(turn.status);
  const surface = surfaceOf(tools);
  const [frame, setFrame] = useState<Frame | null>(() => lastFrames.get(turn.id) ?? null);
  const box = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(box, live);
  const tabVisible = useTabVisible();
  const pulse = cardPulse(turn, tools);
  const conversationId = turn.turn.conversation_id;
  const turnId = turn.id;
  const ticket = useRef(0);

  // The browser's picture is read from the same place the computer panel reads it.
  const refresh = useRef(
    createRefresher(() => {
      const mine = ++ticket.current;
      void calls.computer(conversationId).then((result) => {
        const browser = result.data?.browser;
        if (mine !== ticket.current || !browser?.screenshot) return;
        const next = {
          src: calls.artifactUrl(browser.screenshot.artifact_id),
          url: browser.url,
          title: browser.title,
        };
        keepFrame(turnId, next);
        setFrame(next);
      });
    }),
  );
  useEffect(() => {
    if (surface !== 'browser') return;
    refresh.current({ live, onScreen, tabVisible, pulse });
  }, [surface, live, onScreen, tabVisible, pulse]);

  // On the desktop, the newest screenshot the work took is the picture; it comes with the stream.
  const still = turnStill(tools);
  const src = surface === 'browser' ? (frame?.src ?? still) : (still ?? frame?.src ?? null);
  const address = surface === 'browser' && frame?.url ? shownAddress(frame.url) : '';
  return (
    <LiveCardView
      boxRef={box}
      src={src}
      live={live}
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
  surface,
  address,
  agentName,
  onOpen,
}: {
  boxRef?: RefObject<HTMLButtonElement | null>;
  src: string | null;
  live: boolean;
  surface: ComputerSurface;
  /** The page's address, when the browser's picture was read with it. */
  address: string;
  agentName: string;
  onOpen: () => void;
}) {
  const where = surface === 'browser' ? `${agentName}’s browser` : `${agentName}’s computer`;
  const caption = address || (surface === 'browser' ? 'Browser' : 'Desktop');
  const label = live
    ? `${where}, live${address ? ` on ${address}` : ''}. Open the computer to watch or take over.`
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
      <span className="live-card-screen">
        {src ? (
          <img src={src} alt="" draggable={false} />
        ) : (
          <span className="live-card-empty">
            <Icon name={surface === 'browser' ? 'globe' : 'monitor'} size={20} />
          </span>
        )}
        {live ? (
          <span className="live-card-badge" aria-hidden="true">
            <span className="live-card-dot" />
            Live
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
