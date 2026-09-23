import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { hostOf, siteOf } from './live-protocol.ts';

/** A host is matched literally, so every character a pattern would read is spelled out. */
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const data = join(profile, 'chromium');
  await mkdir(data, { recursive: true });
  if ((await lstat(data)).isSymbolicLink() || (await realpath(data)) !== data)
    throw new BrowserFault('profile_outside_space');
  return profile;
}

const ORIGIN_PATTERN = /https?:\/\/[a-z0-9.\-[\]]+(?::[0-9]{1,5})?/gi;
/** A directory Chromium names after an origin, as `http_example.com_443.indexeddb.leveldb`. */
const ORIGIN_DIRECTORY = /^(https?)_([a-z0-9.\-[\]]+)_([0-9]{1,5})\./i;
const STORAGE_PLACES = ['local storage', 'session storage', 'webstorage', 'indexeddb'];
const STORAGE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Where a site's storage lives in a profile, read from the profile's own directories. Chromium
 * keys storage by origin including the port, which a cookie never carries, so the origins are
 * recovered here rather than guessed from the domain.
 */
async function storedOrigins(data: string, site: string, depth = 4): Promise<string[]> {
  const found = new Set<string>();
  const keep = (value: string) => {
    try {
      const url = new URL(value);
      if (siteOf(url.hostname) === site) found.add(url.origin);
    } catch {
      // Not an origin after all; nothing to clear for it.
    }
  };
  const walk = async (directory: string, left: number, inside: boolean) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const place = inside || STORAGE_PLACES.includes(entry.name.toLowerCase());
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const named = ORIGIN_DIRECTORY.exec(entry.name);
        if (place && named) keep(`${named[1]}://${named[2]}:${named[3]}`);
        if (left > 0) await walk(path, left - 1, place);
        continue;
      }
      if (!place || !entry.isFile()) continue;
      const stats = await lstat(path).catch(() => undefined);
      if (!stats || stats.size > STORAGE_FILE_BYTES) continue;
      const text = (await readFile(path).catch(() => Buffer.alloc(0))).toString('latin1');
      for (const match of text.matchAll(ORIGIN_PATTERN)) keep(match[0]);
    }
  };
  await walk(data, depth, false);
  return [...found];
}

/**
 * How Chromium is launched wherever this worker opens it: no network but the dead proxy, no
 * downloads, no service workers, and its own renderer sandbox. Playwright turns that sandbox off
 * unless `chromiumSandbox` is exactly true, and an unsandboxed renderer hands a page that breaks
 * out of it everything this worker process can reach.
 */
export function browserLaunchOptions(headless = true) {
  return {
    timeout: 10_000,
    headless,
    chromiumSandbox: true,
    viewport: { width: 1024, height: 768 },
    serviceWorkers: 'block' as const,
    acceptDownloads: false,
    proxy: { server: 'http://127.0.0.1:1' },
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  };
}

export type BrowserSessionsOptions = {
  spaceId: string;
  spaceRoot: string;
  idleMs?: number;
  /** During a takeover, a person's live activity within this window keeps Chromium open. */
  humanIdleMs?: number;
  headless?: boolean;
  now?: () => number;
  install?: (context: BrowserContext, policy: BrowserPolicy) => Promise<void>;
  launch?: (profile: string, policy: BrowserPolicy) => Promise<BrowserContext>;
};

export type BrowserControlChange = 'takeover' | 'handback' | 'closed';
type ControlListener = (
  change: BrowserControlChange,
  session: BrowserSession,
) => Promise<void> | undefined;

/** One controller owns one space and a single warm lease. No caller supplies a profile path. */
export class BrowserSessions {
  context?: BrowserContext;
  page?: Page;
  session?: BrowserSession;
  policy?: BrowserPolicy;
  private observedEpoch: number | null = null;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly humanIdleMs: number;
  private humanActiveAt = 0;
  private readonly listeners = new Set<ControlListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private recordPath?: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(readonly options: BrowserSessionsOptions) {
    if (!/^sp_[A-Za-z0-9_-]+$/.test(options.spaceId)) throw new BrowserFault('invalid_space');
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.humanIdleMs = options.humanIdleMs ?? 15 * 60_000;
    for (const value of [this.idleMs, this.humanIdleMs])
      if (!Number.isSafeInteger(value) || value < 1) throw new BrowserFault('invalid_idle_timeout');
  }

  async lease(jobId: string, policy: BrowserPolicy): Promise<BrowserSession> {
    return this.exclusive(async () => {
      if (this.idle()) await this.closeContext();
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
        if ((await lstat(this.recordPath)).isSymbolicLink())
          throw new BrowserFault('profile_symlink');
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
      const launch = this.launchOptions();
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
            if (this.idle())
              void this.exclusive(async () => {
                if (this.idle()) await this.closeContext();
              }).catch(() => {});
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

  private launchOptions() {
    return browserLaunchOptions(this.options.headless ?? true);
  }

  requireSession(id: string, jobId?: string): BrowserSession {
    if (!this.session || this.session.id !== id || (jobId && this.session.job_id !== jobId))
      throw new BrowserFault('session_not_found');
    return this.session;
  }

  /** This check is immediately adjacent to every physical dispatch, including after locator waits. */
  dispatchInput<T>(id: string, epoch: number, operation: () => Promise<T>): Promise<T> {
    this.checkInput(id, epoch);
    this.touch();
    return operation();
  }

  checkInput(id: string, epoch: number): void {
    const session = this.requireSession(id);
    if (epoch !== session.control_epoch) throw new BrowserFault('stale_control_epoch');
    if (session.control !== 'automation') throw new BrowserFault('human_control');
    if (this.observedEpoch !== epoch) throw new BrowserFault('fresh_observation_required');
  }

  checkHumanControl(id: string, epoch: number): void {
    const session = this.requireSession(id);
    if (epoch !== session.control_epoch) throw new BrowserFault('epoch_changed');
    if (session.control !== 'human') throw new BrowserFault('not_human_control');
  }

  /** A person's live input is checked here, immediately before each dispatch, like automation's. */
  dispatchHumanInput<T>(id: string, epoch: number, operation: () => Promise<T>): Promise<T> {
    this.checkHumanControl(id, epoch);
    this.humanActiveAt = this.now();
    return operation();
  }

  humanActivity(id: string, epoch: number): void {
    this.checkHumanControl(id, epoch);
    this.humanActiveAt = this.now();
  }

  /** Listeners run after the epoch has already moved; takeover and handback wait for them. */
  onControl(listener: ControlListener): void {
    this.listeners.add(listener);
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
    this.humanActiveAt = this.now();
    this.touch();
    const notified = this.notify('takeover', session);
    await this.persist();
    await notified;
    return { ...session };
  }

  async handback(id: string): Promise<BrowserSession & { site?: string }> {
    const session = this.requireSession(id);
    session.control_epoch++;
    session.control = 'automation';
    this.observedEpoch = null;
    this.touch();
    const notified = this.notify('handback', session);
    await this.persist();
    await notified;
    // Read after the listeners have settled the pages, so this is the page the person ended on.
    const site = await this.signedInSite().catch(() => undefined);
    return { ...session, ...(site ? { site } : {}) };
  }

  /**
   * The site a takeover ended on, when the profile now holds a cookie for its registrable domain.
   * A disposable research context has no profile to sign in to, so it never reports one.
   */
  async signedInSite(): Promise<string | undefined> {
    const context = this.context;
    const page = this.page;
    if (!context || !page || this.policy?.public_compartment !== false) return undefined;
    const host = hostOf(page.url());
    if (!host) return undefined;
    const site = siteOf(host);
    const cookies = await context.cookies();
    return cookies.some((cookie) => siteOf(cookie.domain.replace(/^\./, '')) === site)
      ? site
      : undefined;
  }

  /**
   * Signing out of one site. The context closes first, so no page can write the cookies back,
   * and the profile is then reopened only to drop that domain's cookies and its origins' storage.
   */
  async forgetSite(
    domain: string,
  ): Promise<{ domain: string; cookies: number; origins: string[] }> {
    const site = siteOf(domain);
    if (site !== domain.trim().toLowerCase()) throw new BrowserFault('invalid_domain');
    return this.exclusive(async () => {
      await this.closeContext();
      const profile = await confinedProfile(this.options.spaceRoot);
      const context = await chromium.launchPersistentContext(
        join(profile, 'chromium'),
        this.launchOptions(),
      );
      try {
        const cookies = await context.cookies();
        const mine = cookies.filter((cookie) => siteOf(cookie.domain.replace(/^\./, '')) === site);
        const origins = [
          ...new Set([
            ...mine.flatMap((cookie) => {
              const host = cookie.domain.replace(/^\./, '');
              return [`http://${host}`, `https://${host}`];
            }),
            ...(await storedOrigins(join(profile, 'chromium'), site)),
          ]),
        ].sort();
        await context.clearCookies({ domain: new RegExp(`(^|\\.)${escaped(site)}$`) });
        const page = context.pages()[0] ?? (await context.newPage());
        const cdp = await context.newCDPSession(page);
        for (const origin of origins)
          await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
        await cdp.detach().catch(() => {});
        return { domain: site, cookies: mine.length, origins };
      } finally {
        await context.close();
      }
    });
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private touch() {
    if (this.session) this.session.warm_until = this.now() + this.idleMs;
  }

  /** A person who has taken control keeps Chromium open while their live channel is in use. */
  private idle(): boolean {
    const session = this.session;
    if (!session || session.warm_until > this.now()) return false;
    return !(session.control === 'human' && this.now() - this.humanActiveAt < this.humanIdleMs);
  }

  private async notify(change: BrowserControlChange, session: BrowserSession) {
    // Every listener is called before the first await, so each sees the change synchronously.
    const snapshot = { ...session };
    await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(change, snapshot)),
    );
  }

  private persist() {
    const record = JSON.stringify(this.session);
    const path = this.recordPath;
    this.persistQueue = this.persistQueue.then(async () => {
      if (!path) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await file.writeFile(record);
      } finally {
        await file.close();
      }
      await rename(temporary, path);
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
      const notified = this.notify('closed', this.session);
      await this.persist();
      await notified;
    }
    this.session = undefined;
    await context?.close();
    await browser?.close();
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeContext());
  }
}
