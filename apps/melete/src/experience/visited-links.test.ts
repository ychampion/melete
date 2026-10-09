import { describe, expect, test } from 'bun:test';
import { checkCitations, sourcesRead } from './citations.ts';
import { linkable, linksFor, pagesVisited, withVisitedLinks } from './visited-links.ts';

const FLIGHTS =
  'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTEwLTE2agcIARIDU0ZPcgcIARIDSkZL';

const opened = (address: string, window: string) => ({
  kind: 'computer.open',
  receipt: { detail: { computer: 'open', navigated: true, address, window } },
  payload: { url: address },
});

describe('pages a turn visited', () => {
  test('fetched pages, opened pages and opens inside a batch count; searches and failed opens do not', () => {
    const pages = pagesVisited([
      {
        kind: 'web.fetch',
        receipt: {
          detail: {
            url: 'https://t.co/x',
            final_url: 'https://www.adafruit.com/product/5813',
            title: 'Raspberry Pi 5 - 8GB RAM : ID 5813 : Adafruit Industries',
          },
        },
      },
      opened(FLIGHTS, 'Google Flights - Find Cheap Flight Options - Chromium'),
      {
        kind: 'computer.open',
        receipt: { detail: { navigated: false, address: 'https://cnet.com/x' } },
      },
      {
        kind: 'computer.batch',
        receipt: {
          detail: {
            steps: [
              { computer: 'click' },
              {
                computer: 'open',
                navigated: true,
                address: 'https://www.google.com/maps/dir/Union+Square/SFO',
                window: 'Google Maps - Chromium',
              },
              { computer: 'open', navigated: false, address: 'https://bing.com/' },
            ],
          },
        },
      },
      {
        kind: 'web.search',
        receipt: { detail: { results: [{ url: 'https://kayak.com/a', title: 'KAYAK' }] } },
      },
    ]);
    expect(pages.map((page) => page.url)).toEqual([
      'https://www.adafruit.com/product/5813',
      FLIGHTS,
      'https://www.google.com/maps/dir/Union+Square/SFO',
    ]);
  });

  test('a page opened inside a batch also backs a citation', () => {
    const read = sourcesRead([
      {
        kind: 'computer.batch',
        receipt: {
          detail: {
            steps: [{ computer: 'open', navigated: true, address: 'https://www.rtings.com/tv' }],
          },
        },
      },
    ]);
    expect(checkCitations('Best TV (via rtings.com).', read).unbacked).toEqual([]);
  });
});

describe('links an answer gets', () => {
  test('a fare named on a page the turn opened is linked to the address it opened', () => {
    const answer =
      'Cheapest non-stop on Google Flights: American, $370, 3:28 PM to 11:59 PM. Alaska is $382.';
    const out = withVisitedLinks(
      answer,
      pagesVisited([opened(FLIGHTS, 'Google Flights - Find Cheap Flight Options - Chromium')]),
    );
    expect(out).toBe(`${answer}\n\nLinks: [Google Flights](${FLIGHTS})`);
  });

  test('a product named by its page title is linked, with no link for a site it only searched', () => {
    const pages = pagesVisited([
      {
        kind: 'web.fetch',
        receipt: {
          detail: {
            final_url: 'https://www.adafruit.com/product/5813',
            title: 'Raspberry Pi 5 - 8GB RAM : ID 5813 : Adafruit Industries',
          },
        },
      },
      {
        kind: 'web.search',
        receipt: {
          detail: {
            results: [{ url: 'https://www.pishop.us/pi5', title: 'PiShop Raspberry Pi 5' }],
          },
        },
      },
    ]);
    const out = withVisitedLinks(
      'The Raspberry Pi 5 8 GB is $200.00 and in stock. PiShop lists it too.',
      pages,
    );
    expect(out).toEndWith('Links: [Raspberry Pi 5](https://www.adafruit.com/product/5813)');
    expect(out).not.toContain('pishop.us');
  });

  test('no link for a source the turn never opened', () => {
    const answer = 'Kayak shows $365 for the same flight, per Expedia.';
    const pages = pagesVisited([
      opened(FLIGHTS, 'Google Flights - Chromium'),
      {
        kind: 'web.search',
        receipt: {
          detail: { results: [{ url: 'https://www.kayak.com/flights', title: 'KAYAK' }] },
        },
      },
    ]);
    expect(withVisitedLinks(answer, pages)).toBe(answer);
  });

  test('an answer that already links keeps its own links', () => {
    const answer = 'American is $370 on [Google Flights](https://www.google.com/travel/flights).';
    expect(withVisitedLinks(answer, pagesVisited([opened(FLIGHTS, 'Google Flights')]))).toBe(
      answer,
    );
    const bare = 'Raspberry Pi 5: $200, adafruit.com/product/5813.';
    expect(
      withVisitedLinks(
        bare,
        pagesVisited([
          opened('https://www.adafruit.com/product/5813', 'Raspberry Pi 5 - Adafruit'),
        ]),
      ),
    ).toBe(bare);
  });

  test('a page the answer does not talk about is not linked', () => {
    const answer = 'It is 18°C and sunny.';
    expect(
      withVisitedLinks(answer, pagesVisited([opened('https://www.adafruit.com/', 'Adafruit')])),
    ).toBe(answer);
  });

  test('several pages of one site named by title are each linked, capped at three', () => {
    const wiki = (city: string) =>
      opened(`https://en.wikipedia.org/wiki/${city}`, `${city}, California - Wikipedia - Chromium`);
    const links = linksFor(
      'Berkeley has 121,911 people, Oakland 440,838, Fremont 226,442 and Hayward 158,000.',
      pagesVisited([wiki('Berkeley'), wiki('Oakland'), wiki('Fremont'), wiki('Hayward')]),
    );
    expect(links.map((link) => link.label)).toEqual(['Berkeley', 'Oakland', 'Fremont']);
  });

  test('a site named only by name gets its last opened page, once', () => {
    const links = linksFor(
      'On Google Maps, BART from Powell St leaves 8:11 and arrives 8:42, $11.80.',
      pagesVisited([
        opened('https://www.google.com/maps', 'Google Maps'),
        opened(
          'https://www.google.com/maps/dir/Union+Square,+San+Francisco/SFO/data=!4m2!4m1!3e3',
          'Union Square to SFO - Google Maps',
        ),
      ]),
    );
    expect(links).toEqual([
      {
        label: 'Union Square to SFO',
        url: 'https://www.google.com/maps/dir/Union+Square,+San+Francisco/SFO/data=!4m2!4m1!3e3',
      },
    ]);
  });

  test('the same input always gives the same output', () => {
    const pages = pagesVisited([opened(FLIGHTS, 'Google Flights')]);
    const answer = 'Google Flights has American at $370.';
    expect(withVisitedLinks(answer, pages)).toBe(withVisitedLinks(answer, pages));
  });
});

describe('addresses that may be linked', () => {
  test('public web pages keep their query, lose their fragment', () => {
    expect(linkable('https://www.google.com/travel/flights?q=SFO#top')?.href).toBe(
      'https://www.google.com/travel/flights?q=SFO',
    );
  });

  test('credentials, sign-in tokens, local names and other schemes are never linked', () => {
    for (const address of [
      'https://user:pass@example.org/a',
      'https://app.example.org/cb#access_token=abc',
      'https://app.example.org/oauth?code=abc&state=xyz',
      'http://localhost:3000/',
      'http://192.168.1.4/admin',
      'http://router.local/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome-error://chromewebdata/',
    ])
      expect(linkable(address)).toBeNull();
  });

  test('an address with parentheses stays one Markdown link', () => {
    const out = withVisitedLinks(
      'Mercury (planet) is the smallest planet.',
      pagesVisited([
        opened('https://en.wikipedia.org/wiki/Mercury_(planet)', 'Mercury (planet) - Wikipedia'),
      ]),
    );
    expect(out).toEndWith(
      'Links: [Mercury (planet)](https://en.wikipedia.org/wiki/Mercury_%28planet%29)',
    );
  });
});
