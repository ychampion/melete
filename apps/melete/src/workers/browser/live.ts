import { randomBytes } from 'node:crypto';
import type { CDPSession, Frame, Page } from 'playwright';
import type { BrowserEgress } from './egress.ts';
import {
  hostOf,
  LIVE_LIMITS,
  LIVE_VIEWPORT,
  type LiveDown,
  type LiveEndCode,
  LiveFrameBudget,
  type LiveInput,
  LiveInputLimiter,
  LiveNetworkBudget,
  type LiveNoticeCode,
  type LiveOpen,
  LiveSiteScope,
} from './live-protocol.ts';
import {
  type BrowserControlChange,
  BrowserFault,
  type BrowserSession,
  type BrowserSessions,
} from './sessions.ts';

/** What the live channel needs from the controller that owns the lease. */
export type LiveHost = {
  readonly sessions: BrowserSessions;
  guard(): BrowserEgress | undefined;
  /** Make a page the leased page, as when a person ends a takeover in a popup. */
  adoptPage(page: Page): void;
};

type HeldFrame = Extract<LiveDown, { type: 'frame' }> & { ack: number };
type Screen = { page: Page; cdp: CDPSession; release: () => void };

/** Budgets and limits that last for one takeover epoch, across the channels opened under it. */
type Takeover = {
  epoch: number;
  startedAt: number;
  popups: number;
  frames: LiveFrameBudget;
  network: LiveNetworkBudget;
};

type Channel = {
  id: string;
  sessionId: string;
  epoch: number;
  takeover: Takeover;
  scope: LiveSiteScope;
  limiter: LiveInputLimiter;
  main: Page;
  popup?: Page;
  screen?: Screen;
  switching: Promise<void>;
  inputs: Promise<unknown>;
  seq: number;
  /** Received and not yet delivered, then delivered and not yet acknowledged: two at most. */
  pending: HeldFrame[];
  delivered: HeldFrame[];
  events: LiveDown[];
  noticed: Set<string>;
  buttons: number;
  ended?: LiveEndCode;
  endDelivered: boolean;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
};

const BUTTON_NAMES = ['left', 'middle', 'right'] as const;
// Chromium's pressed-buttons mask orders right before middle.
const BUTTON_BITS = [1, 4, 2] as const;
const TOUCH_TYPES = { start: 'touchStart', move: 'touchMove', end: 'touchEnd' } as const;
const EVENT_LIMIT = 64;

/**
 * A person's live view of the leased page while they hold control: frames down, typed input up.
 * Frames and typed text exist only in memory here and in the Chromium page they reach.
 */
export class BrowserLive {
  private channel?: Channel;
  private takeover?: Takeover;
  private readonly counts = { frames: 0, frame_bytes: 0, max_held_frames: 0, inputs: 0 };
  private readonly now: () => number;

  constructor(
    private readonly host: LiveHost,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    host.sessions.onControl((change, session) => this.controlChanged(change, session));
  }

  /** Counters for this worker process and the current takeover's page network use. */
  usage() {
    return {
      ...this.counts,
      requests: this.takeover?.network.requests ?? 0,
      network_bytes: this.takeover?.network.bytes ?? 0,
    };
  }

  async open(sessionId: string, epoch: number): Promise<LiveOpen> {
    const sessions = this.host.sessions;
    sessions.checkHumanControl(sessionId, epoch);
    const current = this.channel;
    if (current && !current.ended) {
      if (current.epoch === epoch) throw new BrowserFault('live_taken');
      await this.end(current, 'epoch_changed');
    }
    // A command queued before the takeover finishes (refused by its epoch) before the window opens.
    await sessions.exclusive(async () => {});
    sessions.checkHumanControl(sessionId, epoch);
    if (this.channel && !this.channel.ended) throw new BrowserFault('live_taken');
    const page = sessions.page;
    const guard = this.host.guard();
    if (!page || !sessions.context || !sessions.policy || !guard)
      throw new BrowserFault('session_not_found');
    if (this.takeover?.epoch !== epoch)
      this.takeover = {
        epoch,
        startedAt: this.now(),
        popups: 0,
        frames: new LiveFrameBudget(this.now),
        network: new LiveNetworkBudget(),
      };
    const takeover = this.takeover;
    const remaining = takeover.startedAt + LIVE_LIMITS.takeover_ms - this.now();
    // At the cap the channel closes and control stays with the person until they hand back.
    if (remaining <= 0) throw new BrowserFault('live_timeout');
    if (!guard.idle) throw new BrowserFault('network_busy');
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel: Channel = {
      id: randomBytes(32).toString('base64url'),
      sessionId,
      epoch,
      takeover,
      scope: new LiveSiteScope(sessions.policy.allowed_domains, page.url()),
      limiter: new LiveInputLimiter(this.now),
      main: page,
      switching: Promise.resolve(),
      inputs: Promise.resolve(),
      seq: 0,
      pending: [],
      delivered: [],
      events: [],
      noticed: new Set(),
      buttons: 0,
      endDelivered: false,
      release,
      waiters: new Set(),
    };
    this.channel = channel;
    void guard
      .run(
        'human',
        () => released,
        undefined,
        () => sessions.checkHumanControl(sessionId, epoch),
        {
          scope: channel.scope,
          budget: takeover.network,
          notice: (code, host) => this.notice(channel, code, host),
        },
      )
      .catch(() => this.end(channel, 'closed'));
    channel.timer = setTimeout(() => void this.end(channel, 'live_timeout'), remaining);
    channel.timer.unref();
    try {
      await this.switchTo(channel, page);
      sessions.humanActivity(sessionId, epoch);
    } catch (error) {
      await this.end(channel, 'closed');
      throw error;
    }
    return {
      live_id: channel.id,
      control_epoch: epoch,
      viewport: { ...LIVE_VIEWPORT },
      site_scope: channel.scope.list(),
      expires_at: new Date(this.now() + remaining).toISOString(),
    };
  }

  async pull(
    liveId: string,
    ackThrough: number,
    timeoutMs: number,
  ): Promise<{ events: LiveDown[] }> {
    const channel = this.find(liveId);
    const deadline = Date.now() + timeoutMs;
    this.acknowledge(channel, ackThrough);
    for (;;) {
      this.activity(channel);
      const events = this.drain(channel);
      if (events.some((event) => event.type === 'ended')) channel.endDelivered = true;
      const left = deadline - Date.now();
      if (events.length || channel.ended || left <= 0) return { events };
      // Frames held back by the per-second budget are retried as it refills.
      await this.wait(channel, channel.pending.length ? Math.min(left, 100) : left);
    }
  }

  async input(
    liveId: string,
    ackThrough: number,
    events: readonly LiveInput[],
  ): Promise<{ accepted: number }> {
    const channel = this.find(liveId);
    if (channel.ended) throw new BrowserFault('live_closed');
    this.acknowledge(channel, ackThrough);
    if (!channel.limiter.admit(events)) {
      await this.end(channel, 'slow_down');
      throw new BrowserFault('slow_down');
    }
    // Batches keep their order; each event is fenced by the epoch immediately before dispatch.
    const dispatched = channel.inputs.then(async () => {
      let accepted = 0;
      for (const event of events) {
        await channel.switching;
        const screen = channel.screen;
        if (channel.ended || !screen) throw new BrowserFault('live_closed');
        try {
          await this.host.sessions.dispatchHumanInput(channel.sessionId, channel.epoch, () =>
            this.dispatch(channel, screen.cdp, event),
          );
        } catch (error) {
          if (error instanceof BrowserFault) await this.end(channel, endCode(error));
          throw error;
        }
        accepted++;
        this.counts.inputs++;
      }
      return { accepted };
    });
    channel.inputs = dispatched.catch(() => {});
    return dispatched;
  }

  async allow(liveId: string, host: string): Promise<{ site_scope: string[] }> {
    const channel = this.find(liveId);
    if (channel.ended) throw new BrowserFault('live_closed');
    this.activity(channel);
    const decision = channel.scope.allow(host);
    if (decision === 'off_scope') throw new BrowserFault('invalid_host');
    if (decision === 'scope_full') throw new BrowserFault('scope_full');
    return { site_scope: channel.scope.list() };
  }

  async close(liveId: string): Promise<{ closed: true }> {
    await this.end(this.find(liveId), 'closed');
    return { closed: true };
  }

  /** The controller offers every new page here first; a live channel adopts one popup at a time. */
  popup(page: Page): boolean {
    const channel = this.channel;
    if (!channel || channel.ended) return false;
    if (channel.popup || channel.takeover.popups >= LIVE_LIMITS.popups_per_takeover) {
      this.notice(channel, 'popup_limit');
      return false;
    }
    channel.takeover.popups++;
    channel.popup = page;
    page.once('close', () => {
      if (channel.popup !== page) return;
      channel.popup = undefined;
      if (!channel.ended) void this.switchTo(channel, channel.main).catch(() => {});
    });
    void this.switchTo(channel, page).catch(() => {});
    return true;
  }

  private find(liveId: string): Channel {
    const channel = this.channel;
    if (!channel || channel.id !== liveId || channel.endDelivered)
      throw new BrowserFault('live_closed');
    return channel;
  }

  private activity(channel: Channel): void {
    if (channel.ended) return;
    try {
      this.host.sessions.humanActivity(channel.sessionId, channel.epoch);
    } catch (error) {
      if (!(error instanceof BrowserFault)) throw error;
      void this.end(channel, endCode(error));
    }
  }

  private switchTo(channel: Channel, page: Page): Promise<void> {
    const next = channel.switching.then(async () => {
      if (channel.ended || page.isClosed()) return;
      const previous = channel.screen;
      channel.screen = undefined;
      if (previous) await this.detach(channel, previous);
      const context = this.host.sessions.context;
      if (!context) throw new BrowserFault('session_not_found');
      const cdp = await context.newCDPSession(page);
      if (channel.ended) {
        await cdp.detach().catch(() => {});
        return;
      }
      const navigated = (frame: Frame) => {
        if (frame === page.mainFrame()) this.where(channel, page);
      };
      const loaded = () => this.where(channel, page);
      page.on('framenavigated', navigated);
      page.on('domcontentloaded', loaded);
      const screen: Screen = {
        page,
        cdp,
        release: () => {
          page.off('framenavigated', navigated);
          page.off('domcontentloaded', loaded);
        },
      };
      channel.screen = screen;
      cdp.on('Page.screencastFrame', (frame) => {
        if (channel.screen !== screen) {
          void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
          return;
        }
        channel.pending.push({
          type: 'frame',
          seq: ++channel.seq,
          data: frame.data,
          ack: frame.sessionId,
          meta: {
            device_width: frame.metadata.deviceWidth,
            device_height: frame.metadata.deviceHeight,
            page_scale: frame.metadata.pageScaleFactor,
            offset_top: frame.metadata.offsetTop,
            scroll_x: frame.metadata.scrollOffsetX,
            scroll_y: frame.metadata.scrollOffsetY,
          },
        });
        // Chromium sends a third frame before it waits, so the oldest held frame makes room.
        while (channel.pending.length + channel.delivered.length > LIVE_LIMITS.unacked_frames) {
          const released = channel.delivered.shift() ?? channel.pending.shift();
          if (released)
            void cdp.send('Page.screencastFrameAck', { sessionId: released.ack }).catch(() => {});
        }
        this.counts.max_held_frames = Math.max(
          this.counts.max_held_frames,
          channel.pending.length + channel.delivered.length,
        );
        this.wake(channel);
      });
      cdp.on('Page.fileChooserOpened', () => this.notice(channel, 'upload_refused'));
      await cdp.send('Page.enable');
      // The chooser is cancelled in the page as well as not shown: no host file can be picked.
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: LIVE_VIEWPORT.width,
        maxHeight: LIVE_VIEWPORT.height,
        everyNthFrame: 1,
      });
      this.where(channel, page);
    });
    channel.switching = next.catch(() => {});
    return next;
  }

  private async detach(channel: Channel, screen: Screen): Promise<void> {
    screen.release();
    channel.pending = [];
    channel.delivered = [];
    await screen.cdp.send('Page.stopScreencast').catch(() => {});
    await screen.cdp.detach().catch(() => {});
  }

  private where(channel: Channel, page: Page): void {
    const url = page.url();
    void page
      .title()
      .catch(() => '')
      .then((title) => {
        if (channel.ended || channel.screen?.page !== page) return;
        const host = hostOf(url);
        this.push(channel, {
          type: 'where',
          url,
          title,
          in_scope: host !== undefined && channel.scope.admits(host),
        });
      });
  }

  private drain(channel: Channel): LiveDown[] {
    const events = channel.events.splice(0);
    while (!channel.ended && channel.pending[0]) {
      const frame = channel.pending[0];
      const decision = channel.takeover.frames.take(frame.data.length);
      if (decision === 'wait') break;
      if (decision === 'exhausted') {
        void this.end(channel, 'live_budget');
        events.push(...channel.events.splice(0));
        break;
      }
      channel.pending.shift();
      channel.delivered.push(frame);
      const { ack: _ack, ...down } = frame;
      events.push(down);
      this.counts.frames++;
      this.counts.frame_bytes += frame.data.length;
    }
    return events;
  }

  private acknowledge(channel: Channel, through: number): void {
    const screen = channel.screen;
    while (channel.delivered[0] && channel.delivered[0].seq <= through) {
      const frame = channel.delivered.shift();
      if (frame && screen)
        void screen.cdp.send('Page.screencastFrameAck', { sessionId: frame.ack }).catch(() => {});
    }
  }

  private async dispatch(channel: Channel, cdp: CDPSession, event: LiveInput): Promise<void> {
    switch (event.k) {
      case 'move':
      case 'down':
      case 'up': {
        const bit = BUTTON_BITS[event.button];
        if (event.k === 'down') channel.buttons |= bit;
        if (event.k === 'up') channel.buttons &= ~bit;
        await cdp.send('Input.dispatchMouseEvent', {
          type:
            event.k === 'move'
              ? 'mouseMoved'
              : event.k === 'down'
                ? 'mousePressed'
                : 'mouseReleased',
          x: event.x,
          y: event.y,
          modifiers: event.mods,
          button: event.k === 'move' ? 'none' : BUTTON_NAMES[event.button],
          buttons: channel.buttons,
          clickCount: event.k === 'move' ? 0 : event.clicks,
        });
        return;
      }
      case 'wheel':
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x,
          y: event.y,
          deltaX: event.dx,
          deltaY: event.dy,
          modifiers: event.mods,
          buttons: channel.buttons,
        });
        return;
      case 'key':
        await cdp.send(
          'Input.dispatchKeyEvent',
          event.down
            ? {
                type: event.text ? 'keyDown' : 'rawKeyDown',
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.vk,
                nativeVirtualKeyCode: event.vk,
                modifiers: event.mods,
                text: event.text,
                unmodifiedText: event.text,
              }
            : {
                type: 'keyUp',
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.vk,
                nativeVirtualKeyCode: event.vk,
                modifiers: event.mods,
              },
        );
        return;
      case 'text':
        await cdp.send('Input.insertText', { text: event.text });
        return;
      case 'touch':
        await cdp.send('Input.dispatchTouchEvent', {
          type: TOUCH_TYPES[event.phase],
          touchPoints: event.points.map((point) => ({ id: point.id, x: point.x, y: point.y })),
        });
        return;
    }
  }

  private notice(channel: Channel, code: LiveNoticeCode, host?: string): void {
    if (channel.ended) return;
    // One notice per kind and host is enough for the panel to explain what did not load.
    const key = `${code} ${host ?? ''}`;
    if (!channel.noticed.has(key)) {
      channel.noticed.add(key);
      this.push(
        channel,
        host === undefined ? { type: 'notice', code } : { type: 'notice', code, host },
      );
    }
    if (code === 'live_budget') void this.end(channel, 'live_budget');
  }

  private push(channel: Channel, event: LiveDown): void {
    if (event.type === 'where')
      channel.events = channel.events.filter((queued) => queued.type !== 'where');
    channel.events.push(event);
    if (channel.events.length > EVENT_LIMIT)
      channel.events.splice(0, channel.events.length - EVENT_LIMIT);
    this.wake(channel);
  }

  private wait(channel: Channel, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        channel.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      channel.waiters.add(done);
    });
  }

  private wake(channel: Channel): void {
    for (const waiter of [...channel.waiters]) waiter();
  }

  private async end(channel: Channel, code: LiveEndCode): Promise<void> {
    if (channel.ended) return;
    channel.ended = code;
    clearTimeout(channel.timer);
    channel.release();
    channel.events.push({ type: 'ended', code });
    this.wake(channel);
    const screen = channel.screen;
    channel.screen = undefined;
    if (screen) await this.detach(channel, screen);
  }

  private async controlChanged(change: BrowserControlChange, session: BrowserSession) {
    const channel = this.channel;
    if (channel && (change === 'closed' || session.control_epoch !== channel.epoch))
      await this.end(channel, change === 'closed' ? 'session_not_found' : 'epoch_changed');
    if (change === 'takeover') return;
    this.takeover = undefined;
    if (change === 'handback') await this.settle(channel);
  }

  /** At handback the page the person ended on becomes the leased page; every other page closes. */
  private async settle(channel: Channel | undefined): Promise<void> {
    const sessions = this.host.sessions;
    const context = sessions.context;
    if (!context) return;
    const popup = channel?.popup;
    const kept = popup && !popup.isClosed() ? popup : sessions.page;
    if (!kept) return;
    if (kept !== sessions.page) this.host.adoptPage(kept);
    await Promise.all(
      context
        .pages()
        .filter((page) => page !== kept)
        .map((page) => page.close().catch(() => {})),
    );
  }
}

function endCode(error: BrowserFault): LiveEndCode {
  if (error.reason === 'session_not_found') return 'session_not_found';
  if (error.reason === 'epoch_changed' || error.reason === 'not_human_control')
    return 'epoch_changed';
  return 'closed';
}
