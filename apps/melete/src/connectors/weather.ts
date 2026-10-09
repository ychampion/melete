/**
 * The weather, read from Open-Meteo, which needs no key: the conditions now and
 * today's forecast for one place, in the person's units.
 *
 * - The place is the one the agent names (the person's city, from what they
 *   said), else the city of the person's time zone, which the receipt says.
 * - The units are the ones the agent names (the person's stated preference),
 *   else their region's usual ones: Fahrenheit, mph and inches in a United
 *   States time zone, Celsius, km/h and millimetres anywhere else.
 * - Every answer is kept for ten minutes and every place for a day, and the
 *   whole process makes at most a set number of calls a minute, so a busy
 *   morning of briefings never leans on the free service.
 *
 * It is a read. The place goes to Open-Meteo, so it goes out only on the terms
 * a search query does; the web connector asks that before calling here.
 */
import type { PublicGet } from './web-search.ts';

export const WEATHER_SOURCE = 'Open-Meteo';
export const WEATHER_SOURCE_URL = 'https://open-meteo.com/';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_MS = 10 * 60_000;
const PLACE_MS = 24 * 60 * 60_000;
/** Calls to Open-Meteo one process makes in a minute; its free tier allows far more. */
export const WEATHER_CALLS_PER_MINUTE = 60;
const CACHE_LIMIT = 500;

export type WeatherUnits = 'metric' | 'imperial';
export const WEATHER_UNITS: readonly WeatherUnits[] = ['metric', 'imperial'];

/**
 * Time zones of the United States and its territories, where Fahrenheit, mph
 * and inches are the everyday units. The legacy `US/` names count too.
 */
const US_ZONE =
  /^(?:US\/.+|America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Yakutat|Nome|Metlakatla|Adak|Boise|Detroit|Menominee|Puerto_Rico|St_Thomas|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago))$/;

/** The units a person in this time zone reads by default. */
export const unitsForTimeZone = (timeZone: string | null | undefined): WeatherUnits =>
  timeZone && US_ZONE.test(timeZone) ? 'imperial' : 'metric';

/** The city a time zone is named after ("America/Los_Angeles" is Los Angeles), or null. */
export function placeForTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone || !timeZone.includes('/') || /^(?:Etc|SystemV)\//.test(timeZone)) return null;
  const city = timeZone.split('/').at(-1)?.replaceAll('_', ' ').trim();
  return city && /^[\p{L} .'-]{2,60}$/u.test(city) ? city : null;
}

/** WMO weather codes, as Open-Meteo reports them, in plain words. */
const CONDITIONS: Record<number, string> = {
  0: 'clear',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'foggy',
  48: 'foggy, with rime',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'light freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'heavy showers',
  85: 'light snow showers',
  86: 'snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with heavy hail',
};
export const conditionsOf = (code: unknown): string =>
  typeof code === 'number' ? (CONDITIONS[code] ?? 'mixed') : 'unknown';

const LABELS: Record<WeatherUnits, { temperature: string; wind: string; precipitation: string }> = {
  metric: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
  imperial: { temperature: '°F', wind: 'mph', precipitation: 'in' },
};

export type WeatherReport = {
  place: string;
  /** Where the place came from: named by the agent, or the person's time zone. */
  place_from: 'asked' | 'time_zone';
  latitude: number;
  longitude: number;
  time_zone: string | null;
  units: WeatherUnits;
  unit_labels: { temperature: string; wind: string; precipitation: string };
  current: {
    time: string | null;
    temperature: number | null;
    feels_like: number | null;
    humidity_percent: number | null;
    precipitation: number | null;
    wind_speed: number | null;
    conditions: string;
  };
  today: {
    date: string | null;
    high: number | null;
    low: number | null;
    precipitation_chance_percent: number | null;
    precipitation: number | null;
    conditions: string;
    sunrise: string | null;
    sunset: string | null;
  };
  summary: string;
  source: string;
  source_url: string;
  cached: boolean;
};

export class WeatherUnavailable extends Error {}
export class WeatherPlaceUnknown extends Error {}

type Place = {
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string | null;
};

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Kept answers, oldest first; the first entry goes once the map is full. */
function remember<T>(
  cache: Map<string, { at: number; value: T }>,
  key: string,
  value: T,
  at: number,
) {
  cache.delete(key);
  cache.set(key, { at, value });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export type WeatherReader = {
  read(input: {
    place: string;
    placeFrom: 'asked' | 'time_zone';
    units: WeatherUnits;
    signal?: AbortSignal;
  }): Promise<WeatherReport>;
};

/**
 * One reader per process: its caches and its limit are shared by every
 * conversation, so one person's morning brief saves the next one a call.
 */
export function createWeatherReader(options: {
  get: PublicGet;
  now?: () => number;
  callsPerMinute?: number;
}): WeatherReader {
  const now = options.now ?? Date.now;
  const limit = options.callsPerMinute ?? WEATHER_CALLS_PER_MINUTE;
  const places = new Map<string, { at: number; value: Place | null }>();
  const forecasts = new Map<string, { at: number; value: Record<string, unknown> }>();
  const calls: number[] = [];

  const call = async (url: URL, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const at = now();
    while (calls.length && (calls[0] as number) <= at - 60_000) calls.shift();
    if (calls.length >= limit)
      throw new WeatherUnavailable('The weather service is busy just now. Try again in a minute.');
    calls.push(at);
    let answer: { status: number; body: string };
    try {
      answer = await options.get(url, 'application/json', signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new WeatherUnavailable(
        `The weather service did not answer (${(error as Error).message}).`,
      );
    }
    if (answer.status !== 200)
      throw new WeatherUnavailable(`The weather service answered ${answer.status}.`);
    try {
      return object(JSON.parse(answer.body));
    } catch {
      throw new WeatherUnavailable('The weather service sent something that is not a forecast.');
    }
  };

  /** One name to look up: as written, then the part before the first comma ("Austin, TX"). */
  const geocode = async (place: string, signal?: AbortSignal): Promise<Place | null> => {
    const key = place.toLowerCase();
    const kept = places.get(key);
    if (kept && kept.at > now() - PLACE_MS) return kept.value;
    const tries = [...new Set([place, place.split(',')[0]?.trim() ?? ''])].filter(
      (name) => name.length >= 2,
    );
    let found: Place | null = null;
    for (const name of tries) {
      const url = new URL(GEOCODING);
      url.searchParams.set('name', name);
      url.searchParams.set('count', '1');
      url.searchParams.set('language', 'en');
      url.searchParams.set('format', 'json');
      const hit = object(first((await call(url, signal)).results));
      const latitude = number(hit.latitude);
      const longitude = number(hit.longitude);
      if (latitude === null || longitude === null) continue;
      found = {
        name: [text(hit.name), text(hit.admin1), text(hit.country)]
          .filter((part, index, all): part is string => !!part && all.indexOf(part) === index)
          .join(', '),
        latitude,
        longitude,
        timeZone: text(hit.timezone),
      };
      break;
    }
    remember(places, key, found, now());
    return found;
  };

  const forecast = async (where: Place, units: WeatherUnits, signal?: AbortSignal) => {
    const key = `${where.latitude.toFixed(2)},${where.longitude.toFixed(2)},${units}`;
    const kept = forecasts.get(key);
    if (kept && kept.at > now() - FORECAST_MS) return { body: kept.value, cached: true };
    const url = new URL(FORECAST);
    url.searchParams.set('latitude', String(where.latitude));
    url.searchParams.set('longitude', String(where.longitude));
    url.searchParams.set(
      'current',
      'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    );
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset',
    );
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');
    if (units === 'imperial') {
      url.searchParams.set('temperature_unit', 'fahrenheit');
      url.searchParams.set('wind_speed_unit', 'mph');
      url.searchParams.set('precipitation_unit', 'inch');
    }
    const body = await call(url, signal);
    remember(forecasts, key, body, now());
    return { body, cached: false };
  };

  return {
    async read({ place, placeFrom, units, signal }) {
      const where = await geocode(place, signal);
      if (!where) throw new WeatherPlaceUnknown(`No place called "${place}" was found.`);
      const { body, cached } = await forecast(where, units, signal);
      const current = object(body.current);
      const daily = object(body.daily);
      const labels = LABELS[units];
      const report: WeatherReport = {
        place: where.name,
        place_from: placeFrom,
        latitude: where.latitude,
        longitude: where.longitude,
        time_zone: text(body.timezone) ?? where.timeZone,
        units,
        unit_labels: labels,
        current: {
          time: text(current.time),
          temperature: number(current.temperature_2m),
          feels_like: number(current.apparent_temperature),
          humidity_percent: number(current.relative_humidity_2m),
          precipitation: number(current.precipitation),
          wind_speed: number(current.wind_speed_10m),
          conditions: conditionsOf(current.weather_code),
        },
        today: {
          date: text(first(daily.time)),
          high: number(first(daily.temperature_2m_max)),
          low: number(first(daily.temperature_2m_min)),
          precipitation_chance_percent: number(first(daily.precipitation_probability_max)),
          precipitation: number(first(daily.precipitation_sum)),
          conditions: conditionsOf(first(daily.weather_code)),
          sunrise: text(first(daily.sunrise)),
          sunset: text(first(daily.sunset)),
        },
        summary: '',
        source: WEATHER_SOURCE,
        source_url: WEATHER_SOURCE_URL,
        cached,
      };
      report.summary = weatherSummary(report);
      return report;
    },
  };
}

const round = (value: number | null) => (value === null ? null : Math.round(value));

/** One line a brief can use as it is: now, then today. */
export function weatherSummary(report: WeatherReport): string {
  const t = report.unit_labels.temperature;
  const now = report.current;
  const today = report.today;
  const parts: string[] = [];
  const temperature = round(now.temperature);
  if (temperature !== null) {
    const feels = round(now.feels_like);
    parts.push(
      `${report.place} now: ${temperature}${t}${feels !== null && feels !== temperature ? ` (feels like ${feels}${t})` : ''}, ${now.conditions}`,
    );
    const wind = round(now.wind_speed);
    if (wind !== null) parts[parts.length - 1] += `, wind ${wind} ${report.unit_labels.wind}`;
  }
  const high = round(today.high);
  const low = round(today.low);
  if (high !== null && low !== null) {
    const chance = today.precipitation_chance_percent;
    parts.push(
      `Today: ${today.conditions}, high ${high}${t}, low ${low}${t}${chance !== null ? `, ${Math.round(chance)}% chance of rain or snow` : ''}`,
    );
  }
  if (report.place_from === 'time_zone')
    parts.push('The place is the city of the time zone in your profile');
  return parts.length ? `${parts.join('. ')}.` : `No forecast came back for ${report.place}.`;
}
