import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';

export class BrowserFault extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type BrowserPolicy = { public_compartment: boolean; allowed_domains: string[] };
export type BrowserSession = {
  id: string;
  space_id: string;
  profile_dir: string;
  job_id: string | null;
  control_epoch: number;
  control: 'automation' | 'human';
  warm_until: number;
};

/** Resolve every component before Chromium opens it; a profile must not follow a junction. */
export async function confinedProfile(spaceRoot: string): Promise<string> {
  const root = resolve(spaceRoot);
  await mkdir(root, { recursive: true });
  let current = root;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new BrowserFault('profile_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = await realpath(root);
  const profile = join(canonical, 'browser');
  await mkdir(profile, { recursive: true });
  if ((await lstat(profile)).isSymbolicLink() || (await realpath(profile)) !== profile)
    throw new BrowserFault('profile_outside_space');
  return profile;
}

export type BrowserSessionsOptions = {
  spaceId: string;
  spaceRoot: string;
  idleMs?: number;
  headless?: boolean;
  now?: () => number;
  install?: (context: BrowserContext, policy: BrowserPolicy) => Promise<void>;
  launch?: (profile: string, policy: BrowserPolicy) => Promise<BrowserContext>;
};

/** One controller owns one space and a single warm lease. No caller supplies a profile path. */
export class BrowserSessions {
  context?: BrowserContext;
  page?: Page;
  session?: BrowserSession;
  policy?: BrowserPolicy;
  private observedEpoch: number | null = null;
  private readonly now: () => number;
  private readonly idleMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private recordPath?: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(readonly options: BrowserSessionsOptions) {
    if (!/^sp_[A-Za-z0-9_-]+$/.test(options.spaceId)) throw new BrowserFault('invalid_space');
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 1)
      throw new BrowserFault('invalid_idle_timeout');
  }

  async lease(jobId: string, policy: BrowserPolicy): Promise<BrowserSession> {
    return this.exclusive(async () => {
      if (this.session && this.session.warm_until <= this.now()) await this.closeContext();
      if (this.session) {
        if (this.session.job_id !== jobId) throw new BrowserFault('session_busy');
        if (JSON.stringify(this.policy) !== JSON.stringify(policy))
          throw new BrowserFault('session_policy_changed');
        this.touch();
        return { ...this.session };
      }
      const profile = await confinedProfile(this.options.spaceRoot);
      this.recordPath = join(profile, 'session.json');
      let previousEpoch = -1;
      try {
        const previous: unknown = JSON.parse(await readFile(this.recordPath, 'utf8'));
        if (
          previous &&
          typeof previous === 'object' &&
          'control_epoch' in previous &&
          Number.isSafeInteger(previous.control_epoch)
        )
          previousEpoch = Number(previous.control_epoch);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      // Research has no private cookies: its disposable context never opens the signed-in profile.
      const launch = {
        timeout: 10_000,
        headless: this.options.headless ?? true,
        viewport: { width: 1024, height: 768 },
        serviceWorkers: 'block' as const,
        acceptDownloads: false,
        proxy: { server: 'http://127.0.0.1:1' },
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      };
      const context = this.options.launch
        ? await this.options.launch(profile, policy)
        : policy.public_compartment
          ? await (await chromium.launch(launch)).newContext(launch)
          : await chromium.launchPersistentContext(join(profile, 'chromium'), launch);
      try {
        await this.options.install?.(context, policy);
        this.context = context;
        this.page = context.pages()[0] ?? (await context.newPage());
        this.page.setDefaultTimeout(2500);
        this.policy = structuredClone(policy);
        this.session = {
          id: `brws_${randomUUID()}`,
          space_id: this.options.spaceId,
          profile_dir: profile,
          job_id: jobId,
          control_epoch: previousEpoch + 1,
          control: 'automation',
          warm_until: this.now() + this.idleMs,
        };
        this.observedEpoch = null;
        await this.persist();
        this.timer = setInterval(
          () => {
            if (this.session && this.session.warm_until <= this.now())
              void this.exclusive(() => this.closeContext()).catch(() => {});
          },
          Math.min(this.idleMs, 10_000),
        );
        this.timer.unref();
        return { ...this.session };
      } catch (error) {
        await context.close();
        await context.browser()?.close();
        throw error;
      }
    });
  }

  requireSession(id: string, jobId?: string): BrowserSession {
    if (!this.session || this.session.id !== id || (jobId && this.session.job_id !== jobId))
      throw new BrowserFault('session_not_found');
    return this.session;
  }

  /** This check is immediately adjacent to every physical dispatch, including after locator waits. */
  dispatchInput<T>(id: string, epoch: number, operation: () => Promise<T>): Promise<T> {
    const session = this.requireSession(id);
    if (epoch !== session.control_epoch) throw new BrowserFault('stale_control_epoch');
    if (session.control !== 'automation') throw new BrowserFault('human_control');
    if (this.observedEpoch !== epoch) throw new BrowserFault('fresh_observation_required');
    this.touch();
    return operation();
  }

  observed(id: string, epoch: number): void {
    const session = this.requireSession(id);
    if (session.control_epoch !== epoch || session.control !== 'automation')
      throw new BrowserFault('stale_control_epoch');
    this.observedEpoch = epoch;
    this.touch();
  }

  /** Takeover does not wait behind queued actions. The bump happens synchronously at receipt. */
  async takeover(id: string): Promise<BrowserSession> {
    const session = this.requireSession(id);
    session.control_epoch++;
    session.control = 'human';
    this.observedEpoch = null;
    this.touch();
    await this.persist();
    return { ...session };
  }

  async handback(id: string): Promise<BrowserSession> {
    const session = this.requireSession(id);
    session.control_epoch++;
    session.control = 'automation';
    this.observedEpoch = null;
    this.touch();
    await this.persist();
    return { ...session };
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private touch() {
    if (this.session) this.session.warm_until = this.now() + this.idleMs;
  }

  private persist() {
    const record = JSON.stringify(this.session);
    const path = this.recordPath;
    this.persistQueue = this.persistQueue.then(async () => {
      if (!path) return;
      await writeFile(`${path}.tmp`, record, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return this.persistQueue;
  }

  private async closeContext() {
    clearInterval(this.timer);
    const context = this.context;
    const browser = context?.browser();
    this.context = undefined;
    this.page = undefined;
    this.observedEpoch = null;
    if (this.session) {
      this.session.control_epoch++;
      this.session.job_id = null;
      await this.persist();
    }
    this.session = undefined;
    await context?.close();
    await browser?.close();
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeContext());
  }
}
