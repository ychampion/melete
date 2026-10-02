/**
 * Words for the things the service names in its own terms: failure codes,
 * stored file paths, and time zones. Every screen that shows one of these
 * goes through here, so the person reads a sentence, a file name and a place.
 */

const ALLOWANCE =
  'Today’s model allowance ran out. It picks up again tomorrow, or you can choose another model in Settings › Models.';
const KEY =
  'The model’s key or sign-in isn’t working. Check it in Settings › Models, then try again.';
const TOO_LONG =
  'This was too long for the model to read at once. Try a shorter request, or split it in two.';
const UNAVAILABLE =
  'The chosen model isn’t available right now. Pick another in Settings › Models.';
const SLOW = 'The model didn’t answer in time. Try again in a moment.';

/** The codes the service fails with, each as a sentence with what to do next. */
const CODES: Record<string, string> = {
  token_cap_exceeded: ALLOWANCE,
  provider_key_unavailable: KEY,
  input_context_exceeded: TOO_LONG,
  output_exceeds_context: TOO_LONG,
  model_denied: UNAVAILABLE,
  model_required: UNAVAILABLE,
  gateway_failure: SLOW,
  request_too_large: 'That was too large to send. Try something smaller.',
};
const CODE = new RegExp(`\\b(${Object.keys(CODES).join('|')})\\b`);

/** What a run that failed upstream most often reports, when no code says it. */
const SHAPES: Array<{ match: RegExp; say: string }> = [
  { match: /\b429\b|rate.?limit|too many requests|quota/i, say: ALLOWANCE },
  { match: /invalid.?api.?key|incorrect api key/i, say: KEY },
  { match: /context.?length|maximum context/i, say: TOO_LONG },
  {
    match: /\b50[234]\b|bad gateway|service unavailable|timed? ?out|ETIMEDOUT|ECONNRESET/i,
    say: SLOW,
  },
];

/** Looks like a code rather than a sentence: snake_case words, HTTP statuses, stack-ish text. */
const CODE_LIKE = /\b[a-z]+_[a-z_]+\b|\bHTTP\s?\d{3}\b|\b(?:Error|Exception):/;

/** An error the API answered with: a known code becomes its sentence, anything else is kept. */
export function plainError(message: string): string {
  const code = CODE.exec(message)?.[1];
  return code ? (CODES[code] ?? message) : message;
}

/**
 * Why something failed, as the person reads it. Known codes and the usual
 * upstream failures become a sentence with a next step; a sentence the
 * service already wrote is kept; anything else that reads as a code becomes
 * a plain fallback.
 */
export function plainFailure(reason: string): string {
  const text = reason.trim();
  if (!text) return text;
  const code = CODE.exec(text)?.[1];
  if (code && CODES[code]) return CODES[code];
  const shape = SHAPES.find((entry) => entry.match.test(text));
  if (shape) return shape.say;
  if (CODE_LIKE.test(text)) return 'Something went wrong on the way. Try again in a moment.';
  return text;
}

/** A routine's failure line, which the service starts with "It failed:". */
export function plainRunReason(reason: string): string {
  const failed = /^It failed:\s*/i.exec(reason);
  if (!failed) return reason;
  const rest = reason.slice(failed[0].length);
  const plain = plainFailure(rest);
  return plain === rest ? reason : plain;
}

// A stored file keeps its place in the artifact store (art_ and a ULID), or a
// part hidden for privacy, ahead of its name. Neither means anything to the person.
const STORE_PREFIX = /^(?:(?:art_[0-9A-HJKMNP-TV-Z]{26}|\[hidden\]|work|artifacts)\/)+/i;

/**
 * A card or file title as the person reads it: a stored path becomes its file
 * name, and a bare web address becomes the site's name.
 */
export function plainTitle(title: string): string {
  const text = title.trim();
  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      return new URL(text).hostname.replace(/^www\./, '');
    } catch {
      return text;
    }
  }
  if (STORE_PREFIX.test(text)) {
    const name = text.replace(STORE_PREFIX, '').split('/').pop() ?? '';
    return name && name !== '[hidden]' ? name : 'File';
  }
  return text;
}

/** Zones the tz database renamed; the old name still arrives from older systems. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Asia/Ashkhabad': 'Asia/Ashgabat',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'US/Pacific': 'America/Los_Angeles',
  'US/Mountain': 'America/Denver',
  'US/Central': 'America/Chicago',
  'US/Eastern': 'America/New_York',
  'US/Alaska': 'America/Anchorage',
  'US/Hawaii': 'Pacific/Honolulu',
  'US/Arizona': 'America/Phoenix',
};

/** The current name of a zone, for a zone stored under one the database retired. */
export const currentZone = (zone: string): string => RENAMED[zone] ?? zone;

/** "America/Argentina/Buenos_Aires" reads "Buenos Aires"; "UTC" stays "UTC". */
export function zoneCity(zone: string): string {
  const current = currentZone(zone);
  return (current.split('/').pop() ?? current).replaceAll('_', ' ');
}

/** "Pacific Time", "India Standard Time", or null when the browser has no name for the zone. */
function zoneLongName(zone: string, at: Date): string | null {
  try {
    // The generic name holds all year: "Central European Time", not "... Summer Time".
    const generic = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longGeneric',
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (generic && !/^GMT[+-]/.test(generic) && generic !== zoneCity(zone)) return generic;
  } catch {
    // A browser without generic names falls through to the long name.
  }
  try {
    const long = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!long || /^GMT[+-]/.test(long)) return null;
    // "Pacific Daylight Time" and "Pacific Standard Time" are both Pacific Time.
    const general =
      /^(Pacific|Mountain|Central|Eastern|Alaska|Hawaii-Aleutian|Atlantic) (?:Standard|Daylight) Time$/.exec(
        long,
      );
    return general ? `${general[1]} Time` : long;
  } catch {
    return null;
  }
}

/**
 * A zone by a name a person uses: "Pacific Time (Los Angeles)",
 * "India Standard Time (Kolkata)", or the city when the browser has no
 * long name for it.
 */
export function zoneName(zone: string, at: Date = new Date()): string {
  const current = currentZone(zone);
  if (!current.includes('/')) return current;
  const city = zoneCity(current);
  const long = zoneLongName(current, at);
  return long ? `${long} (${city})` : city;
}

/** A schedule sentence with its zone in brackets reads the zone by name: "(Pacific Time)". */
export function plainSchedule(schedule: string, at: Date = new Date()): string {
  return schedule.replace(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/g, (_, zone: string) => {
    const current = currentZone(zone);
    return `(${zoneLongName(current, at) ?? `${zoneCity(current)} time`})`;
  });
}

/** "⌘" on a Mac, "Ctrl" elsewhere, for the keys shown beside a command. */
export function modKey(): string {
  if (typeof navigator === 'undefined') return '⌘';
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
}
