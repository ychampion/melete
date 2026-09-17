/**
 * The behaviour every sandbox adapter must show before the broker may use it.
 *
 * The same scenarios run against the in-memory fake, against each adapter on
 * its fixtures, and against each adapter live when an operator asks for it.
 * Every scenario goes through the service's own code paths — the manifest
 * check, the marker wrapper and runner, and workspace synchronisation — so a
 * provider passes by behaving, not by being called in a friendly order.
 *
 * Commands are real POSIX shell with coreutils, curl and getent, so the text
 * that runs in a fixture's author is the text that runs in a live sandbox.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSandbox, SandboxRefusal, sandboxLabels } from './manifest.ts';
import { type CommandResult, type ExecutionRecord, runCommand } from './marker.ts';
import {
  type EgressPolicy,
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from './types.ts';
import { SyncRefusal, syncOut } from './workspace.ts';

export type ConformanceSubject = {
  provider: SandboxProvider;
  /** The provider image or template the scenarios run in. */
  image?: string;
  /** Strings that must never be visible inside a sandbox. */
  secrets: readonly string[];
  /** The next command's acknowledgement is lost before or after its marker is written. */
  loseNextAcknowledgement(when: 'before_marker' | 'after_marker'): void;
  /** Called after every scenario, pass or fail; replayed fixtures check they were used here. */
  close(): Promise<void>;
};

export const CONFORMANCE_TESTS = [
  "a command's exit code, duration and output digest are recorded",
  'a timeout kills the command and the kill is recorded',
  'output above the cap is stored by the service and re-hashed',
  'a second dispatch of the same action reattaches instead of running again',
  'a lost acknowledgement after the marker is unknown and is never re-run',
  'a lost acknowledgement before the marker is a retryable failure',
  'the sandbox environment carries no Melete or provider credential',
  'a path outside the job workspace is refused on sync-out',
  'a symbolic link returned by the provider is refused',
  'a manifest without deny_all refuses a deny_all connection',
  'deny-all egress holds from inside the sandbox',
] as const;

export type ConformanceTest = (typeof CONFORMANCE_TESTS)[number];

const JOB = 'job_CONFORMANCE';
const MARKER = 'act_01J0CONFORMANCE00000000';
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = () => AbortSignal.timeout(120_000);

type Scenario = {
  subject: ConformanceSubject;
  provider: SandboxProvider;
  workRoot: string;
  open(egress?: EgressPolicy): Promise<SandboxHandle>;
  spec(egress: EgressPolicy, session: string): SandboxSpec;
  run(
    handle: SandboxHandle,
    argv: string[],
    options?: { marker?: string; timeoutMs?: number; dispatch?: 'first' | 'again' },
  ): Promise<CommandResult>;
};

function succeeded(result: CommandResult): Extract<CommandResult, { outcome: 'succeeded' }> {
  if (result.outcome !== 'succeeded')
    throw new Error(`expected a recorded execution, got ${JSON.stringify(result)}`);
  return result;
}

const recordText = (record: ExecutionRecord) => text(record.preview);

export function sandboxConformance(
  name: string,
  open: (test: ConformanceTest) => Promise<ConformanceSubject>,
  options: { timeoutMs?: number } = {},
): void {
  const scenario = (title: ConformanceTest, body: (context: Scenario) => Promise<void>) =>
    test(
      title,
      async () => {
        const subject = await open(title);
        const workRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-sandbox-')));
        await mkdir(path.join(workRoot, 'work'));
        const handles: SandboxHandle[] = [];
        let sessions = 0;
        const spec = (egress: EgressPolicy, session: string): SandboxSpec => ({
          image: subject.image ?? 'base',
          egress,
          region: null,
          lifetimeSeconds: 600,
          idleSeconds: null,
          workdir: '/work',
          labels: sandboxLabels({
            project: 'conformance',
            space: 'sp_CONFORMANCE',
            job: JOB,
            attempt: 'att_CONFORMANCE',
            session,
          }),
          env: { LANG: 'C.UTF-8' },
        });
        const context: Scenario = {
          subject,
          provider: subject.provider,
          workRoot,
          spec,
          async open(egress = { kind: 'deny_all' }) {
            sessions += 1;
            const handle = await openSandbox(
              subject.provider,
              spec(egress, `sbx_CONFORMANCE${sessions}`),
              signal(),
            );
            handles.push(handle);
            return handle;
          },
          run(handle, argv, runOptions = {}) {
            return runCommand({
              provider: subject.provider,
              handle,
              request: {
                marker: runOptions.marker ?? MARKER,
                argv,
                timeoutMs: runOptions.timeoutMs ?? 20_000,
                dispatch: runOptions.dispatch ?? 'first',
              },
              workRoot: path.join(workRoot, 'work'),
              jobId: JOB,
              signal: signal(),
            });
          },
        };
        let failure: unknown = null;
        try {
          await body(context);
        } catch (error) {
          failure = error;
        }
        for (const handle of handles) {
          await subject.provider.destroy(handle, signal()).catch((error) => {
            failure ??= error;
          });
        }
        try {
          await subject.close();
        } catch (error) {
          failure ??= error;
        }
        await rm(workRoot, { recursive: true, force: true });
        if (failure) throw failure;
      },
      options.timeoutMs ?? 90_000,
    );

  describe(`sandbox conformance: ${name}`, () => {
    scenario("a command's exit code, duration and output digest are recorded", async (context) => {
      const handle = await context.open();
      const result = succeeded(
        await context.run(handle, ['sh', '-c', "printf 'melete-conformance'; sleep 0.3; exit 3"]),
      );
      expect(result.late).toBe(false);
      expect(result.record.exitCode).toBe(3);
      expect(result.record.timedOut).toBe(false);
      expect(result.record.durationMs).toBeGreaterThanOrEqual(250);
      expect(result.record.outputDigest).toBe(sha256('melete-conformance'));
      expect(result.record.outputBytes).toBe('melete-conformance'.length);
      expect(recordText(result.record)).toBe('melete-conformance');
      expect(result.record.outputPath).toBeNull();
    });

    scenario('a timeout kills the command and the kill is recorded', async (context) => {
      const handle = await context.open();
      const result = succeeded(
        await context.run(handle, ['sh', '-c', 'printf started; sleep 3; printf never'], {
          timeoutMs: 1_000,
        }),
      );
      expect(result.record.timedOut).toBe(true);
      expect(result.record.exitCode).toBeNull();
      expect(result.record.signal).toBe('SIGKILL');
      expect(result.record.durationMs).toBeGreaterThanOrEqual(900);
      expect(recordText(result.record)).toBe('started');
      // Had the kill not reached the command, it would have printed by now.
      await delay(3_500);
      const state = await context.provider.reattach(handle, MARKER, signal());
      expect(state?.state).toBe('lost');
      const out = await context.provider.getFile(
        handle,
        `/var/tmp/.melete-exec/${MARKER}/out`,
        1024,
        signal(),
      );
      expect(text(out)).toBe('started');
    });

    scenario('output above the cap is stored by the service and re-hashed', async (context) => {
      const handle = await context.open();
      const size = 70_000;
      const result = succeeded(
        await context.run(handle, ['head', '-c', String(size), '/dev/zero']),
      );
      const zeros = new Uint8Array(size);
      expect(result.record.exitCode).toBe(0);
      expect(result.record.outputBytes).toBe(size);
      expect(result.record.outputDigest).toBe(sha256(zeros));
      expect(result.record.truncated).toBe(true);
      expect(result.record.preview.byteLength).toBe(16_384);
      expect(result.record.outputPath).toBe(`.melete/exec/${MARKER}.out`);
      const stored = await readFile(
        path.join(context.workRoot, 'work', JOB, '.melete', 'exec', `${MARKER}.out`),
      );
      expect(stored.byteLength).toBe(size);
      expect(sha256(stored)).toBe(result.record.outputDigest);
    });

    scenario(
      'a second dispatch of the same action reattaches instead of running again',
      async (context) => {
        const handle = await context.open();
        const argv = ['sh', '-c', 'printf once >> /work/counter; printf done'];
        const first = succeeded(await context.run(handle, argv));
        expect(first.late).toBe(false);
        const again = succeeded(await context.run(handle, argv, { dispatch: 'again' }));
        expect(again).toMatchObject({ late: true, reattached: true });
        expect(again.record.exitCode).toBe(0);
        expect(recordText(again.record)).toBe('done');
        // A duplicate that does reach the sandbox finds the marker and does not run.
        const duplicate = succeeded(await context.run(handle, argv));
        expect(duplicate).toMatchObject({ late: true, reattached: true });
        const counter = await context.provider.getFile(handle, '/work/counter', 64, signal());
        expect(text(counter)).toBe('once');
      },
    );

    scenario(
      'a lost acknowledgement after the marker is unknown and is never re-run',
      async (context) => {
        const handle = await context.open();
        const argv = ['sh', '-c', 'printf once >> /work/counter; sleep 2; printf done'];
        context.subject.loseNextAcknowledgement('after_marker');
        const lost = await context.run(handle, argv);
        expect(lost.outcome).toBe('unknown');
        await delay(3_500);
        const again = succeeded(await context.run(handle, argv, { dispatch: 'again' }));
        expect(again).toMatchObject({ late: true, reattached: true });
        expect(recordText(again.record)).toBe('done');
        const duplicate = succeeded(await context.run(handle, argv));
        expect(duplicate.reattached).toBe(true);
        const counter = await context.provider.getFile(handle, '/work/counter', 64, signal());
        expect(text(counter)).toBe('once');
      },
    );

    scenario('a lost acknowledgement before the marker is a retryable failure', async (context) => {
      const handle = await context.open();
      const argv = ['sh', '-c', 'printf once >> /work/counter'];
      context.subject.loseNextAcknowledgement('before_marker');
      const lost = await context.run(handle, argv);
      expect(lost).toMatchObject({ outcome: 'failed', retryable: true });
      await expect(
        context.provider.getFile(handle, '/work/counter', 64, signal()),
      ).rejects.toBeInstanceOf(SandboxFileNotFound);
      // Retrying a command that provably never started runs it once.
      const retried = succeeded(await context.run(handle, argv));
      expect(retried.late).toBe(false);
      const counter = await context.provider.getFile(handle, '/work/counter', 64, signal());
      expect(text(counter)).toBe('once');
    });

    scenario(
      'the sandbox environment carries no Melete or provider credential',
      async (context) => {
        const handle = await context.open();
        const result = succeeded(await context.run(handle, ['env']));
        const environment = recordText(result.record);
        expect(environment).toContain('PATH=');
        expect(environment).not.toMatch(/^(MELETE_|E2B_|DAYTONA_|MODAL_)/m);
        for (const secret of context.subject.secrets) expect(environment).not.toContain(secret);
      },
    );

    scenario('a path outside the job workspace is refused on sync-out', async (context) => {
      const handle = await context.open();
      succeeded(
        await context.run(handle, [
          'sh',
          '-c',
          "printf safe > /work/kept.txt; printf x > '/work/..\\..\\escape'",
        ]),
      );
      const refused = await syncOut({
        provider: context.provider,
        handle,
        workRoot: path.join(context.workRoot, 'work'),
        jobId: JOB,
        signal: signal(),
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SyncRefusal);
      expect((refused as SyncRefusal).code).toBe('path');
      // Nothing was written: not the escape, and not the file listed beside it.
      expect(existsSync(path.join(context.workRoot, 'escape'))).toBe(false);
      expect(existsSync(path.join(context.workRoot, 'work', JOB, 'kept.txt'))).toBe(false);
      expect(await readdir(context.workRoot)).toEqual(['work']);
    });

    scenario('a symbolic link returned by the provider is refused', async (context) => {
      const handle = await context.open();
      succeeded(
        await context.run(handle, [
          'sh',
          '-c',
          'printf safe > /work/kept.txt; ln -s /etc/passwd /work/passwd',
        ]),
      );
      const refused = await syncOut({
        provider: context.provider,
        handle,
        workRoot: path.join(context.workRoot, 'work'),
        jobId: JOB,
        signal: signal(),
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SyncRefusal);
      expect((refused as SyncRefusal).code).toBe('symlink');
      expect(existsSync(path.join(context.workRoot, 'work', JOB, 'passwd'))).toBe(false);
      expect(existsSync(path.join(context.workRoot, 'work', JOB, 'kept.txt'))).toBe(false);
    });

    scenario('a manifest without deny_all refuses a deny_all connection', async (context) => {
      expect(context.provider.capabilities.egress).toContain('deny_all');
      let created = 0;
      const narrowed = {
        capabilities: {
          ...context.provider.capabilities,
          egress: context.provider.capabilities.egress.filter((kind) => kind !== 'deny_all'),
        },
        async create() {
          created += 1;
          throw new Error('a refused spec reached the provider');
        },
      } as unknown as SandboxProvider;
      const refused = await openSandbox(
        narrowed,
        context.spec({ kind: 'deny_all' }, 'sbx_CONFORMANCE0'),
        signal(),
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SandboxRefusal);
      expect((refused as SandboxRefusal).code).toBe('egress_unsupported');
      expect(created).toBe(0);
    });

    scenario('deny-all egress holds from inside the sandbox', async (context) => {
      // Blocked connections can look open at the TCP level, so the probe asks
      // for an application answer and for a name to resolve, not for a socket.
      const probe = [
        'sh',
        '-c',
        [
          'getent hosts example.com > /dev/null 2>/dev/null',
          'printf \'dns=%s\\n\' "$?"',
          "curl -s -m 5 -o /dev/null -w 'ip_code=%{http_code}' http://1.1.1.1/ 2>/dev/null",
          'printf \' ip_exit=%s\\n\' "$?"',
          "curl -s -m 5 -o /dev/null -w 'name_code=%{http_code}' https://example.com/ 2>/dev/null",
          'printf \' name_exit=%s\\n\' "$?"',
        ].join('; '),
      ];
      const fields = (record: ExecutionRecord) =>
        Object.fromEntries(
          [...recordText(record).matchAll(/(\w+)=(\S+)/g)].map((match) => [match[1], match[2]]),
        );
      const denied = await context.open({ kind: 'deny_all' });
      const blocked = fields(
        succeeded(await context.run(denied, probe, { timeoutMs: 30_000 })).record,
      );
      expect(blocked.dns).not.toBe('0');
      expect(blocked.dns).not.toBe('127');
      for (const prefix of ['ip', 'name']) {
        expect(blocked[`${prefix}_code`]).toBe('000');
        // curl's own network failures; 127 would mean the probe itself was missing.
        expect(['6', '7', '28', '35', '52', '56']).toContain(blocked[`${prefix}_exit`] ?? '');
      }
      if (!context.provider.capabilities.egress.includes('open')) return;
      // The same probe must be able to see a network, or its failures prove nothing.
      const control = await context.open({ kind: 'open' });
      const reached = fields(
        succeeded(
          await context.run(control, probe, {
            marker: 'act_01J0CONFORMANCECONTROL0',
            timeoutMs: 30_000,
          }),
        ).record,
      );
      expect(reached).toMatchObject({ dns: '0', ip_exit: '0', name_exit: '0' });
      expect(reached.ip_code).not.toBe('000');
      expect(reached.name_code).not.toBe('000');
    });
  });
}
