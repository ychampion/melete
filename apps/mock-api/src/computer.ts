/**
 * The agent's computer in the mock: the browser page a scenario opened, the commands it ran, and
 * a person taking the browser over and handing it back. The live view relays a fixed picture of
 * the page, repainted after each batch of input, since nothing here drives a real browser.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as C from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Scenario } from './scenario.ts';
import type { Store } from './store.ts';
import { newId } from './store.ts';

type Step = Scenario['steps'][number];
type BrowserStep = Extract<Step, { step: 'browser' }>;
type ToolStep = Extract<Step, { step: 'tool' }>;
type Picture = 'booking' | 'reserved';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/computer/${name}`, import.meta.url)));
const PICTURES: Record<Picture, { png: Uint8Array; jpeg: string }> = {
  booking: {
    png: fixture('booking.png'),
    jpeg: Buffer.from(fixture('booking.jpg')).toString('base64'),
  },
  reserved: {
    png: fixture('reserved.png'),
    jpeg: Buffer.from(fixture('reserved.jpg')).toString('base64'),
  },
};

type Session = {
  id: string;
  chatId: string;
  control: 'automation' | 'human';
  epoch: number;
  url: string;
  title: string;
  picture: Picture;
  live?: { id: string; seq: number; repaint?: () => void };
};
type Computer = { sessionId: string | null; terminal: C.ComputerCommand[] };

const TERMINAL = /^(terminal|exec)\./;
const addressOf = (value: string) => (/^https?:\/\//i.test(value) ? value : `https://${value}`);

export class ComputerMock {
  private readonly computers = new Map<string, Computer>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly store: Store,
    private readonly spaceId: string,
    /** Off, the mock has neither a browser nor a sandbox, as a fresh install would not. */
    readonly enabled: boolean,
    private readonly now: () => string,
  ) {}

  private computer(chatId: string): Computer {
    let computer = this.computers.get(chatId);
    if (!computer) {
      computer = { sessionId: null, terminal: [] };
      this.computers.set(chatId, computer);
    }
    return computer;
  }

  /** A scenario's browser step: the page the agent is on now. */
  browser(chatId: string, step: BrowserStep): void {
    if (!this.enabled) return;
    const computer = this.computer(chatId);
    let session = computer.sessionId ? this.sessions.get(computer.sessionId) : undefined;
    if (!session) {
      session = {
        id: newId('bs'),
        chatId,
        control: 'automation',
        epoch: 1,
        url: '',
        title: '',
        picture: 'booking',
      };
      this.sessions.set(session.id, session);
      computer.sessionId = session.id;
    }
    session.url = addressOf(step.url);
    session.title = step.preview.title;
    session.picture = step.status === 'done' ? 'reserved' : 'booking';
    this.store.artifacts.delete(`art_${session.id}`);
    session.live?.repaint?.();
  }

  /** A scenario's tool step that ran a command, and later its result. */
  command(chatId: string, step: ToolStep, status: C.ComputerCommand['status']): string | null {
    if (!this.enabled || !TERMINAL.test(step.name)) return null;
    const computer = this.computer(chatId);
    const entry: C.ComputerCommand = {
      id: newId('act'),
      command: String(step.arguments.command ?? '').slice(0, 2000),
      output: status === 'done' ? String(step.result.output ?? '').slice(-4000) : '',
      status,
      exit_code:
        status === 'done' && typeof step.result.exit_code === 'number'
          ? step.result.exit_code
          : null,
      started_at: this.now(),
    };
    computer.terminal = [...computer.terminal, entry].slice(-C.COMPUTER_TERMINAL_LIMIT);
    return entry.id;
  }

  finish(chatId: string, id: string, step: ToolStep): void {
    const entry = this.computer(chatId).terminal.find((item) => item.id === id);
    if (!entry) return;
    entry.status = 'done';
    entry.output = String(step.result.output ?? '').slice(-4000);
    entry.exit_code = typeof step.result.exit_code === 'number' ? step.result.exit_code : 0;
  }

  view(chatId: string): C.AgentComputer {
    const computer = this.computers.get(chatId);
    const session = computer?.sessionId ? this.sessions.get(computer.sessionId) : undefined;
    let screenshot: { artifact_id: string } | null = null;
    if (session) {
      const id = `art_${session.id}`;
      if (!this.store.artifacts.has(id)) {
        const bytes = PICTURES[session.picture].png;
        this.store.artifacts.set(id, {
          artifact: {
            id,
            space_id: this.spaceId,
            job_id: null,
            path: `artifacts/browser/${id}.png`,
            content_hash: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
            mime: 'image/png',
            size: bytes.length,
            audience: 'owner',
            created_at: this.now(),
          },
          bytes,
        });
      }
      screenshot = { artifact_id: id };
    }
    return C.agentComputer.parse({
      browser: session
        ? {
            session_id: session.id,
            control: session.control === 'human' ? 'you' : 'agent',
            url: session.url,
            title: session.title,
            screenshot,
            seen_at: this.now(),
          }
        : null,
      terminal: computer?.terminal ?? [],
      available: { browser: this.enabled, terminal: this.enabled },
    });
  }

  mount(app: Hono): void {
    const refuse = (c: Context, status: 404 | 409 | 410, code: string) =>
      c.json({ error: { code, message: `The browser could not change: ${code}.` } }, status);
    const session = (c: Context) => this.sessions.get(c.req.param('id') ?? '');
    for (const operation of ['takeover', 'handback'] as const) {
      app.post(`/browser/sessions/:id/${operation}`, (c) => {
        const found = session(c);
        if (!found) return refuse(c, 404, 'session_not_found');
        found.control = operation === 'takeover' ? 'human' : 'automation';
        found.epoch += 1;
        found.live = undefined;
        return c.json(
          C.browserControlResponse.parse({
            session_id: found.id,
            control_epoch: found.epoch,
            control: found.control,
            fresh_observation_required: true,
          }),
        );
      });
    }
    app.post('/browser/sessions/:id/live', (c) => {
      const found = session(c);
      if (!found) return refuse(c, 404, 'session_not_found');
      if (found.control !== 'human') return refuse(c, 409, 'not_human_control');
      found.live = { id: randomBytes(32).toString('base64url'), seq: 0 };
      return c.json(
        C.liveOpen.parse({
          live_id: found.live.id,
          control_epoch: found.epoch,
          viewport: C.LIVE_VIEWPORT,
          site_scope: [new URL(found.url).hostname],
          expires_at: new Date(Date.now() + C.LIVE_LIMITS.takeover_ms).toISOString(),
        }),
      );
    });
    const bound = (c: Context, liveId: unknown) => {
      const found = session(c);
      return found?.live && found.live.id === liveId ? found : undefined;
    };
    app.get('/browser/sessions/:id/live/frames', (c) => {
      const found = bound(c, c.req.query('live_id'));
      const live = found?.live;
      if (!found || !live) return refuse(c, 410, 'live_closed');
      const encoder = new TextEncoder();
      const signal = c.req.raw.signal;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (event: C.LiveDown) => {
            try {
              controller.enqueue(encoder.encode(liveFrame(event)));
            } catch {
              // The viewer left.
            }
          };
          const paint = () => {
            if (found.live !== live) {
              send({ type: 'ended', code: 'epoch_changed' });
              stop();
              return;
            }
            live.seq += 1;
            send({
              type: 'frame',
              seq: live.seq,
              data: PICTURES[found.picture].jpeg,
              meta: {
                device_width: C.LIVE_VIEWPORT.width,
                device_height: C.LIVE_VIEWPORT.height,
                page_scale: 1,
                offset_top: 0,
                scroll_x: 0,
                scroll_y: 0,
              },
            });
          };
          const timer = setInterval(() => {
            if (found.live !== live) paint();
            else controller.enqueue(encoder.encode(C.SSE_KEEPALIVE));
          }, 2000);
          const stop = () => {
            clearInterval(timer);
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          };
          signal.addEventListener('abort', stop, { once: true });
          live.repaint = paint;
          send({ type: 'where', url: found.url, title: found.title, in_scope: true });
          paint();
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      });
    });
    app.post('/browser/sessions/:id/live/input', async (c) => {
      const parsed = C.liveUp.safeParse(await c.req.json().catch(() => null));
      const found = parsed.success ? bound(c, parsed.data.live_id) : undefined;
      if (!parsed.success || !found) return refuse(c, 410, 'live_closed');
      // A click or a key changes what the page shows, so it is painted again.
      if (parsed.data.events.some((event) => event.k !== 'move')) found.live?.repaint?.();
      return c.json(C.liveInputResponse.parse({ accepted: parsed.data.events.length }));
    });
    app.post('/browser/sessions/:id/live/scope', async (c) => {
      const parsed = C.liveScope.safeParse(await c.req.json().catch(() => null));
      const found = parsed.success ? bound(c, parsed.data.live_id) : undefined;
      if (!parsed.success || !found) return refuse(c, 410, 'live_closed');
      return c.json(
        C.liveScopeResponse.parse({
          site_scope: [new URL(found.url).hostname, parsed.data.host],
        }),
      );
    });
    app.post('/browser/sessions/:id/live/close', async (c) => {
      const parsed = C.liveClose.safeParse(await c.req.json().catch(() => null));
      const found = parsed.success ? bound(c, parsed.data.live_id) : undefined;
      if (!parsed.success || !found) return refuse(c, 410, 'live_closed');
      found.live = undefined;
      return c.json(C.liveClosed.parse({ closed: true }));
    });
  }
}

function liveFrame(event: C.LiveDown): string {
  const id = event.type === 'frame' ? `id: ${event.seq}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
