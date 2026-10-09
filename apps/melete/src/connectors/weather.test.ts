import { describe, expect, test } from 'bun:test';
import { BrokerFault } from '../broker/errors.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';
import {
  createWeatherReader,
  placeForTimeZone,
  unitsForTimeZone,
  WEATHER_CALLS_PER_MINUTE,
  type WeatherReport,
} from './weather.ts';
import { createWebConnector, webManifest } from './web.ts';

const SAN_FRANCISCO = {
  results: [
    {
      name: 'San Francisco',
      admin1: 'California',
      country: 'United States',
      latitude: 37.77493,
      longitude: -122.41942,
      timezone: 'America/Los_Angeles',
    },
  ],
};
const FORECAST = {
  timezone: 'America/Los_Angeles',
  current: {
    time: '2026-10-09T08:00',
    temperature_2m: 61.4,
    apparent_temperature: 59.8,
    relative_humidity_2m: 78,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 9.2,
  },
  daily: {
    time: ['2026-10-09'],
    weather_code: [61],
    temperature_2m_max: [68.2],
    temperature_2m_min: [55.1],
    precipitation_probability_max: [40],
    precipitation_sum: [0.08],
    sunrise: ['2026-10-09T07:12'],
    sunset: ['2026-10-09T18:41'],
  },
};

/** A stand-in for Open-Meteo that records what was asked. */
function openMeteo(geocoding: unknown = SAN_FRANCISCO) {
  const calls: URL[] = [];
  const get = async (url: URL) => {
    calls.push(url);
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      const name = url.searchParams.get('name') ?? '';
      return {
        status: 200,
        body: JSON.stringify(
          /^(?:san francisco|los angeles)$/i.test(name) ? geocoding : { results: [] },
        ),
      };
    }
    if (url.hostname === 'api.open-meteo.com')
      return { status: 200, body: JSON.stringify(FORECAST) };
    return { status: 404, body: '' };
  };
  return { calls, get };
}

describe('the place and units the weather is read for', () => {
  test('a United States time zone reads Fahrenheit, mph and inches; anywhere else is metric', () => {
    expect(unitsForTimeZone('America/Los_Angeles')).toBe('imperial');
    expect(unitsForTimeZone('America/Indiana/Indianapolis')).toBe('imperial');
    expect(unitsForTimeZone('Pacific/Honolulu')).toBe('imperial');
    expect(unitsForTimeZone('America/Toronto')).toBe('metric');
    expect(unitsForTimeZone('Europe/London')).toBe('metric');
    expect(unitsForTimeZone(null)).toBe('metric');
  });

  test('a time zone names its city, and UTC names none', () => {
    expect(placeForTimeZone('America/Los_Angeles')).toBe('Los Angeles');
    expect(placeForTimeZone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(placeForTimeZone('UTC')).toBeNull();
    expect(placeForTimeZone('Etc/GMT+5')).toBeNull();
  });
});

describe('reading the weather from Open-Meteo', () => {
  test('the place is found, then today is read in the units asked for, and said in one line', async () => {
    const service = openMeteo();
    const reader = createWeatherReader({ get: service.get });
    const report = await reader.read({
      place: 'San Francisco, CA',
      placeFrom: 'asked',
      units: 'imperial',
    });
    // "San Francisco, CA" is not a name Open-Meteo knows; the part before the comma is.
    expect(service.calls.map((url) => url.searchParams.get('name')).filter(Boolean)).toEqual([
      'San Francisco, CA',
      'San Francisco',
    ]);
    const forecast = service.calls.find((url) => url.hostname === 'api.open-meteo.com');
    expect(forecast?.searchParams.get('temperature_unit')).toBe('fahrenheit');
    expect(forecast?.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(forecast?.searchParams.get('precipitation_unit')).toBe('inch');
    expect(forecast?.searchParams.get('forecast_days')).toBe('1');
    expect(report).toMatchObject({
      place: 'San Francisco, California, United States',
      units: 'imperial',
      unit_labels: { temperature: '°F', wind: 'mph', precipitation: 'in' },
      current: { temperature: 61.4, conditions: 'partly cloudy' },
      today: { high: 68.2, low: 55.1, precipitation_chance_percent: 40, conditions: 'light rain' },
      source: 'Open-Meteo',
      source_url: 'https://open-meteo.com/',
      cached: false,
    } satisfies Partial<Record<keyof WeatherReport, unknown>>);
    expect(report.summary).toBe(
      'San Francisco, California, United States now: 61°F (feels like 60°F), partly cloudy, wind 9 mph. Today: light rain, high 68°F, low 55°F, 40% chance of rain or snow.',
    );
  });

  test('metric asks Open-Meteo for its defaults, and a place from the time zone says so', async () => {
    const service = openMeteo();
    const report = await createWeatherReader({ get: service.get }).read({
      place: 'San Francisco',
      placeFrom: 'time_zone',
      units: 'metric',
    });
    const forecast = service.calls.find((url) => url.hostname === 'api.open-meteo.com');
    expect(forecast?.searchParams.has('temperature_unit')).toBe(false);
    expect(report.unit_labels.temperature).toBe('°C');
    expect(report.summary).toContain('The place is the city of the time zone in your profile');
  });

  test('a second read within ten minutes is answered from what was kept', async () => {
    let now = 1_000_000;
    const service = openMeteo();
    const reader = createWeatherReader({ get: service.get, now: () => now });
    const input = { place: 'San Francisco', placeFrom: 'asked' as const, units: 'metric' as const };
    await reader.read(input);
    const second = await reader.read(input);
    expect(second.cached).toBe(true);
    expect(service.calls).toHaveLength(2);
    now += 11 * 60_000;
    expect((await reader.read(input)).cached).toBe(false);
    // The place itself is kept for a day, so only the forecast is read again.
    expect(service.calls).toHaveLength(3);
  });

  test('past the calls a minute allows, it says the service is busy instead of calling', async () => {
    const service = openMeteo();
    const reader = createWeatherReader({ get: service.get, callsPerMinute: 2 });
    await reader.read({ place: 'San Francisco', placeFrom: 'asked', units: 'metric' });
    await expect(
      reader.read({ place: 'San Francisco', placeFrom: 'asked', units: 'imperial' }),
    ).rejects.toThrow('busy');
    expect(service.calls).toHaveLength(2);
    expect(WEATHER_CALLS_PER_MINUTE).toBeGreaterThan(2);
  });

  test('a place Open-Meteo does not know is said plainly', async () => {
    const reader = createWeatherReader({ get: openMeteo().get });
    await expect(
      reader.read({ place: 'Atlantis', placeFrom: 'asked', units: 'metric' }),
    ).rejects.toThrow('No place called "Atlantis" was found.');
  });
});

describe('web.weather', () => {
  const reads = async () => null;
  const allowed = async () => null;

  test('is a read the agent can use without asking anyone', () => {
    const tool = webManifest.tools.find((entry) => entry.name === 'web.weather');
    expect(tool).toMatchObject({ effect_class: 'read', requires_approval: false });
  });

  test('with no place named, it reads the city and units of the person’s time zone', async () => {
    const service = openMeteo();
    const asked: string[] = [];
    const connector = createWebConnector({
      publicReads: reads,
      searchPrivacy: async ({ query }) => {
        asked.push(query);
        return null;
      },
      weather: createWeatherReader({ get: service.get }),
      profile: async () => ({ timeZone: 'America/Los_Angeles' }),
    });
    const action = connectorAction('web.weather', {});
    const ctx = connectorContext(action);
    expect(await connector.prepare?.({}, ctx, (() => []) as never, 'web.weather')).toEqual({});
    const result = await connector.execute(action, ctx);
    if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
    expect(result.receipt.detail).toMatchObject({
      place_from: 'time_zone',
      units: 'imperial',
      source: 'Open-Meteo',
    });
    // The place went out only after the same check a search query passes.
    expect(asked).toEqual(['Los Angeles', 'Los Angeles']);
  });

  test('the person’s stated units win over their region’s', async () => {
    const service = openMeteo();
    const connector = createWebConnector({
      publicReads: reads,
      searchPrivacy: allowed,
      weather: createWeatherReader({ get: service.get }),
      profile: async () => ({ timeZone: 'America/Los_Angeles' }),
    });
    const action = connectorAction('web.weather', { place: 'San Francisco', units: 'metric' });
    const result = await connector.execute(action, connectorContext(action));
    if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
    expect(result.receipt.detail).toMatchObject({ units: 'metric', place_from: 'asked' });
  });

  test('with no place and no time zone, it asks the agent to find out where the person is', async () => {
    const connector = createWebConnector({
      publicReads: reads,
      searchPrivacy: allowed,
      weather: createWeatherReader({ get: openMeteo().get }),
      profile: async () => ({ timeZone: 'UTC' }),
    });
    const action = connectorAction('web.weather', {});
    const fault = await connector
      .prepare?.({}, connectorContext(action), (() => []) as never, 'web.weather')
      .catch((error: unknown) => error);
    expect(fault).toBeInstanceOf(BrokerFault);
    expect((fault as BrokerFault).message).toContain('ask them where they are');
  });

  test('a private conversation sends no place out', async () => {
    const service = openMeteo();
    const connector = createWebConnector({
      publicReads: reads,
      weather: createWeatherReader({ get: service.get }),
    });
    const action = connectorAction('web.weather', { place: 'San Francisco' });
    const result = await connector.execute(action, connectorContext(action));
    expect(result.outcome).toBe('failed');
    expect(service.calls).toHaveLength(0);
  });
});
