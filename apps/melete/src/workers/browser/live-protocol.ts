import { isIP } from 'node:net';
import type { LiveEndCode, LiveNoticeCode } from '@melete/contracts';
import { getDomain, parse } from 'tldts';
import { z } from 'zod';
import { isPublicAddress } from '../../connectors/web.ts';

export type { LiveDown, LiveEndCode, LiveNoticeCode, LiveOpen } from '@melete/contracts';

// The worker image carries this directory with zod and tldts only, so these runtime values
// mirror @melete/contracts browser-live.ts. A test holds the two definitions equal.
export const LIVE_VIEWPORT = { width: 1024, height: 768 } as const;

const KB = 1024;
const MB = 1024 * KB;
export const LIVE_LIMITS = {
  input_events_per_second: 200,
  input_bytes_per_second: 64 * KB,
  input_event_bytes: 4 * KB,
  text_bytes: 4 * KB,
  text_events_per_second: 4,
  events_per_batch: 200,
  frames_per_second: 10,
  frame_bytes_per_second: 500 * KB,
  frame_budget_window_ms: 10_000,
  unacked_frames: 2,
  site_scope_hosts: 12,
  redirect_hops: 20,
  popups_per_takeover: 8,
  takeover_ms: 20 * 60_000,
  pull_timeout_ms: 10_000,
  requests_per_takeover: 2000,
  network_bytes_per_takeover: 32 * MB,
} as const;

/** Limits a worker may be started with instead of the defaults; never taken from a request. */
export type LiveLimitOverrides = Partial<
  Record<
    | 'takeover_ms'
    | 'popups_per_takeover'
    | 'requests_per_takeover'
    | 'network_bytes_per_takeover'
    | 'frames_per_second'
    | 'frame_bytes_per_second'
    | 'site_scope_hosts'
    | 'redirect_hops',
    number
  >
>;

export const liveId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const x = z.number().min(0).max(LIVE_VIEWPORT.width);
const y = z.number().min(0).max(LIVE_VIEWPORT.height);
/** Alt 1, Control 2, Meta 4, Shift 8. */
const mods = z.number().int().min(0).max(15);
const delta = z.number().min(-10_000).max(10_000);

export const liveInput = z.discriminatedUnion('k', [
  z.strictObject({
    k: z.enum(['move', 'down', 'up']),
    x,
    y,
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    mods,
    clicks: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.strictObject({ k: z.literal('wheel'), x, y, dx: delta, dy: delta, mods }),
  z.strictObject({
    k: z.literal('key'),
    down: z.boolean(),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    vk: z.number().int().min(0).max(255),
    mods,
    text: z.string().min(1).max(16).optional(),
  }),
  /** Typing and paste into the focused page control. */
  z.strictObject({ k: z.literal('text'), text: z.string().min(1).max(LIVE_LIMITS.text_bytes) }),
  z.strictObject({
    k: z.literal('touch'),
    phase: z.enum(['start', 'move', 'end']),
    /** The points still touching after this event; empty when the last finger lifts. */
    points: z.array(z.strictObject({ id: z.number().int().min(0).max(16), x, y })).max(10),
  }),
]);
export type LiveInput = z.infer<typeof liveInput>;

export const liveUp = z.strictObject({
  live_id: liveId,
  ack_through: z.number().int().nonnegative(),
  events: z.array(liveInput).max(LIVE_LIMITS.events_per_batch),
});

export const liveOpenRequest = z.strictObject({
  session_id: z.string().min(1).max(200),
  control_epoch: z.number().int().nonnegative(),
});
export const livePullRequest = z.strictObject({
  live_id: liveId,
  ack_through: z.number().int().nonnegative(),
  timeout_ms: z.number().int().min(0).max(LIVE_LIMITS.pull_timeout_ms),
  /** A reconnecting viewer has no picture: repaint the current page instead of waiting for a change. */
  fresh: z.boolean().optional(),
});
export const liveScopeRequest = z.strictObject({
  live_id: liveId,
  host: z.string().min(1).max(255),
});
export const liveCloseRequest = z.strictObject({ live_id: liveId });

export type LiveNotify = (code: LiveNoticeCode, host?: string) => void;
export type LiveEnd = (code: LiveEndCode) => void;

function normalHost(host: string): string {
  return host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** The host of an HTTP(S) document; other schemes (about:, chrome-error:, data:) have none. */
export function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? normalHost(url.hostname) : undefined;
  } catch {
    return undefined;
  }
}

/** The registrable domain from the public suffix list; an address or bare suffix stays exact. */
export function siteOf(host: string): string {
  const name = normalHost(host);
  return getDomain(name, { allowPrivateDomains: true }) ?? name;
}

/**
 * A host no takeover's scope may hold: an address that is not public, or a name that is not a
 * site on the public internet. A site has a registrable domain under a suffix on the public
 * suffix list, which leaves out `localhost`, `metadata`, `intranet`, `default.svc`, `.local`,
 * `.internal` and every other name reserved for a machine or its own network. A public name
 * that resolves privately is refused later by the egress guard, which resolves it and pins what
 * it resolved.
 */
export function localName(host: string): boolean {
  const name = normalHost(host);
  const address = name.startsWith('[') ? name.slice(1, -1) : name;
  if (isIP(address)) return !isPublicAddress(address);
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  const parsed = parse(name, { allowPrivateDomains: true });
  return !parsed.domain || !(parsed.isIcann || parsed.isPrivate);
}

/** Names reserved for a machine or its network, some of them under a listed suffix (`arpa`). */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

export type LiveScopeDecision = 'in_scope' | 'admitted' | 'off_scope' | 'scope_full';

/** How long after the person last pressed, touched or typed a page may take them to a new site. */
export const LIVE_FOLLOW_WINDOW_MS = 15_000;
/**
 * New sites one burst of the person's activity may lead to: a sign-in and a provider it hands
 * off to. A burst runs while each action comes within the window of the one before.
 */
export const LIVE_FOLLOW_SITES_PER_BURST = 3;

/** An input that is the person acting on the page, as opposed to pointing or scrolling. */
export function liveAction(event: LiveInput): boolean {
  return (
    event.k === 'down' ||
    event.k === 'text' ||
    (event.k === 'key' && event.down) ||
    (event.k === 'touch' && event.phase === 'start')
  );
}

/**
 * One takeover's site scope, held in memory only. It starts from the job's allowed domains and
 * the site of the page at takeover, and the person can allow a host. A redirect or top-level
 * navigation initiated by an in-scope document adds its target's site only just after the person
 * acts, and only a few sites for each burst of activity, so a page cannot walk them across sites
 * on its own, nor while they type.
 * Additions stop at the cap.
 */
export class LiveSiteScope {
  private readonly sites = new Set<string>();
  private actedAt = Number.NEGATIVE_INFINITY;
  private follows = 0;

  constructor(
    allowedDomains: readonly string[],
    pageUrl?: string,
    private readonly limit: number = LIVE_LIMITS.site_scope_hosts,
    private readonly now: () => number = Date.now,
    /** Loopback test origins the egress guard admits, which a test's scope may hold too. */
    private readonly fixture: (target: string) => boolean = () => false,
  ) {
    for (const domain of allowedDomains) this.sites.add(siteOf(domain));
    const host = pageUrl ? hostOf(pageUrl) : undefined;
    if (host) this.sites.add(siteOf(host));
  }

  list(): string[] {
    return [...this.sites];
  }

  admits(host: string): boolean {
    return this.sites.has(siteOf(host));
  }

  follow(target: string, initiator: string | undefined): LiveScopeDecision {
    const host = hostOf(target);
    if (!host) return 'off_scope';
    if (this.admits(host)) return 'in_scope';
    const from = initiator === undefined ? undefined : hostOf(initiator);
    if (!from || !this.admits(from)) return 'off_scope';
    // A page can send the person anywhere, but the list the person is shown holds only sites.
    if (localName(host) && !this.fixture(target)) return 'off_scope';
    if (this.follows <= 0 || this.now() - this.actedAt > LIVE_FOLLOW_WINDOW_MS) return 'off_scope';
    const decision = this.add(host);
    if (decision === 'admitted') this.follows--;
    return decision;
  }

  /**
   * The person acted on the page: what it does next may take them to a few new sites. Acting
   * again keeps the window open, so a long password typed before Enter still reaches its
   * identity provider, but only an action after the window has lapsed earns new sites: typing
   * does not hand a page three more with every key.
   */
  acted(): void {
    const now = this.now();
    if (now - this.actedAt > LIVE_FOLLOW_WINDOW_MS) this.follows = LIVE_FOLLOW_SITES_PER_BURST;
    this.actedAt = now;
  }

  allow(host: string): LiveScopeDecision {
    let name: string;
    try {
      name = new URL(`http://${host}/`).hostname;
    } catch {
      return 'off_scope';
    }
    if (name !== host.toLowerCase() && `[${host.toLowerCase()}]` !== name) return 'off_scope';
    // The egress guard refuses a private address whoever asks, but a person's list should never
    // carry one either: the panel shows this list, and the deployment's own network is not a
    // site anybody signs in to.
    if (localName(name)) return 'off_scope';
    return this.admits(name) ? 'in_scope' : this.add(name);
  }

  private add(host: string): LiveScopeDecision {
    const site = siteOf(host);
    if (this.sites.has(site)) return 'in_scope';
    if (this.sites.size >= this.limit) return 'scope_full';
    this.sites.add(site);
    return 'admitted';
  }
}

class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.at = now();
  }

  available(): number {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.capacity);
    this.at = now;
    return this.tokens;
  }

  take(amount: number): void {
    this.tokens -= amount;
  }
}

function inputBytes(event: LiveInput): number {
  return event.k === 'text'
    ? Buffer.byteLength(event.text)
    : Buffer.byteLength(JSON.stringify(event));
}

/** One channel's input budget. A batch is admitted whole or not at all, before any dispatch. */
export class LiveInputLimiter {
  private readonly events: TokenBucket;
  private readonly bytes: TokenBucket;
  private readonly texts: TokenBucket;

  constructor(now: () => number = Date.now) {
    this.events = new TokenBucket(LIVE_LIMITS.input_events_per_second, now);
    this.bytes = new TokenBucket(LIVE_LIMITS.input_bytes_per_second, now);
    this.texts = new TokenBucket(LIVE_LIMITS.text_events_per_second, now);
  }

  admit(batch: readonly LiveInput[]): boolean {
    let bytes = 0;
    let texts = 0;
    for (const event of batch) {
      const size = inputBytes(event);
      if (size > LIVE_LIMITS.input_event_bytes) return false;
      if (event.k === 'text') texts++;
      bytes += size;
    }
    if (
      this.events.available() < batch.length ||
      this.bytes.available() < bytes ||
      this.texts.available() < texts
    )
      return false;
    this.events.take(batch.length);
    this.bytes.take(bytes);
    this.texts.take(texts);
    return true;
  }
}

/**
 * Frame bytes averaged over a sliding window. Delivery waits above the average; nothing ends a
 * takeover for its frame volume, whose total the takeover's time cap already bounds.
 */
export class LiveFrameBudget {
  private readonly sent: Array<{ at: number; bytes: number }> = [];
  private inWindow = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly perSecond: number = LIVE_LIMITS.frame_bytes_per_second,
    private readonly windowMs: number = LIVE_LIMITS.frame_budget_window_ms,
  ) {}

  take(bytes: number): boolean {
    const now = this.now();
    while (this.sent[0] && this.sent[0].at <= now - this.windowMs)
      this.inWindow -= this.sent.shift()?.bytes ?? 0;
    // A single frame larger than the whole window is still delivered once the window is empty.
    if (this.sent.length && this.inWindow + bytes > (this.perSecond * this.windowMs) / 1000)
      return false;
    this.sent.push({ at: now, bytes });
    this.inWindow += bytes;
    return true;
  }
}

/** Page network for one takeover, counted across every live channel opened under its epoch. */
export class LiveNetworkBudget {
  requests = 0;
  bytes = 0;

  constructor(
    private readonly maxRequests: number = LIVE_LIMITS.requests_per_takeover,
    private readonly maxBytes: number = LIVE_LIMITS.network_bytes_per_takeover,
  ) {}

  request(): boolean {
    this.requests++;
    return this.requests <= this.maxRequests;
  }

  transfer(bytes: number): boolean {
    this.bytes += bytes;
    return this.bytes <= this.maxBytes;
  }
}
