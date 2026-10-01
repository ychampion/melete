/**
 * When a number may be called: inside the line's calling hours, in the local
 * time of the person being called.
 *
 * The callee's time zone is the one the approved call names, or else the one
 * its country code implies. A country that spans several zones is called only
 * when the hour is acceptable in every one of them, which is the reading that
 * can never wake anybody. A country code this table does not know needs the
 * call to name the zone.
 */

/** Zones by country calling code. Longest code wins, so +353 is Ireland and not +35. */
export const COUNTRY_ZONES: Readonly<Record<string, readonly string[]>> = {
  '1': [
    'America/St_Johns',
    'America/Halifax',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
  ],
  '20': ['Africa/Cairo'],
  '212': ['Africa/Casablanca'],
  '234': ['Africa/Lagos'],
  '254': ['Africa/Nairobi'],
  '27': ['Africa/Johannesburg'],
  '30': ['Europe/Athens'],
  '31': ['Europe/Amsterdam'],
  '32': ['Europe/Brussels'],
  '33': ['Europe/Paris'],
  '34': ['Europe/Madrid', 'Atlantic/Canary'],
  '351': ['Europe/Lisbon', 'Atlantic/Azores'],
  '353': ['Europe/Dublin'],
  '358': ['Europe/Helsinki'],
  '36': ['Europe/Budapest'],
  '39': ['Europe/Rome'],
  '40': ['Europe/Bucharest'],
  '41': ['Europe/Zurich'],
  '420': ['Europe/Prague'],
  '43': ['Europe/Vienna'],
  '44': ['Europe/London'],
  '45': ['Europe/Copenhagen'],
  '46': ['Europe/Stockholm'],
  '47': ['Europe/Oslo'],
  '48': ['Europe/Warsaw'],
  '49': ['Europe/Berlin'],
  '51': ['America/Lima'],
  '52': [
    'America/Cancun',
    'America/Mexico_City',
    'America/Chihuahua',
    'America/Hermosillo',
    'America/Tijuana',
  ],
  '54': ['America/Argentina/Buenos_Aires'],
  '55': ['America/Noronha', 'America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco'],
  '56': ['America/Santiago'],
  '57': ['America/Bogota'],
  '60': ['Asia/Kuala_Lumpur'],
  '61': [
    'Australia/Sydney',
    'Australia/Brisbane',
    'Australia/Adelaide',
    'Australia/Darwin',
    'Australia/Perth',
  ],
  '62': ['Asia/Jayapura', 'Asia/Makassar', 'Asia/Jakarta'],
  '63': ['Asia/Manila'],
  '64': ['Pacific/Auckland'],
  '65': ['Asia/Singapore'],
  '66': ['Asia/Bangkok'],
  '81': ['Asia/Tokyo'],
  '82': ['Asia/Seoul'],
  '84': ['Asia/Ho_Chi_Minh'],
  '852': ['Asia/Hong_Kong'],
  '86': ['Asia/Shanghai'],
  '880': ['Asia/Dhaka'],
  '886': ['Asia/Taipei'],
  '90': ['Europe/Istanbul'],
  '91': ['Asia/Kolkata'],
  '92': ['Asia/Karachi'],
  '966': ['Asia/Riyadh'],
  '971': ['Asia/Dubai'],
  '972': ['Asia/Jerusalem'],
};

/** True when the runtime knows the zone by that name. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zones to check for a number, or null when they cannot be told. */
export function zonesFor(number: string, named?: string): readonly string[] | null {
  if (named) return knownZone(named) ? [named] : null;
  const digits = number.replace(/^\+/, '');
  for (let length = 3; length >= 1; length--) {
    const zones = COUNTRY_ZONES[digits.slice(0, length)];
    if (zones) return zones;
  }
  return null;
}

/** Minutes past local midnight in a zone. */
export function localMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

const minutesOf = (clock: string) => {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Whether `at` falls within [start, end) in every zone. */
export function withinHours(
  zones: readonly string[],
  start: string,
  end: string,
  at: Date,
): boolean {
  const from = minutesOf(start);
  const until = minutesOf(end);
  return zones.every((zone) => {
    const now = localMinutes(zone, at);
    return now >= from && now < until;
  });
}

/** A caller id as ElevenLabs reports it, reduced to the form the allowed list uses. */
export function normalizeNumber(raw: string | undefined): string | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  const withPlus = international.startsWith('+') ? international : `+${international}`;
  return /^\+[1-9][0-9]{6,14}$/.test(withPlus) ? withPlus : null;
}
