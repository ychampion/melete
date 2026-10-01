/**
 * A person's side of an agent's computer: finding it, watching it, taking it
 * over and handing it back.
 *
 * The computer is the desktop in the job's docker sandbox. Watching needs no
 * control: the agent keeps working while its owner looks on. Taking over moves
 * the control epoch on and parks the job waiting for input before it answers,
 * so every computer action the agent planned is refused from then on (see
 * `connectors/sandbox-computer.ts`); input from the live view is accepted only
 * while the person holds control. Handing back moves the epoch on again; the
 * job stays parked until the person answers it.
 *
 * The live channel uses the browser live view's wire shapes: `LiveOpen`, a
 * Server-Sent Events stream of `LiveDown` frames, and `LiveUp` input. Its id is
 * held in memory only and bound to the principal, the computer, the epoch and
 * the address it was opened from; every request checks all four and the
 * person's authority over the job again. Frames are JPEGs of the whole desktop,
 * paced, at most two unacknowledged, written through and never stored. Nothing
 * the person types is logged, recorded on the timeline or kept.
 */
import { randomBytes } from 'node:crypto';
import {
  LIVE_LIMITS,
  LIVE_PRESENCE,
  LIVE_VIEWPORT,
  type LiveDown,
  type LiveEndCode,
  type LiveOpen,
  liveClose,
  liveId,
  liveOpen,
  liveUp,
  type SandboxComputer,
  SSE_KEEPALIVE,
  sandboxComputerList,
  sandboxComputerQuery,
  sandboxControlResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { appendEvent } from '../broker/records.ts';
import { lockEventOrderIn } from '../db/transaction.ts';
import { liveFrame, requestPeer } from '../workers/browser/live-service.ts';
import { type DockerSandboxProvider, isDesktopProvider } from './adapters/docker.ts';
import { type ComputerControls, computerControls } from './computer-control.ts';
import type { SandboxProviders } from './wiring.ts';

/** Frames a second from the desktop: enough to follow a pointer, within the live byte budget. */
const LIVE_FPS = 4;

export class ComputerFault extends Error {
  override readonly name = 'ComputerFault';
  constructor(
    readonly reason:
      | 'session_not_found'
      | 'live_taken'
      | 'live_closed'
      | 'not_you'
      | 'origin_refused'
      | 'agent_control'
      | 'epoch_changed'
      | 'slow_down'
      | 'no_desktop',
  ) {
    super(reason);
  }
}

const STATUS = {
  session_not_found: 404,
  live_taken: 409,
  live_closed: 410,
  not_you: 403,
  origin_refused: 403,
  agent_control: 409,
  epoch_changed: 409,
  slow_down: 429,
  no_desktop: 409,
} as const;

type Binding = {
  sessionId: string;
  sandbox: string;
  spaceId: string;
  jobId: string;
  agentId: string | null;
  status: 'ready' | 'paused';
  egress: 'deny_all' | 'open';
  provider: DockerSandboxProvider;
};

type Stream = { write: (event: LiveDown) => void; keepalive: () => void; close: () => void };

type Channel = {
  id: string;
  sessionId: string;
  sandbox: string;
  principalId: string;
  epoch: number;
  peer: string;
  openedAt: number;
  ack: number;
  seq: number;
  lastInputAt: number;
  askedStillThere: boolean;
  inputs: number[];
  stream?: Stream;
  detachedAt: number;
  pump?: AbortController;
  ended: boolean;
  timer?: ReturnType<typeof setInterval>;
};

/** Browser reads of the stream must come from this API, as its writes already must. */
function sameOrigin(c: Context): boolean {
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin;
}

export type SandboxComputerOptions = {
  now?: () => number;
  controls?: ComputerControls;
  presence?: Partial<typeof LIVE_PRESENCE>;
  fps?: number;
};

export class SandboxComputerService {
  /** Attempts fenced by a takeover, for the runner to interrupt. */
  onPark?: (jobId: string, attemptIds: string[]) => void;
  private readonly byId = new Map<string, Channel>();
  private readonly bySandbox = new Map<string, Channel>();
  private readonly now: () => number;
  private readonly controls: ComputerControls;
  private readonly presence: typeof LIVE_PRESENCE;
  private readonly fps: number;

  constructor(
    private readonly sql: Sql,
    private readonly providers: SandboxProviders,
    options: SandboxComputerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.controls = options.controls ?? computerControls;
    this.presence = { ...LIVE_PRESENCE, ...options.presence };
    this.fps = options.fps ?? LIVE_FPS;
    // Any change of hands ends the view opened under the epoch before it.
    this.controls.onChange((sandbox) => {
      const channel = this.bySandbox.get(sandbox);
      if (channel && !channel.ended) this.finish(channel, 'epoch_changed');
    });
  }

  /** Whether this principal owns the job, in a space they may still use. */
  private async owns(jobId: string, principalId: string): Promise<boolean> {
    const [owned] = await this.sql`select 1 from job j join space s on s.id = j.space_id
      where j.id = ${jobId}
        and coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId}
        and ((s.kind = 'personal'
            and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
          or (s.kind = 'shared' and exists (select 1 from space_membership m
            where m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null)))`;
    return Boolean(owned);
  }

  private providerOf(connectionId: string): DockerSandboxProvider | null {
    const held = this.providers().get(connectionId)?.provider;
    return held && isDesktopProvider(held) ? held : null;
  }

  private bindingOf(row: Record<string, unknown>): Binding | null {
    const provider = this.providerOf(String(row.connection_id));
    const egress = (row.egress_policy as { kind?: string } | null)?.kind;
    if (!provider || !row.job_id) return null;
    return {
      sessionId: String(row.id),
      sandbox: String(row.provider_sandbox_id),
      spaceId: String(row.space_id),
      jobId: String(row.job_id),
      agentId: (row.agent_id as string | null) ?? null,
      status: row.status === 'ready' ? 'ready' : 'paused',
      egress: egress === 'open' ? 'open' : 'deny_all',
      provider,
    };
  }

  /** The computer a person may steer, or a refusal that reads as an absent session. */
  async steerable(sessionId: string, principalId: string): Promise<Binding> {
    const [row] = await this.sql`select id, connection_id, space_id, job_id, agent_id, status,
        provider_sandbox_id, egress_policy
      from sandbox_session where id = ${sessionId} and status in ('ready', 'paused')`;
    const binding = row ? this.bindingOf(row) : null;
    if (!binding || !(await this.owns(binding.jobId, principalId)))
      throw new ComputerFault('session_not_found');
    return binding;
  }

  async list(jobId: string, principalId: string): Promise<SandboxComputer[]> {
    if (!(await this.owns(jobId, principalId))) throw new ComputerFault('session_not_found');
    const rows = await this.sql`select id, connection_id, space_id, job_id, agent_id, status,
        provider_sandbox_id, egress_policy
      from sandbox_session
      where job_id = ${jobId} and status in ('ready', 'paused')
      order by opened_at desc limit 16`;
    const computers: SandboxComputer[] = [];
    for (const row of rows) {
      const binding = this.bindingOf(row);
      if (!binding) continue;
      const running = await binding.provider
        .running(
          { providerSandboxId: binding.sandbox, imageDigest: null, region: null },
          AbortSignal.timeout(10_000),
        )
        .catch(() => false);
      const held = this.controls.state(binding.sandbox);
      computers.push({
        session_id: binding.sessionId,
        job_id: binding.jobId,
        agent_id: binding.agentId,
        status: binding.status,
        running,
        control: held.control,
        control_epoch: held.epoch,
        viewport: { width: LIVE_VIEWPORT.width, height: LIVE_VIEWPORT.height },
        egress: binding.egress,
      });
    }
    return computers;
  }

  async control(sessionId: string, operation: 'takeover' | 'handback', principalId: string) {
    const binding = await this.steerable(sessionId, principalId);
    const next = this.controls.change(
      binding.sandbox,
      operation === 'takeover' ? 'human' : 'agent',
    );
    if (operation === 'takeover') await this.park(binding);
    else
      await this.sql.begin(async (tx) => {
        await lockEventOrderIn(tx);
        await appendEvent(tx, binding.jobId, null, 'notice', {
          kind: 'computer_handback',
          session_id: binding.sessionId,
          control_epoch: next.epoch,
        });
      });
    return { session_id: binding.sessionId, control: next.control, control_epoch: next.epoch };
  }

  /** Fence the job's attempts and park it for the person, before the takeover answers. */
  private async park(binding: Binding): Promise<void> {
    const reason = 'human_control';
    const fenced = await this.sql.begin(async (tx) => {
      // Before the job lock, as every event writer does: event order is commit order.
      await lockEventOrderIn(tx);
      const [job] =
        await tx`select id, space_id, state, wait from job where id = ${binding.jobId} for update`;
      if (
        !job ||
        job.space_id !== binding.spaceId ||
        ['completed', 'cancelled', 'failed'].includes(job.state)
      )
        return [];
      if (job.state === 'waiting_for_input' && job.wait?.question?.startsWith('Computer control:'))
        return [];
      const state =
        job.state === 'needs_reconciliation' ? 'needs_reconciliation' : 'waiting_for_input';
      const wait =
        state === 'needs_reconciliation'
          ? job.wait
          : {
              kind: 'user_input',
              question:
                'Computer control: a person has taken over the computer. Continue when they hand it back and answer, starting from a fresh screenshot.',
            };
      await tx`update job set state = ${state}, wait = ${JSON.stringify(wait)}::jsonb,
        lease_epoch = lease_epoch + 1, state_version = state_version + 1,
        next_wake_at = null, updated_at = now() where id = ${binding.jobId}`;
      const detail = { kind: 'computer_control', session_id: binding.sessionId, reason };
      const attempts = await tx`update attempt set outcome = 'fenced',
        outcome_detail = ${JSON.stringify(detail)}::jsonb,
        ended_at = now(), lease_expires_at = null, lease_status = 'ended'
        where job_id = ${binding.jobId} and ended_at is null returning id`;
      for (const attempt of attempts)
        await appendEvent(
          tx,
          binding.jobId,
          attempt.id,
          'attempt_ended',
          detail,
          `${attempt.id}:ended`,
        );
      await appendEvent(tx, binding.jobId, null, 'job_state_changed', {
        from: job.state,
        to: state,
        reason,
        session_id: binding.sessionId,
      });
      return attempts.map((attempt) => String(attempt.id));
    });
    if (fenced.length) this.onPark?.(binding.jobId, fenced);
  }

  // ---- live view ------------------------------------------------------------

  async open(sessionId: string, principalId: string, peer: string): Promise<LiveOpen> {
    const binding = await this.steerable(sessionId, principalId);
    const held = this.controls.state(binding.sandbox);
    const current = this.bySandbox.get(binding.sandbox);
    if (current && !current.ended) {
      const recent =
        current.stream !== undefined ||
        this.now() - current.detachedAt < this.presence.reconnect_ms;
      if (current.epoch === held.epoch && recent) throw new ComputerFault('live_taken');
      this.finish(current, 'closed');
    }
    const channel: Channel = {
      id: randomBytes(32).toString('base64url'),
      sessionId,
      sandbox: binding.sandbox,
      principalId,
      epoch: held.epoch,
      peer,
      openedAt: this.now(),
      ack: 0,
      seq: 0,
      lastInputAt: this.now(),
      askedStillThere: false,
      inputs: [],
      detachedAt: this.now(),
      ended: false,
    };
    this.byId.set(channel.id, channel);
    this.bySandbox.set(binding.sandbox, channel);
    channel.timer = setInterval(() => this.tick(channel), 1000);
    channel.timer.unref?.();
    return {
      live_id: channel.id,
      control_epoch: held.epoch,
      viewport: { width: LIVE_VIEWPORT.width, height: LIVE_VIEWPORT.height },
      site_scope: [],
      expires_at: new Date(channel.openedAt + LIVE_LIMITS.takeover_ms).toISOString(),
    };
  }

  private async bound(c: Context, sessionId: string, id: string) {
    if (!sameOrigin(c)) throw new ComputerFault('origin_refused');
    const principalId = c.get('owner').id as string;
    const binding = await this.steerable(sessionId, principalId);
    const channel = this.byId.get(id);
    if (!channel || channel.ended || channel.sessionId !== sessionId)
      throw new ComputerFault('live_closed');
    if (channel.principalId !== principalId || channel.peer !== requestPeer(c))
      throw new ComputerFault('not_you');
    if (this.controls.state(binding.sandbox).epoch !== channel.epoch) {
      this.finish(channel, 'epoch_changed');
      throw new ComputerFault('epoch_changed');
    }
    return { channel, binding };
  }

  async frames(c: Context, sessionId: string, id: string, lastEventId: number): Promise<Response> {
    const { channel, binding } = await this.bound(c, sessionId, id);
    this.detach(channel);
    channel.ack = Math.max(channel.ack, lastEventId);
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    let attached: Stream | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The viewer is gone; the pump notices when its signal ends.
          }
        };
        const stream: Stream = {
          write: (event) => send(liveFrame(event)),
          keepalive: () => send(SSE_KEEPALIVE),
          close: () => {
            try {
              controller.close();
            } catch {
              // Already closed by the viewer leaving.
            }
          },
        };
        attached = stream;
        channel.stream = stream;
        channel.detachedAt = 0;
        const leave = () => {
          if (channel.stream === stream) this.detach(channel);
        };
        signal.addEventListener('abort', leave, { once: true });
        if (signal.aborted) leave();
        void this.pump(channel, stream, binding);
      },
      cancel: () => {
        if (channel.stream === attached) this.detach(channel);
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  }

  /** Relays desktop frames to one attached viewer until it leaves or the channel ends. */
  private async pump(channel: Channel, stream: Stream, binding: Binding): Promise<void> {
    const controller = new AbortController();
    channel.pump?.abort();
    channel.pump = controller;
    const handle = { providerSandboxId: binding.sandbox, imageDigest: null, region: null };
    const keepalive = setInterval(() => stream.keepalive(), 15_000);
    try {
      for await (const jpeg of binding.provider.frames(handle, this.fps, controller.signal)) {
        if (channel.stream !== stream || channel.ended) break;
        binding.provider.touch(handle);
        // At most two unacknowledged frames; a slow viewer is shown the newest when it catches up.
        if (channel.seq - channel.ack >= LIVE_LIMITS.unacked_frames) continue;
        channel.seq += 1;
        stream.write({
          type: 'frame',
          seq: channel.seq,
          data: Buffer.from(jpeg).toString('base64'),
          meta: {
            device_width: LIVE_VIEWPORT.width,
            device_height: LIVE_VIEWPORT.height,
            page_scale: 1,
            offset_top: 0,
            scroll_x: 0,
            scroll_y: 0,
          },
        });
      }
    } catch {
      // The desktop went away: the view ends rather than hanging open on nothing.
      if (!channel.ended && channel.stream === stream) this.finish(channel, 'session_not_found');
    } finally {
      clearInterval(keepalive);
      controller.abort();
    }
  }

  async input(c: Context, sessionId: string, body: unknown): Promise<{ accepted: number }> {
    const request = liveUp.parse(body);
    const { channel, binding } = await this.bound(c, sessionId, request.live_id);
    channel.ack = Math.max(channel.ack, request.ack_through);
    if (!request.events.length) return { accepted: 0 };
    if (this.controls.state(binding.sandbox).control !== 'human')
      throw new ComputerFault('agent_control');
    const now = this.now();
    channel.inputs = channel.inputs.filter((at) => now - at < 1000);
    if (channel.inputs.length + request.events.length > LIVE_LIMITS.input_events_per_second) {
      this.finish(channel, 'slow_down');
      throw new ComputerFault('slow_down');
    }
    for (const _ of request.events) channel.inputs.push(now);
    channel.lastInputAt = now;
    channel.askedStillThere = false;
    await binding.provider.computer(
      { providerSandboxId: binding.sandbox, imageDigest: null, region: null },
      { kind: 'input', events: request.events },
      AbortSignal.timeout(20_000),
    );
    return { accepted: request.events.length };
  }

  async close(c: Context, sessionId: string, body: unknown): Promise<{ closed: true }> {
    const request = liveClose.parse(body);
    const { channel } = await this.bound(c, sessionId, request.live_id);
    this.finish(channel, 'closed');
    return { closed: true };
  }

  /** Ends the view that has run its course; called every second while it is open. */
  tick(channel: Channel): void {
    const ending = this.ending(channel);
    if (ending) {
      this.finish(channel, ending);
      return;
    }
    if (channel.ended || this.controls.state(channel.sandbox).control !== 'human') return;
    const idle = this.now() - channel.lastInputAt;
    if (idle >= this.presence.still_there_ms && !channel.askedStillThere) {
      channel.askedStillThere = true;
      channel.stream?.write({ type: 'notice', code: 'still_there' });
    }
  }

  private ending(channel: Channel): LiveEndCode | null {
    if (channel.ended) return null;
    const now = this.now();
    if (now - channel.openedAt >= LIVE_LIMITS.takeover_ms) return 'live_timeout';
    if (!channel.stream && now - channel.detachedAt >= this.presence.reconnect_ms) return 'closed';
    // A watcher is not expected to type; a person holding control is.
    if (this.controls.state(channel.sandbox).control !== 'human') return null;
    return now - channel.lastInputAt >= this.presence.idle_close_ms ? 'live_idle' : null;
  }

  private detach(channel: Channel): void {
    const stream = channel.stream;
    channel.stream = undefined;
    channel.pump?.abort();
    if (!stream) return;
    channel.detachedAt = this.now();
    stream.close();
  }

  private finish(channel: Channel, code: LiveEndCode): void {
    if (channel.ended) return;
    channel.ended = true;
    clearInterval(channel.timer);
    if (this.byId.get(channel.id) === channel) this.byId.delete(channel.id);
    if (this.bySandbox.get(channel.sandbox) === channel) this.bySandbox.delete(channel.sandbox);
    channel.stream?.write({ type: 'ended', code });
    this.detach(channel);
  }
}

/** What each refusal tells the person, in words rather than its code. */
const REFUSAL_TEXT: Record<ComputerFault['reason'], string> = {
  session_not_found: 'That computer is no longer running.',
  live_taken: 'Someone else is already watching this computer.',
  live_closed: 'The live view has closed. Open it again.',
  not_you: 'Only the person this job belongs to can watch or control its computer.',
  origin_refused: 'This request did not come from the Melete app.',
  agent_control: 'The agent is using the computer. Take over first to use it yourself.',
  epoch_changed: 'Control of the computer changed. Try again.',
  slow_down: 'Too many inputs at once. Slow down a little.',
  no_desktop: 'This computer has no desktop to show.',
};

function refused(error: unknown): never {
  if (error instanceof ComputerFault)
    throw new ServiceError(error.reason, REFUSAL_TEXT[error.reason], STATUS[error.reason]);
  throw error;
}

/** Mounted after the owner session and same-origin middleware, like the browser's routes. */
export function mountSandboxComputers(app: Hono, service: SandboxComputerService) {
  const id = (c: Context) => c.req.param('id') ?? '';
  app.get('/sandbox/computers', async (c) => {
    const query = sandboxComputerQuery.parse({ job_id: c.req.query('job_id') });
    const computers = await service
      .list(query.job_id, c.get('owner').id)
      .catch((error: unknown) => refused(error));
    return c.json(sandboxComputerList.parse({ computers }));
  });
  for (const operation of ['takeover', 'handback'] as const)
    app.post(`/sandbox/sessions/:id/${operation}`, async (c) => {
      if (!sameOrigin(c)) refused(new ComputerFault('origin_refused'));
      const changed = await service
        .control(id(c), operation, c.get('owner').id)
        .catch((error: unknown) => refused(error));
      return c.json(sandboxControlResponse.parse(changed));
    });
  app.post('/sandbox/sessions/:id/live', async (c) => {
    if (!sameOrigin(c)) refused(new ComputerFault('origin_refused'));
    const opened = await service
      .open(id(c), c.get('owner').id, requestPeer(c))
      .catch((error: unknown) => refused(error));
    return c.json(liveOpen.parse(opened));
  });
  app.get('/sandbox/sessions/:id/live/frames', async (c) => {
    const resume = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0);
    return service
      .frames(
        c,
        id(c),
        liveId.parse(c.req.query('live_id')),
        Number.isSafeInteger(resume) && resume > 0 ? resume : 0,
      )
      .catch((error: unknown) => refused(error));
  });
  app.post('/sandbox/sessions/:id/live/input', async (c) =>
    c.json(
      await service.input(c, id(c), await c.req.json()).catch((error: unknown) => refused(error)),
    ),
  );
  app.post('/sandbox/sessions/:id/live/close', async (c) =>
    c.json(
      await service.close(c, id(c), await c.req.json()).catch((error: unknown) => refused(error)),
    ),
  );
}
