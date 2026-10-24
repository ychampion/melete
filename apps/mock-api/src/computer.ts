/**
 * The agent's computer in the mock: the browser page a scenario opened, the commands it ran, and
 * a person taking the browser over and handing it back. The live view relays a fixed picture of
 * the page, repainted after each batch of input, since nothing here drives a real browser.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as C from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ProcessesMock } from './processes.ts';
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
  readonly processes = new ProcessesMock();

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

  /** A picture of the computer's screen as it is now, kept as an artifact; null when it has none. */
  shot(chatId: string): string | null {
    if (!this.enabled) return null;
    const id = `art_shot_${chatId}_${this.computer(chatId).terminal.length}`;
    if (!this.store.artifacts.has(id)) {
      const bytes = PICTURES.booking.png;
      this.store.artifacts.set(id, {
        artifact: {
          id,
          space_id: this.spaceId,
          job_id: null,
          path: `artifacts/screens/${id}.png`,
          content_hash: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
          mime: 'image/png',
          size: bytes.length,
          audience: 'owner',
          created_at: this.now(),
        },
        bytes,
      });
    }
    return id;
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
      processes: this.processes.list(),
      available: { browser: this.enabled, terminal: this.enabled },
    });
  }

  /**
   * Saved sign-ins as the mock keeps them: in memory, with what was typed for
   * a password or code secret dropped on arrival, since nothing here signs in.
   */
  private mountSignIns(app: Hono): void {
    const signIns = new Map<string, C.SavedSignIn>();
    const fail = (c: Context, status: 400 | 404 | 409, code: string, message: string) =>
      c.json({ error: { code, message } }, status);
    const originOf = (site: string): string | null => {
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`);
        return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
      } catch {
        return null;
      }
    };
    const missing = (c: Context) =>
      fail(c, 404, 'not_found', 'There is no such saved sign-in of yours here.');
    app.get('/sign-ins', (c) =>
      c.json(C.savedSignInList.parse({ sign_ins: [...signIns.values()] })),
    );
    app.post('/sign-ins', async (c) => {
      const body = C.savedSignInCreate.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return fail(c, 400, 'invalid_request', 'Check the sign-in and try again.');
      const origin = originOf(body.data.site);
      if (!origin)
        return fail(
          c,
          400,
          'insecure_site',
          'Saved sign-ins are only used on secure (https) sites.',
        );
      const site = new URL(origin).host;
      const taken = [...signIns.values()].some(
        (s) => s.origin === origin && s.username === body.data.username,
      );
      if (taken)
        return fail(
          c,
          409,
          'duplicate',
          'A sign-in for this site with that username is already saved.',
        );
      const now = this.now();
      const saved = C.savedSignIn.parse({
        id: newId(C.ID_PREFIXES.saved_sign_in),
        origin,
        site,
        label: body.data.label ?? site,
        username: body.data.username,
        password: C.PASSWORD_MASK,
        has_code: Boolean(body.data.code_secret),
        policy: body.data.policy,
        created_at: now,
        updated_at: now,
        last_used_at: null,
        last_outcome: null,
      });
      signIns.set(saved.id, saved);
      return c.json(saved, 201);
    });
    app.patch('/sign-ins/:id', async (c) => {
      const found = signIns.get(c.req.param('id'));
      if (!found) return missing(c);
      const change = C.savedSignInUpdate.safeParse(await c.req.json().catch(() => null));
      if (!change.success)
        return fail(c, 400, 'invalid_request', 'Check the sign-in and try again.');
      const code = change.data.code_secret;
      const next = C.savedSignIn.parse({
        ...found,
        username: change.data.username ?? found.username,
        label: change.data.label ?? found.label,
        policy: change.data.policy ?? found.policy,
        has_code: code === null ? false : Boolean(code) || found.has_code,
        updated_at: this.now(),
      });
      signIns.set(next.id, next);
      return c.json(next);
    });
    app.delete('/sign-ins/:id', (c) => {
      const id = c.req.param('id');
      if (!signIns.delete(id)) return missing(c);
      return c.json(C.savedSignInDeleted.parse({ id, deleted: true }));
    });
    app.post('/sign-ins/:id/code', (c) => {
      const found = signIns.get(c.req.param('id'));
      if (!found) return missing(c);
      if (!found.has_code) return fail(c, 404, 'no_code', 'This sign-in has no code secret saved.');
      // A stand-in code that changes every thirty seconds, as a real one would.
      const seconds = Math.floor(Date.now() / 1000);
      const code = String((Math.floor(seconds / 30) * 7919) % 1_000_000).padStart(6, '0');
      return c.json(C.savedSignInCode.parse({ code, expires_in: 30 - (seconds % 30) }));
    });
    app.post('/sign-ins/:id/check', (c) => {
      const found = signIns.get(c.req.param('id'));
      if (!found) return missing(c);
      const checks = [
        { name: 'site', ok: true, detail: `Used only on ${found.origin}.` },
        { name: 'sealed', ok: true, detail: 'It opens with this installation’s key.' },
        { name: 'password', ok: true, detail: 'A password is saved.' },
        ...(found.has_code
          ? [{ name: 'code', ok: true, detail: 'Its code secret makes codes.' }]
          : []),
      ];
      return c.json(C.savedSignInCheck.parse({ id: found.id, ok: true, checks }));
    });
  }

  /** `link`: each chat has a desktop shown through its provider's own viewer, as on Maritime. */
  desktop: 'none' | 'link' = 'none';
  private readonly desktops = new Map<
    string,
    { id: string; control: 'agent' | 'human'; epoch: number }
  >();

  /** The routes of a desktop shown through its provider's viewer; nothing when there is none. */
  private mountDesktop(app: Hono): void {
    if (this.desktop !== 'link' || !this.enabled) return;
    const desktopOf = (jobId: string) => {
      let found = this.desktops.get(jobId);
      if (!found) {
        found = { id: `sbx_${jobId}`, control: 'agent', epoch: 0 };
        this.desktops.set(jobId, found);
      }
      return found;
    };
    const byId = (id: string) => [...this.desktops.values()].find((each) => each.id === id);
    const refuse = (c: Context, status: 404 | 409, code: string, message: string) =>
      c.json({ error: { code, message } }, status);
    app.get('/sandbox/computers', (c) => {
      const jobId = c.req.query('job_id') ?? '';
      const found = desktopOf(jobId);
      return c.json(
        C.sandboxComputerList.parse({
          computers: [
            {
              session_id: found.id,
              job_id: jobId,
              agent_id: null,
              status: 'ready',
              running: true,
              control: found.control,
              control_epoch: found.epoch,
              viewport: { width: 1200, height: 750 },
              egress: 'open',
              view: 'link',
            },
          ],
        }),
      );
    });
    for (const operation of ['takeover', 'handback'] as const)
      app.post(`/sandbox/sessions/:id/${operation}`, (c) => {
        const found = byId(c.req.param('id') ?? '');
        if (!found)
          return refuse(c, 404, 'session_not_found', 'That computer is no longer running.');
        found.control = operation === 'takeover' ? 'human' : 'agent';
        found.epoch += 1;
        return c.json(
          C.sandboxControlResponse.parse({
            session_id: found.id,
            control: found.control,
            control_epoch: found.epoch,
          }),
        );
      });
    app.post('/sandbox/sessions/:id/viewer', async (c) => {
      const found = byId(c.req.param('id') ?? '');
      if (!found) return refuse(c, 404, 'session_not_found', 'That computer is no longer running.');
      const { mode } = C.sandboxViewerRequest.parse(await c.req.json().catch(() => ({})));
      if (mode === 'control' && found.control !== 'human')
        return refuse(
          c,
          409,
          'agent_control',
          'The agent is using the computer. Take over first to use it yourself.',
        );
      c.header('cache-control', 'no-store');
      return c.json(
        C.sandboxViewerResponse.parse({
          mode,
          url: `${new URL(c.req.url).origin}/mock-viewer/${mode}?t=${randomBytes(8).toString('hex')}`,
          expires_at: new Date(Date.now() + (mode === 'control' ? 300 : 600) * 1000).toISOString(),
        }),
      );
    });
    // The page a viewer link opens: the provider's viewer, here a stand-in.
    app.get('/mock-viewer/:mode', (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Desktop viewer</title><body style="font:16px system-ui;margin:2rem">The provider's ${c.req.param('mode') === 'control' ? 'control' : 'watch'} viewer would show the desktop here.</body>`,
      ),
    );
  }

  mount(app: Hono): void {
    this.processes.mount(app);
    this.mountDesktop(app);
    // The sites the browser stays signed in to, served only where there is a browser.
    if (this.enabled) {
      const sites = new Map(
        [
          { domain: 'github.com', label: 'GitHub', last_used: this.now() },
          { domain: 'united.com', label: 'United Airlines', last_used: this.now() },
        ].map((site) => [site.domain, site]),
      );
      app.get('/browser/sites', (c) =>
        c.json(C.browserSiteList.parse({ sites: [...sites.values()] })),
      );
      app.delete('/browser/sites/:domain', (c) => {
        const domain = c.req.param('domain');
        if (!sites.delete(domain))
          return c.json(
            { error: { code: 'invalid_domain', message: 'Not a signed-in site.' } },
            400,
          );
        return c.json(C.browserSiteForgotten.parse({ domain, forgotten: true }));
      });
      this.mountSignIns(app);
    }
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
