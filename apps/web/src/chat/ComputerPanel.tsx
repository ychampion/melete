/**
 * The agent's computer, beside the conversation: the page its browser is on,
 * the desktop in its sandbox and the commands it ran, read from the service and
 * refreshed while the panel is open. The person can watch the desktop live,
 * take the browser or the desktop over, steer it through a live view, and hand
 * it back. Both live views use the same wire shapes, so one screen draws both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, IconButton } from '../design/primitives.tsx';
import { AgentAvatar } from '../experience/AgentAvatar.tsx';
import { adapter, followLive, type LiveDown } from '../experience/adapter.ts';
import type {
  Agent,
  AgentComputer,
  ComputerBrowser,
  ComputerCommand,
  LiveInput,
  SandboxComputer,
} from '../experience/types.ts';
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import {
  ESCAPE_TWICE_MS,
  keyInput,
  modsOf,
  pagePoint,
  pasteInput,
  pointerButton,
  shownAddress,
} from './live.ts';
import './computer.css';

const POLL_MS = 3000;

/**
 * The conversation's computer while the panel is open: read at once, again
 * whenever `pulse` changes (a tool entry arrived on the stream), and every few
 * seconds besides, so a page that changes without a tool entry still shows.
 */
export function useComputer(conversationId: string | null, open: boolean, pulse: string) {
  const [computer, setComputer] = useState<AgentComputer | null>(null);
  const [desktop, setDesktop] = useState<SandboxComputer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useRef(0);
  const refresh = useCallback(async () => {
    if (!conversationId) return;
    const ticket = ++read.current;
    // A conversation is its job, so the job's sandbox desktop is asked for by the same id.
    const [result, desktops] = await Promise.all([
      adapter.computer(conversationId),
      adapter.sandboxComputers(conversationId),
    ]);
    // An older read that lands after a newer one is dropped.
    if (ticket !== read.current) return;
    if (result.data) {
      setComputer(result.data);
      setError(null);
    } else setError(result.error ?? result.unavailable);
    // No desktop is the common case (no sandbox, or one without a desktop), not an error.
    setDesktop(desktops.data?.computers[0] ?? null);
  }, [conversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pulse is the reload trigger
  useEffect(() => {
    if (!open || !conversationId) return;
    void refresh();
  }, [open, conversationId, pulse, refresh]);
  useEffect(() => {
    if (!open || !conversationId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, conversationId, refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another conversation starts from nothing
  useEffect(() => {
    setComputer(null);
    setDesktop(null);
    setError(null);
  }, [conversationId]);
  return { computer, desktop, error, refresh };
}

type LiveSurface = 'browser' | 'sandbox';

/** The routes behind each live view; their requests and answers have the same shapes. */
const LIVE_ROUTES = {
  browser: { open: adapter.liveOpen, input: adapter.liveInput, close: adapter.liveClose },
  sandbox: {
    open: adapter.sandboxLiveOpen,
    input: adapter.sandboxLiveInput,
    close: adapter.sandboxLiveClose,
  },
} as const;

/**
 * Per browser session, the last open or close of its live view. Each waits for the one before,
 * so a view is let go before the next opens, and before the browser is handed back.
 */
const liveTurns = new Map<string, Promise<unknown>>();
/** How long the live view may show nothing before it says so. */
const LIVE_WAIT_MS = 10_000;

const turnKey = (surface: LiveSurface, sessionId: string) => `${surface}:${sessionId}`;

type Notice = { code: string; host?: string } | null;
const ENDED_WORDS: Record<string, string> = {
  live_idle: 'The live view closed after a quiet spell. You still have control.',
  live_timeout: 'The live view reached its time limit. You still have control.',
  live_budget: 'The live view used its allowance for this takeover. You still have control.',
  slow_down: 'Too much input arrived at once, so the live view closed. You still have control.',
  epoch_changed: 'Control changed hands, so this live view closed.',
  session_not_found: 'The browser is no longer running.',
  closed: 'The live view closed. You still have control.',
};

/** Ended-view words for a person who is only watching: they never had control to keep. */
const watchingWords = (words: string) => words.replace(' You still have control.', '');

/**
 * A live view of the page while the person holds the browser, or of the
 * desktop, which may also be watched while the agent drives it. Frames come
 * down one stream and are painted as they arrive; pointer, wheel, keys and
 * paste go up in small batches with the last frame painted, which is what
 * lets the next frame through. While only watching, nothing but that
 * acknowledgement goes up.
 */
function LiveScreen({
  sessionId,
  title,
  onWhere,
  surface: kind = 'browser',
  interactive = true,
}: {
  sessionId: string;
  title: string;
  onWhere: (where: { url: string; title: string }) => void;
  surface?: LiveSurface;
  /** False while the agent drives the desktop and the person watches. */
  interactive?: boolean;
}) {
  const routes = LIVE_ROUTES[kind];
  const turns = turnKey(kind, sessionId);
  const [frame, setFrame] = useState<{ seq: number; src: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // No picture after a while is said plainly, with a way to try again.
  const [late, setLate] = useState(false);
  const liveRef = useRef<string | null>(null);
  const painted = useRef(0);
  const queue = useRef<LiveInput[]>([]);
  const sending = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMove = useRef(0);
  const lastEscape = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const whereRef = useRef(onWhere);
  whereRef.current = onWhere;

  const flush = useCallback(() => {
    timer.current = null;
    const liveId = liveRef.current;
    if (!liveId) return;
    const events = queue.current.splice(0, 200);
    const ack = painted.current;
    sending.current = sending.current.then(async () => {
      const result = await routes.input(sessionId, {
        live_id: liveId,
        ack_through: ack,
        events,
      });
      if (result.error && events.length) setNotice({ code: 'input_refused' });
    });
  }, [sessionId, routes]);
  const schedule = useCallback(() => {
    if (timer.current === null) timer.current = setTimeout(flush, 30);
  }, [flush]);
  const send = useCallback(
    (event: LiveInput | null) => {
      if (!event || !liveRef.current || !interactive) return;
      queue.current.push(event);
      if (notice?.code === 'still_there') setNotice(null);
      schedule();
    },
    [schedule, notice, interactive],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reopens the view
  useEffect(() => {
    const abort = new AbortController();
    let liveId: string | null = null;
    setEnded(null);
    setNotice(null);
    const handle = (event: LiveDown) => {
      if (event.type === 'frame')
        setFrame({ seq: event.seq, src: `data:image/jpeg;base64,${event.data}` });
      else if (event.type === 'where') whereRef.current({ url: event.url, title: event.title });
      else if (event.type === 'notice') setNotice({ code: event.code, host: event.host });
      else if (event.type === 'ended') {
        liveRef.current = null;
        liveId = null;
        setEnded(endedWords(event.code));
      }
    };
    const opening = (liveTurns.get(turns) ?? Promise.resolve()).then(async () => {
      // A view another tab still holds is let go shortly, so a refusal is tried again.
      for (let tries = 0; tries < 4 && !abort.signal.aborted; tries++) {
        const opened = await routes.open(sessionId);
        if (abort.signal.aborted) {
          if (opened.data) await routes.close(sessionId, opened.data.live_id);
          return;
        }
        if (opened.data) {
          liveId = opened.data.live_id;
          break;
        }
        if (tries === 3) {
          setEnded(opened.error ?? opened.unavailable ?? 'The live view could not open.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    });
    liveTurns.set(turns, opening);
    void (async () => {
      await opening;
      if (!liveId || abort.signal.aborted) return;
      liveRef.current = liveId;
      painted.current = 0;
      try {
        for await (const event of followLive(sessionId, liveId, abort.signal, kind)) {
          handle(event);
          if (event.type === 'ended') return;
        }
        if (!abort.signal.aborted) setEnded(endedWords('closed'));
      } catch {
        if (!abort.signal.aborted) setEnded(endedWords('closed'));
      }
    })();
    return () => {
      abort.abort();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      queue.current = [];
      liveRef.current = null;
      // Closed on its turn: after the open under way, if any, has settled.
      liveTurns.set(
        turns,
        opening.then(() => (liveId ? routes.close(sessionId, liveId) : undefined)),
      );
    };
  }, [sessionId, attempt, kind]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt waits afresh
  useEffect(() => {
    setLate(false);
    if (frame || ended) return;
    const timer = setTimeout(() => setLate(true), LIVE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [frame === null, ended, attempt]);

  // The wheel is taken from the page around it, which a passive React listener cannot do.
  useEffect(() => {
    const node = surface.current;
    if (!node || !interactive) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const { x, y } = pagePoint(node.getBoundingClientRect(), event.clientX, event.clientY);
      const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, Math.round(value)));
      send({
        k: 'wheel',
        x,
        y,
        dx: clamp(event.deltaX),
        dy: clamp(event.deltaY),
        mods: modsOf(event),
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [send, interactive]);

  function endedWords(code: string): string {
    const words = ENDED_WORDS[code] ?? ENDED_WORDS.closed ?? 'The live view closed.';
    return interactive ? words : watchingWords(words);
  }

  const pointer = (kind: 'down' | 'up' | 'move') => (event: React.PointerEvent<HTMLDivElement>) => {
    const node = surface.current;
    if (!node) return;
    if (kind === 'move') {
      const now = performance.now();
      if (now - lastMove.current < 50) return;
      lastMove.current = now;
    }
    if (kind === 'down') {
      node.focus();
      node.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    const { x, y } = pagePoint(node.getBoundingClientRect(), event.clientX, event.clientY);
    send({
      k: kind,
      x,
      y,
      button: pointerButton(event.button),
      mods: modsOf(event),
      clicks: event.detail >= 3 ? 3 : event.detail === 2 ? 2 : 1,
    });
  };
  const key = (down: boolean) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (down && event.key === 'Escape') {
      const now = performance.now();
      if (now - lastEscape.current < ESCAPE_TWICE_MS) {
        lastEscape.current = 0;
        // Out of the page and on to the control bar below it.
        const next =
          surface.current
            ?.closest('.computer-window')
            ?.querySelector<HTMLElement>('.computer-foot button') ??
          surface.current
            ?.closest('.computer-panel')
            ?.querySelector<HTMLElement>('.computer-foot button');
        next?.focus();
        return;
      }
      lastEscape.current = now;
    }
    // Copy and paste stay with the person's own browser; the paste is sent as text.
    if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'x'].includes(event.key.toLowerCase()))
      return;
    // The page has the keys: no shortcut of this app acts on them.
    event.preventDefault();
    event.stopPropagation();
    send(keyInput(event, down));
  };

  const allow = async (host: string) => {
    const liveId = liveRef.current;
    if (!liveId) return;
    const result = await adapter.liveScope(sessionId, liveId, host);
    if (result.data) setNotice(null);
    else toast({ kind: 'err', title: result.error ?? 'That site could not be allowed' });
  };

  const picture = frame ? (
    <img
      src={frame.src}
      alt=""
      draggable={false}
      onLoad={() => {
        if (frame.seq > painted.current) {
          painted.current = frame.seq;
          schedule();
        }
      }}
    />
  ) : late && !ended ? (
    <span className="computer-wait computer-wait-late" role="status">
      <span>{title ? `${title} didn’t load.` : 'The live view didn’t load.'}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={(event) => {
          event.stopPropagation();
          setAttempt((n) => n + 1);
        }}
      >
        Try again
      </Button>
    </span>
  ) : ended ? null : (
    <span className="computer-wait" role="status">
      <Icon name="loader" size={16} className="spin" />
      Opening the live view…
    </span>
  );
  // Live is said only once a picture is coming through.
  const badge = frame ? (
    <span className="computer-live-badge" aria-hidden="true">
      Live
    </span>
  ) : null;

  return (
    <div className="computer-live">
      {interactive ? null : (
        <div
          className="computer-surface"
          role="img"
          aria-label={`${title || 'The desktop'}, live. Take over to use it yourself.`}
        >
          {picture}
          {badge}
        </div>
      )}
      <div
        ref={surface}
        hidden={!interactive}
        className="computer-surface"
        role="application"
        aria-roledescription="live page"
        aria-label={`${title || 'The page'}. Keys you press go to the page. Press Escape twice to leave it.`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the live page must take keyboard focus
        tabIndex={0}
        onPointerDown={pointer('down')}
        onPointerUp={pointer('up')}
        onPointerMove={pointer('move')}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={key(true)}
        onKeyUp={key(false)}
        onPaste={(event) => {
          event.preventDefault();
          send(pasteInput(event.clipboardData.getData('text/plain')));
        }}
      >
        {interactive ? picture : null}
        {interactive ? badge : null}
      </div>
      {notice?.code === 'off_scope' && notice.host ? (
        <div className="computer-notice" role="status">
          <Icon name="globe" size={14} />
          <span className="grow">The page wants to open {notice.host}.</span>
          <Button size="sm" variant="ghost" onClick={() => void allow(notice.host ?? '')}>
            Allow {notice.host}
          </Button>
        </div>
      ) : notice?.code === 'still_there' ? (
        <div className="computer-notice" role="status">
          <Icon name="clock" size={14} />
          Still there? Press a key or click the page to keep the live view open.
        </div>
      ) : notice ? (
        <div className="computer-notice" role="status">
          <Icon name="info" size={14} />
          {notice.code === 'input_refused'
            ? 'The page did not take that input.'
            : 'The page tried something this takeover does not allow, so it was stopped.'}
        </div>
      ) : null}
      {ended ? (
        <div className="computer-notice" role="status">
          <Icon name="info" size={14} />
          <span className="grow">{ended}</span>
          <Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            Open the live view
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BrowserView({
  browser,
  agentName,
  live,
  releasing,
  onWhere,
}: {
  browser: ComputerBrowser;
  agentName: string;
  live: { url: string; title: string } | null;
  /** The live view is being let go, ahead of a hand-back. */
  releasing: boolean;
  onWhere: (where: { url: string; title: string }) => void;
}) {
  const yours = browser.control === 'you';
  const address = shownAddress(yours && live ? live.url : browser.url);
  const title = (yours && live ? live.title : browser.title) ?? '';
  return (
    <section className="computer-window" aria-label="Browser">
      <div className="computer-bar">
        <Icon name="globe" size={14} />
        <span className="computer-address clamp1" title={address}>
          {address || 'No page yet'}
        </span>
      </div>
      {title ? <div className="computer-title clamp1">{title}</div> : null}
      {yours && releasing ? (
        <div className="computer-screen">
          <span className="computer-wait">Handing the browser back…</span>
        </div>
      ) : yours ? (
        <LiveScreen sessionId={browser.session_id} title={title} onWhere={onWhere} />
      ) : (
        <div className="computer-screen">
          {browser.screenshot ? (
            <img
              src={adapter.artifactUrl(browser.screenshot.artifact_id)}
              alt={title ? `The page ${agentName} is on: ${title}` : `The page ${agentName} is on`}
            />
          ) : (
            <span className="computer-wait">No picture of this page yet.</span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The desktop in the agent's sandbox. While the agent drives it the person
 * may watch it live; taking over parks the job until it is handed back, and
 * only then do pointer and keys reach the desktop.
 */
function DesktopView({
  desktop,
  agentName,
  working,
  onChanged,
}: {
  desktop: SandboxComputer;
  agentName: string;
  /** Whether the agent is at work in this chat right now; unknown reads as at work. */
  working: boolean;
  onChanged: () => void;
}) {
  const yours = desktop.control === 'human';
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of hands starts from what the service says
  useEffect(() => {
    setReleasing(false);
  }, [desktop.session_id, desktop.control_epoch]);
  const change = async (to: 'take' | 'give') => {
    setBusy(true);
    if (to === 'give') {
      // The live view closes first; a hand-back ends it anyway, and a late close would be refused.
      setReleasing(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await liveTurns.get(turnKey('sandbox', desktop.session_id));
    }
    const result =
      to === 'take'
        ? await adapter.sandboxTakeOver(desktop.session_id)
        : await adapter.sandboxHandBack(desktop.session_id);
    setBusy(false);
    if (result.data === null) {
      setReleasing(false);
      toast({
        kind: 'err',
        title:
          result.error ??
          result.unavailable ??
          (to === 'take' ? 'Couldn’t take over' : 'Couldn’t hand back'),
      });
      return;
    }
    toast({
      kind: 'ok',
      title: to === 'take' ? 'You have the computer' : `${agentName} has the computer again`,
    });
    // The desktop stays on screen after a hand-back, now watched.
    setWatching(to === 'give' || watching);
    onChanged();
  };
  return (
    <section className="computer-window" aria-label="Desktop">
      <div className="computer-bar">
        <Icon name="monitor" size={14} />
        <span className="computer-address clamp1">
          {desktop.running ? 'Desktop' : 'Desktop · stopped until it is used'}
        </span>
      </div>
      {yours && releasing ? (
        <div className="computer-screen">
          <span className="computer-wait">Handing the computer back…</span>
        </div>
      ) : yours || watching ? (
        <LiveScreen
          // Control moving changes the epoch, which ends a view; a new one opens.
          key={`${desktop.session_id}:${desktop.control_epoch}`}
          surface="sandbox"
          sessionId={desktop.session_id}
          title={`${agentName}’s desktop`}
          interactive={yours}
          onWhere={() => {}}
        />
      ) : (
        <div className="computer-screen">
          <span className="computer-wait">
            {desktop.running
              ? `Watch to see ${agentName}’s desktop live.`
              : `The computer is stopped. It starts again when ${agentName} uses it.`}
          </span>
        </div>
      )}
      <div className="computer-foot" data-control={yours ? 'you' : 'agent'}>
        <span className="computer-holder">
          <span className="computer-dot" aria-hidden="true" />
          <span className="col" style={{ gap: 0, minWidth: 0 }}>
            <span className="computer-holder-name">
              {yours
                ? 'You have control'
                : working
                  ? `${agentName} has control`
                  : `${agentName} isn’t using it now`}
            </span>
            <span className="computer-holder-sub">
              {yours
                ? `${agentName} waits until you hand it back.`
                : 'Take over to use the desktop yourself.'}
            </span>
          </span>
        </span>
        {yours ? (
          <Button icon="arrowUpRight" disabled={busy} onClick={() => void change('give')}>
            Hand back
          </Button>
        ) : (
          <>
            {desktop.running ? (
              <Button
                variant="ghost"
                disabled={busy}
                aria-pressed={watching}
                onClick={() => setWatching((now) => !now)}
              >
                {watching ? 'Stop watching' : 'Watch'}
              </Button>
            ) : null}
            <Button icon="hand" variant="ghost" disabled={busy} onClick={() => void change('take')}>
              Take over
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function Terminal({ commands }: { commands: ComputerCommand[] }) {
  return (
    <section className="computer-terminal" aria-label="Terminal">
      <div className="computer-terminal-head">
        <Icon name="terminal" size={14} />
        Terminal
      </div>
      <ol className="computer-log">
        {commands.map((entry) => (
          <li key={entry.id} className="computer-command" data-status={entry.status}>
            <pre className="computer-cmd">
              <span aria-hidden="true">$ </span>
              {entry.command}
            </pre>
            {entry.output ? <pre className="computer-out">{entry.output}</pre> : null}
            <span className="computer-exit">
              {entry.status === 'running'
                ? 'Running…'
                : entry.status === 'unknown'
                  ? 'Unclear whether it finished'
                  : entry.status === 'failed'
                    ? 'Did not run'
                    : entry.exit_code && entry.exit_code !== 0
                      ? `Exit code ${entry.exit_code}`
                      : 'Done'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function computerEmptyWords(
  agentName: string,
  available: AgentComputer['available'],
): { title: string; body: string; connect: boolean } {
  if (!available.browser && !available.terminal)
    return {
      title: `${agentName} has no computer yet`,
      body: `Connect a browser or a sandbox and you can watch ${agentName} work here, and take over the browser at any time. A browser comes with a service that runs the browser worker; a sandbox is added in Connections.`,
      connect: true,
    };
  const missing = !available.browser
    ? ` This service runs no browser worker, so ${agentName} cannot browse yet.`
    : !available.terminal
      ? ` To let ${agentName} run commands, add a sandbox in Connections.`
      : '';
  return {
    title: `Nothing on ${agentName}’s computer yet`,
    body: `When ${agentName} opens a page or runs a command in this chat, it shows here, and you can take over the browser at any time.${missing}`,
    connect: !available.terminal,
  };
}

export function ComputerPanel({
  agent,
  computer,
  desktop = null,
  error,
  working = true,
  onClose,
  onChanged,
}: {
  agent: Agent | null;
  computer: AgentComputer | null;
  /** The desktop in the job's sandbox, when it has one. */
  desktop?: SandboxComputer | null;
  error: string | null;
  /** Whether the agent is at work in this chat right now. While it is idle, nothing says it has control. */
  working?: boolean;
  onClose: () => void;
  /** Control changed; the computer is read again. */
  onChanged: () => void;
}) {
  const agentName = agent?.name ?? 'Melete';
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [live, setLive] = useState<{ url: string; title: string } | null>(null);
  const browser = computer?.browser ?? null;
  const sessionId = browser?.session_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session or control starts from the recorded page
  useEffect(() => {
    setLive(null);
    setReleasing(false);
  }, [sessionId, browser?.control]);
  const change = async (to: 'take' | 'give') => {
    if (!browser) return;
    setBusy(true);
    if (to === 'give') {
      // The live view closes first; a hand-back ends it anyway, and a late close would be refused.
      setReleasing(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await liveTurns.get(browser.session_id);
    }
    const result =
      to === 'take'
        ? await adapter.takeOver(browser.session_id)
        : await adapter.handBack(browser.session_id);
    setBusy(false);
    if (result.data === null) {
      setReleasing(false);
      toast({
        kind: 'err',
        title:
          result.error ??
          result.unavailable ??
          (to === 'take' ? 'Couldn’t take over' : 'Couldn’t hand back'),
      });
      return;
    }
    toast({
      kind: 'ok',
      title: to === 'take' ? 'You have the browser' : `${agentName} has the browser again`,
    });
    onChanged();
  };
  const empty = computer && !browser && !desktop && computer.terminal.length === 0;
  const words = computer ? computerEmptyWords(agentName, computer.available) : null;
  return (
    <aside className="side-panel computer-panel" aria-label={`${agentName}’s computer`}>
      <div className="computer-head">
        {agent ? <AgentAvatar agent={agent} size={24} /> : <Icon name="monitor" size={18} />}
        <span className="computer-name clamp1">{agentName}’s computer</span>
        <div className="grow" />
        <IconButton name="x" label="Close the computer" onClick={onClose} />
      </div>
      <div className="computer-body">
        {error && !computer ? (
          <div className="marker" role="status">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        {!computer && !error ? (
          <span className="computer-wait">
            <Icon name="loader" size={16} />
            Looking at {agentName}’s computer…
          </span>
        ) : null}
        {empty && words ? (
          <div className="computer-empty">
            <span className="computer-empty-mark" aria-hidden="true">
              <Icon name="monitor" size={22} />
            </span>
            <h2>{words.title}</h2>
            <p>{words.body}</p>
            {words.connect ? (
              <a className="section-link" href={href('/settings/connections')}>
                Open Connections
                <Icon name="chevronRight" size={13} />
              </a>
            ) : null}
          </div>
        ) : null}
        {browser ? (
          <BrowserView
            browser={browser}
            agentName={agentName}
            live={live}
            releasing={releasing}
            onWhere={setLive}
          />
        ) : null}
        {desktop ? (
          <DesktopView
            desktop={desktop}
            agentName={agentName}
            working={working}
            onChanged={onChanged}
          />
        ) : null}
        {computer && computer.terminal.length > 0 ? (
          <Terminal commands={computer.terminal} />
        ) : null}
      </div>
      {browser ? (
        <div className="computer-foot" data-control={browser.control}>
          <span className="computer-holder">
            <span className="computer-dot" aria-hidden="true" />
            <span className="col" style={{ gap: 0, minWidth: 0 }}>
              <span className="computer-holder-name">
                {browser.control === 'you'
                  ? 'You have control'
                  : working
                    ? `${agentName} has control`
                    : `${agentName} isn’t using it now`}
              </span>
              <span className="computer-holder-sub">
                {browser.control === 'you'
                  ? `${agentName} waits until you hand it back.`
                  : 'Take over to use the browser yourself.'}
              </span>
            </span>
          </span>
          {browser.control === 'you' ? (
            <Button icon="arrowUpRight" disabled={busy} onClick={() => void change('give')}>
              Hand back
            </Button>
          ) : (
            <Button icon="hand" variant="ghost" disabled={busy} onClick={() => void change('take')}>
              Take over
            </Button>
          )}
        </div>
      ) : null}
    </aside>
  );
}
