/**
 * How much anyone may ask for, and how much the whole page may spend in a day.
 * The counting is a plain function over a plain value so it can be tested
 * directly; `limiter.ts` is the only thing that knows where that value lives.
 *
 * Both caps are configuration. The day is UTC, so the page resets for everyone
 * at the same moment rather than drifting with whoever asks first.
 */

export type Limits = {
  /** Longest paste accepted, in characters. */
  maxInputChars: number;
  /** Shortest paste worth a case file. */
  minInputChars: number;
  /** Case files one address may have in a day. */
  perIpPerDay: number;
  /** Case files the whole page may produce in a day. */
  globalPerDay: number;
  /** How long one request may take before it is given up on. */
  requestTimeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxInputChars: 20_000,
  minInputChars: 40,
  perIpPerDay: 5,
  globalPerDay: 400,
  // The same number as wrangler.toml and the README. Three copies drifting
  // apart is how a timeout turns into a mystery.
  requestTimeoutMs: 100_000,
};

const camelToScreaming = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();

/** Read the caps from the Worker's variables, keeping the default for any that is unset or unusable. */
export function limitsFrom(env: Record<string, unknown>): Limits {
  const number = (key: keyof Limits): number => {
    const raw = env[`TRYIT_${camelToScreaming(key)}`];
    const value =
      typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LIMITS[key];
  };
  return {
    maxInputChars: number('maxInputChars'),
    minInputChars: number('minInputChars'),
    perIpPerDay: number('perIpPerDay'),
    globalPerDay: number('globalPerDay'),
    requestTimeoutMs: number('requestTimeoutMs'),
  };
}

/* ---------- the paste ---------- */

export type InputCheck =
  | { ok: true; text: string }
  | { ok: false; code: 'empty_input' | 'too_long'; limit: number };

/**
 * Characters, not bytes: the cap is about how much someone is asked to read
 * back, and an emoji is one thing on the screen whatever it weighs.
 */
export function checkInput(raw: unknown, limits: Limits): InputCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length > limits.maxInputChars)
    return { ok: false, code: 'too_long', limit: limits.maxInputChars };
  if (text.length < limits.minInputChars)
    return { ok: false, code: 'empty_input', limit: limits.minInputChars };
  return { ok: true, text };
}

/* ---------- the day's counting ---------- */

export type Counters = {
  /** UTC date the counts belong to, as YYYY-MM-DD. */
  day: string;
  global: number;
  perIp: Record<string, number>;
};

export type Spend =
  | { allowed: true; counters: Counters; remaining: number }
  | { allowed: false; reason: 'ip' | 'global'; counters: Counters; remaining: number };

export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

export const emptyCounters = (now: number): Counters => ({
  day: dayKey(now),
  global: 0,
  perIp: {},
});

/**
 * Take one case file from the day's budget. The global cap is checked first:
 * when the page as a whole is out, every address hears the same thing, and an
 * address that still had room keeps it for tomorrow.
 */
export function spend(counters: Counters, ip: string, now: number, limits: Limits): Spend {
  const today = dayKey(now);
  const current: Counters = counters.day === today ? counters : emptyCounters(now);
  const used = current.perIp[ip] ?? 0;

  if (current.global >= limits.globalPerDay)
    return { allowed: false, reason: 'global', counters: current, remaining: 0 };
  if (used >= limits.perIpPerDay)
    return { allowed: false, reason: 'ip', counters: current, remaining: 0 };

  const taken = used + 1;
  const next: Counters = {
    day: today,
    global: current.global + 1,
    perIp: { ...current.perIp, [ip]: taken },
  };
  return { allowed: true, counters: next, remaining: limits.perIpPerDay - taken };
}

/**
 * Give a case file back when it was never produced. An attempt that died
 * upstream should not cost someone one of their five.
 */
export function refund(counters: Counters, ip: string, now: number): Counters {
  if (counters.day !== dayKey(now)) return counters;
  const used = counters.perIp[ip] ?? 0;
  if (used === 0) return counters;
  return {
    day: counters.day,
    global: Math.max(0, counters.global - 1),
    perIp: { ...counters.perIp, [ip]: used - 1 },
  };
}
