/**
 * What every provider that keeps an agent's workspace between attempts must
 * show, through the session layer and a real database.
 *
 * The same scenarios run over the fake, over each adapter on its fixtures or
 * stand-in, and live. Ids that reach a provider are fixed, so a scenario sends
 * the same requests every time and can be replayed.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { SandboxRefusal, sandboxLabels } from './manifest.ts';
import { runCommand } from './marker.ts';
import {
  SandboxSessions,
  type SessionRow,
  sessionHandle,
  type WorkspacePersistence,
} from './sessions.ts';
import {
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from './types.ts';

export const WORKSPACE_TESTS = [
  'an agent resumes its own workspace and sees its files',
  'a workspace is not shared between two agents in the same space',
  'a second concurrent attempt for the same agent does not share the live workspace',
  'a workspace unused past retention is destroyed with its snapshot',
  'deleting a space destroys its sandboxes and snapshots',
  'a failed pause leaves the workspace running and recorded, never lost silently',
] as const;

export type WorkspaceTest = (typeof WORKSPACE_TESTS)[number];

export type WorkspaceSubject = {
  provider: SandboxProvider;
  persistence: WorkspacePersistence;
  image?: string;
  /** The next suspension fails the way this provider documents one failing. */
  failNextSuspend(): void;
  /** Whether the provider still holds a snapshot. Only asked of snapshot workspaces. */
  snapshotHeld(ref: string): Promise<boolean>;
  /** Replayed traffic cannot settle a race either way, so the open race is left out. */
  replayed: boolean;
  /** Called after every scenario, pass or fail. */
  close(): Promise<void>;
};

const SPACE = 'sp_WORKSPACES';
const CONNECTION = 'conn_WORKSPACES';
const JOB = 'job_WORKSPACES';
const AGENT_A = 'agent_WSA';
const AGENT_B = 'agent_WSB';
const RETENTION_SECONDS = 3_600;
const signal = () => AbortSignal.timeout(120_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const handleOf = (providerSandboxId: string): SandboxHandle => ({
  providerSandboxId,
  imageDigest: null,
  region: null,
});

/** Counts the calls that bring a workspace to life, and can hold one resume open. */
function watched(inner: SandboxProvider) {
  const counts = { create: 0, resume: 0 };
  let hold: Promise<void> | null = null;
  const provider: SandboxProvider = {
    capabilities: inner.capabilities,
    create: (spec, s) => {
      counts.create += 1;
      return inner.create(spec, s);
    },
    connect: (handle, s) => inner.connect(handle, s),
    exec: (handle, spec, s) => inner.exec(handle, spec, s),
    reattach: (handle, marker, s) => inner.reattach(handle, marker, s),
    putFiles: (handle, files, s) => inner.putFiles(handle, files, s),
    listFiles: (handle, root, s) => inner.listFiles(handle, root, s),
    getFile: (handle, file, max, s) => inner.getFile(handle, file, max, s),
    destroy: (handle, s) => inner.destroy(handle, s),
    inspect: (handle, s) => inner.inspect(handle, s),
    reconcile: (project, live, s) => inner.reconcile(project, live, s),
    ...(inner.pause ? { pause: (handle, s) => inner.pause?.(handle, s) as never } : {}),
    ...(inner.snapshot ? { snapshot: (handle, s) => inner.snapshot?.(handle, s) as never } : {}),
    ...(inner.deleteSnapshot
      ? { deleteSnapshot: (ref, s) => inner.deleteSnapshot?.(ref, s) as never }
      : {}),
    ...(inner.resume
      ? {
          resume: async (ref: string, spec: SandboxSpec, s: AbortSignal) => {
            counts.resume += 1;
            const waiting = hold;
            hold = null;
            if (waiting) await waiting;
            return (inner.resume as NonNullable<SandboxProvider['resume']>)(ref, spec, s);
          },
        }
      : {}),
  };
  return {
    provider,
    counts,
    holdNextResume() {
      let release: () => void = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

export function workspaceConformance(
  name: string,
  options: { sql: Sql | null; open: (test: WorkspaceTest) => Promise<WorkspaceSubject> },
): void {
  const scenario = (title: WorkspaceTest, body: (context: Context) => Promise<void>) =>
    test(title, async () => {
      const sql = options.sql;
      if (!sql) throw new Error('Postgres is unavailable');
      const subject = await options.open(title);
      const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-workspace-'));
      let failure: unknown = null;
      try {
        await body(await contextFor(sql, subject, workRoot));
      } catch (error) {
        failure = error;
      }
      try {
        await subject.close();
      } catch (error) {
        failure ??= error;
      }
      await rm(workRoot, { recursive: true, force: true });
      if (failure) throw failure;
    }, 120_000);

  (options.sql ? describe : describe.skip)(`workspace conformance: ${name}`, () => {
    beforeEach(async () => {
      if (options.sql) await options.sql`truncate space cascade`;
    });

    scenario('an agent resumes its own workspace and sees its files', async (context) => {
      const first = await context.open(AGENT_A);
      expect(first).toMatchObject({ status: 'ready', resumed: false });
      await context.write(first, '/work/notes.txt', 'remembered');
      const suspended = await context.sessions.suspendWorkspace(
        first.id,
        context.provider,
        signal(),
      );
      expect(suspended.status).toBe('paused');
      expect(suspended.resumeRef).not.toBeNull();
      const second = await context.open(AGENT_A);
      expect(second).toMatchObject({ status: 'ready', resumed: true });
      expect(second.id).not.toBe(first.id);
      expect((await context.sessions.get(first.id))?.status).toBe('closed');
      expect(await context.read(second, '/work/notes.txt')).toBe('remembered');
      await context.sessions.destroyWorkspace(second.id, context.provider, signal());
    });

    scenario('a workspace is not shared between two agents in the same space', async (context) => {
      const a = await context.open(AGENT_A);
      await context.write(a, '/work/owner.txt', 'agent-a');
      await context.sessions.suspendWorkspace(a.id, context.provider, signal());
      const b = await context.open(AGENT_B);
      expect(b.resumed).toBe(false);
      expect(b.providerSandboxId).not.toBe(a.providerSandboxId);
      expect(await context.read(b, '/work/owner.txt')).toBeNull();
      await context.write(b, '/work/owner.txt', 'agent-b');
      await context.sessions.suspendWorkspace(b.id, context.provider, signal());
      const a2 = await context.open(AGENT_A);
      expect(a2.resumed).toBe(true);
      expect(await context.read(a2, '/work/owner.txt')).toBe('agent-a');
      const b2 = await context.open(AGENT_B);
      expect(b2.resumed).toBe(true);
      expect(await context.read(b2, '/work/owner.txt')).toBe('agent-b');
      await context.sessions.destroyWorkspace(a2.id, context.provider, signal());
      await context.sessions.destroyWorkspace(b2.id, context.provider, signal());
    });

    scenario(
      'a second concurrent attempt for the same agent does not share the live workspace',
      async (context) => {
        const first = await context.open(AGENT_A);
        expect(await context.refusal(context.open(AGENT_A))).toBe('workspace_busy');
        expect(context.counts).toEqual({ create: 1, resume: 0 });
        // The index holds on its own, not only the service's check.
        const direct = await context.settled(
          context.sql`insert into sandbox_session (id, connection_id, space_id, agent_id, adapter,
              provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
            values ('sbx_WSDIRECT', ${CONNECTION}, ${SPACE}, ${AGENT_A}, 'direct', 'direct', 'base',
              '{"kind":"deny_all"}'::jsonb, ${context.subject.persistence}, 'ready', now())`,
        );
        expect(direct).toContain('sandbox_workspace_idx');
        await context.sessions.suspendWorkspace(first.id, context.provider, signal());
        // While one attempt is still bringing the workspace back, another is refused.
        const release = context.holdNextResume();
        const attempt = await context.attempt();
        const resuming = context.open(AGENT_A, attempt);
        await context.until(
          async () =>
            (
              await context.sql`select 1 from sandbox_session
                where attempt_id = ${attempt} and status = 'opening'`
            ).length > 0,
        );
        expect(await context.refusal(context.open(AGENT_A))).toBe('workspace_busy');
        release();
        const resumed = await resuming;
        expect(resumed).toMatchObject({ status: 'ready', resumed: true });
        expect(context.counts).toEqual({ create: 1, resume: 1 });
        if (!context.subject.replayed) {
          await context.sessions.suspendWorkspace(resumed.id, context.provider, signal());
          const raced = await Promise.allSettled([context.open(AGENT_A), context.open(AGENT_A)]);
          const won = raced.filter((result) => result.status === 'fulfilled');
          const lost = raced.filter((result) => result.status === 'rejected');
          expect(won).toHaveLength(1);
          expect(lost.map((result) => (result.reason as SandboxRefusal).code)).toEqual([
            'workspace_busy',
          ]);
          expect(context.counts).toEqual({ create: 1, resume: 2 });
          const winner = (won[0] as PromiseFulfilledResult<SessionRow>).value;
          await context.sessions.destroyWorkspace(winner.id, context.provider, signal());
        } else await context.sessions.destroyWorkspace(resumed.id, context.provider, signal());
        const live = await context.sql`select id from sandbox_session
          where agent_id = ${AGENT_A} and status in ('opening', 'ready', 'paused')`;
        expect(live).toHaveLength(0);
      },
    );

    scenario(
      'a workspace unused past retention is destroyed with its snapshot',
      async (context) => {
        const stale = await context.open(AGENT_A);
        await context.write(stale, '/work/old.txt', 'old');
        const staleSuspended = await context.sessions.suspendWorkspace(
          stale.id,
          context.provider,
          signal(),
        );
        const recent = await context.open(AGENT_B);
        const recentSuspended = await context.sessions.suspendWorkspace(
          recent.id,
          context.provider,
          signal(),
        );
        await context.sql`update sandbox_session
        set lease_expires_at = now() - make_interval(secs => ${RETENTION_SECONDS + 60})
        where id = ${stale.id}`;
        expect(await context.sessions.sweep(context.providerFor, signal())).toEqual([stale.id]);
        expect((await context.sessions.get(stale.id))?.status).toBe('closed');
        expect(await context.held(staleSuspended)).toBe(false);
        expect((await context.sessions.get(recent.id))?.status).toBe('paused');
        expect(await context.held(recentSuspended)).toBe(true);
        // The agent whose workspace was forgotten starts again from nothing.
        const fresh = await context.open(AGENT_A);
        expect(fresh.resumed).toBe(false);
        expect(await context.read(fresh, '/work/old.txt')).toBeNull();
        await context.sessions.destroyWorkspace(fresh.id, context.provider, signal());
        await context.sessions.destroyWorkspace(recent.id, context.provider, signal());
        expect(await context.held(recentSuspended)).toBe(false);
      },
    );

    scenario('deleting a space destroys its sandboxes and snapshots', async (context) => {
      const suspended = await context.open(AGENT_A);
      await context.write(suspended, '/work/a.txt', 'a');
      const suspendedRow = await context.sessions.suspendWorkspace(
        suspended.id,
        context.provider,
        signal(),
      );
      const running = await context.open(AGENT_B);
      await context.write(running, '/work/b.txt', 'b');
      await context.sessions.suspendWorkspace(running.id, context.provider, signal());
      const resumed = await context.open(AGENT_B);
      expect(resumed.resumed).toBe(true);
      const ephemeral = await context.sessions.open(
        {
          connectionId: CONNECTION,
          spaceId: SPACE,
          jobId: JOB,
          attemptId: await context.attempt(),
          agentId: null,
        },
        context.provider,
        context.specFor,
        signal(),
      );
      const destroyed = await context.sessions.destroyWorkspacesForSpace(
        SPACE,
        context.providerFor,
        signal(),
      );
      expect(destroyed.closed.sort()).toEqual([suspended.id, resumed.id, ephemeral.id].sort());
      await context.sql`delete from space where id = ${SPACE}`;
      expect(await context.sql`select id from sandbox_session`).toHaveLength(0);
      expect(await context.held(suspendedRow)).toBe(false);
      expect(await context.held(resumed)).toBe(false);
      expect(await context.provider.inspect(sessionHandle(ephemeral), signal())).toBe('gone');
    });

    scenario(
      'a failed pause leaves the workspace running and recorded, never lost silently',
      async (context) => {
        const workspace = await context.open(AGENT_A);
        await context.write(workspace, '/work/kept.txt', 'kept');
        context.subject.failNextSuspend();
        expect(
          await context.refusal(
            context.sessions.suspendWorkspace(workspace.id, context.provider, signal()),
          ),
        ).toBe('suspend_failed');
        const recorded = await context.sessions.get(workspace.id);
        expect(recorded?.status).toBe('ready');
        expect(recorded?.lastError).toContain('still running');
        expect(await context.provider.inspect(sessionHandle(workspace), signal())).toBe('running');
        expect(await context.read(workspace, '/work/kept.txt')).toBe('kept');
        // Still live, so still not shared.
        expect(await context.refusal(context.open(AGENT_A))).toBe('workspace_busy');
        const suspended = await context.sessions.suspendWorkspace(
          workspace.id,
          context.provider,
          signal(),
        );
        expect(suspended).toMatchObject({ status: 'paused', lastError: null });
        const resumed = await context.open(AGENT_A);
        expect(resumed.resumed).toBe(true);
        expect(await context.read(resumed, '/work/kept.txt')).toBe('kept');
        await context.sessions.destroyWorkspace(resumed.id, context.provider, signal());
      },
    );
  });
}

type Context = Awaited<ReturnType<typeof contextFor>>;

async function contextFor(sql: Sql, subject: WorkspaceSubject, workRoot: string) {
  await sql`insert into space (id, name, git_path) values (${SPACE}, 'Workspaces', '/spaces/workspaces')`;
  await sql`insert into connection (id, space_id, provider, label)
    values (${CONNECTION}, ${SPACE}, 'test', 'Workspaces')`;
  for (const agent of [AGENT_A, AGENT_B])
    await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${agent}, ${SPACE}, ${agent}, 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
  await sql`insert into job (id, space_id, title, objective) values (${JOB}, ${SPACE}, 'Job', 'Run')`;
  let attempts = 0;
  let sessionCount = 0;
  let markers = 0;
  const watch = watched(subject.provider);
  const provider = watch.provider;
  const sessions = new SandboxSessions(sql, {
    leaseSeconds: 300,
    workspaceRetentionSeconds: RETENTION_SECONDS,
    ids: () => {
      sessionCount += 1;
      return `sbx_WS${String(sessionCount).padStart(4, '0')}`;
    },
  });
  const specFor = (session: string): SandboxSpec => ({
    image: subject.image ?? 'base',
    egress: { kind: 'deny_all' },
    region: null,
    lifetimeSeconds: 600,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({ project: 'workspaces', space: SPACE, session }),
    env: {},
  });
  const context = {
    sql,
    subject,
    provider,
    sessions,
    specFor,
    counts: watch.counts,
    holdNextResume: watch.holdNextResume,
    providerFor: (adapter: string) =>
      adapter === provider.capabilities.adapter ? provider : undefined,
    async attempt() {
      attempts += 1;
      const id = `att_WS${String(attempts).padStart(4, '0')}`;
      await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${id}, ${JOB}, ${attempts}, 'fake', 'fake', 'scripted')`;
      return id;
    },
    async open(agentId: string, given?: string) {
      const attemptId = given ?? (await context.attempt());
      return sessions.openWorkspace(
        {
          connectionId: CONNECTION,
          spaceId: SPACE,
          jobId: JOB,
          attemptId,
          agentId,
          persistence: subject.persistence,
        },
        provider,
        specFor,
        signal(),
      );
    },
    async write(row: SessionRow, file: string, content: string) {
      markers += 1;
      const result = await runCommand({
        provider,
        handle: sessionHandle(row),
        request: {
          marker: `act_01J0WORKSPACEWRITE${String(markers).padStart(4, '0')}`,
          argv: ['sh', '-c', `printf '%s' '${content}' > ${file}`],
          timeoutMs: 20_000,
          dispatch: 'first',
        },
        workRoot,
        jobId: JOB,
        signal: signal(),
      });
      if (result.outcome !== 'succeeded' || result.record.exitCode !== 0)
        throw new Error(`writing ${file} did not succeed: ${JSON.stringify(result)}`);
    },
    async read(row: SessionRow, file: string): Promise<string | null> {
      try {
        return text(await provider.getFile(sessionHandle(row), file, 1024, signal()));
      } catch (error) {
        if (error instanceof SandboxFileNotFound) return null;
        throw error;
      }
    },
    /** Whether what a suspended or live workspace keeps is still at the provider. */
    async held(row: SessionRow): Promise<boolean> {
      if (subject.persistence === 'snapshot') {
        const snapshot = row.resumeRef ? await subject.snapshotHeld(row.resumeRef) : false;
        const sandbox =
          row.status === 'ready'
            ? (await provider.inspect(sessionHandle(row), signal())) !== 'gone'
            : false;
        return snapshot || sandbox;
      }
      const id = row.resumeRef ?? row.providerSandboxId;
      return (await provider.inspect(handleOf(id), signal())) !== 'gone';
    },
    async refusal(work: Promise<unknown>) {
      return work.then(
        () => 'not refused',
        (error: unknown) =>
          error instanceof SandboxRefusal ? error.code : `not a refusal: ${String(error)}`,
      );
    },
    settled(query: PromiseLike<unknown>) {
      return Promise.resolve(query).then(
        () => 'succeeded',
        (error: unknown) => String(error),
      );
    },
    async until(check: () => Promise<boolean>) {
      const deadline = Date.now() + 10_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('the condition never held');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
  return context;
}
