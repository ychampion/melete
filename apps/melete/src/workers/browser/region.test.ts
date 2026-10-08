import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { BrowserSessionService } from './routes.ts';
import { browserRegion } from './sessions.ts';

const service = (rows: Array<{ time_zone: string }>) =>
  new BrowserSessionService((async () => rows) as unknown as Sql, {
    get: async () => {
      throw new Error('no worker in this test');
    },
  });

test("the browser takes the person's time zone from their profile", async () => {
  expect(await service([{ time_zone: 'America/Los_Angeles' }]).region('sp_person')).toEqual({
    locale: 'en-US',
    timezone_id: 'America/Los_Angeles',
  });
});

test('without a profile, or with a zone Chromium would refuse, the place is neutral', async () => {
  expect(await service([]).region('sp_person')).toEqual({ locale: 'en-US', timezone_id: 'UTC' });
  expect(browserRegion({ locale: 'not a locale!', timezone_id: 'Mars/Olympus' })).toEqual({
    locale: 'en-US',
    timezone_id: 'UTC',
  });
  expect(browserRegion({ locale: 'en-gb', timezone_id: 'Europe/London' })).toEqual({
    locale: 'en-GB',
    timezone_id: 'Europe/London',
  });
});
