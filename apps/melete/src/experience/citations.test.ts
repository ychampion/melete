import { describe, expect, test } from 'bun:test';
import { checkCitations, sourcesRead } from './citations.ts';

const fetched = (url: string, title?: string) => ({
  kind: 'web.fetch',
  receipt: { detail: { url, final_url: url, title: title ?? null } },
});

describe('what a turn read', () => {
  test('pages fetched, pages opened in a browser and the weather service count; a search does not', () => {
    const read = sourcesRead([
      fetched('https://www.nist.gov/pml/time-and-frequency-division/dst', 'Daylight Saving Time'),
      {
        kind: 'web.fetch',
        receipt: {
          detail: {
            url: 'https://t.co/x',
            final_url: 'https://www.theverge.com/a',
            visited_urls: ['https://t.co/x', 'https://www.theverge.com/a'],
          },
        },
      },
      { kind: 'computer.open', receipt: { detail: { url: 'https://rtings.com/vacuum' } } },
      {
        kind: 'computer.open',
        receipt: { detail: { url: 'https://cnet.com/x', navigated: false } },
      },
      {
        kind: 'web.weather',
        receipt: { detail: { source: 'Open-Meteo', source_url: 'https://open-meteo.com/' } },
      },
      {
        kind: 'web.search',
        receipt: { detail: { results: [{ url: 'https://bloomberg.com/a', title: 'Bloomberg' }] } },
      },
    ]);
    const urls = read.map((source) => source.url);
    expect(urls).toContain('https://www.nist.gov/pml/time-and-frequency-division/dst');
    expect(urls).toContain('https://www.theverge.com/a');
    expect(urls).toContain('https://rtings.com/vacuum');
    expect(urls).toContain('https://open-meteo.com/');
    // A window that never changed read nothing, and a search result was never opened.
    expect(urls).not.toContain('https://cnet.com/x');
    expect(urls).not.toContain('https://bloomberg.com/a');
  });
});

describe('citations an answer keeps', () => {
  const aggregators = sourcesRead([
    fetched('https://aibriefs.news/today', 'AI Briefs — today'),
    fetched('https://www.malpass.co/ai', 'Malpass AI roundup'),
  ]);

  test('a briefing that credits outlets it never opened loses those credits and says so', () => {
    const answer = [
      'Your AI news for Friday:',
      '',
      '1. **OpenAI ships a new model** (per Bloomberg).',
      '2. **Chip export rules tighten** (via aibriefs.news).',
      '',
      'Sources:',
      '- Bloomberg',
      '- [VentureBeat](https://venturebeat.com/ai/story)',
      '- [AI Briefs](https://aibriefs.news/today)',
    ].join('\n');
    const checked = checkCitations(answer, aggregators);
    expect(checked.unbacked).toEqual(['Bloomberg', 'VentureBeat']);
    expect(checked.text).toContain('**OpenAI ships a new model**.');
    expect(checked.text).not.toContain('(per Bloomberg)');
    // What the turn did read stays, link and all.
    expect(checked.text).toContain('(via aibriefs.news)');
    expect(checked.text).toContain('- [AI Briefs](https://aibriefs.news/today)');
    expect(checked.text).not.toContain('venturebeat.com');
    expect(checked.text).not.toContain('- Bloomberg');
    expect(checked.text).toContain(
      'Not cited, because nothing here was read from them: Bloomberg, VentureBeat.',
    );
  });

  test('an outlet named in words is backed by a site the turn read with that name', () => {
    const read = sourcesRead([
      fetched('https://www.tomsguide.com/best-picks/robot-vacuums', 'Best robot vacuums'),
      fetched('https://www.rtings.com/vacuum/reviews/best', 'The 6 Best Robot Vacuums'),
      fetched('https://www.nist.gov/pml/time-and-frequency-division/dst', 'DST rules'),
    ]);
    const answer = [
      "Source: NIST's Daylight Saving Time Rules page.",
      'According to RTINGS, the T90 cleans best. (source: Tom’s Guide)',
    ].join('\n');
    const checked = checkCitations(answer, read);
    expect(checked.unbacked).toEqual([]);
    expect(checked.text).toBe(answer);
  });

  test('a link or a site in an attribution needs the site to have been read', () => {
    const read = sourcesRead([fetched('https://www.almanac.com/daylight-saving-time-ends')]);
    const answer =
      'Clocks go back on November 1 (per nationaltaxtools.com, read today). According to [NIST](https://www.nist.gov/dst), it is 2 a.m. local time ([almanac.com](https://www.almanac.com/daylight-saving-time-ends)).';
    const checked = checkCitations(answer, read);
    expect(checked.unbacked).toEqual(['nationaltaxtools.com', 'NIST']);
    expect(checked.text).toStartWith('Clocks go back on November 1. According to NIST, it is');
    expect(checked.text).toContain(
      '([almanac.com](https://www.almanac.com/daylight-saving-time-ends))',
    );
  });

  test('a heading with nothing backed under it goes with its list', () => {
    const checked = checkCitations(
      ['Here is the plan.', '', '**Sources**', '- [CNET](https://cnet.com/x)', '- Wired'].join(
        '\n',
      ),
      [],
    );
    expect(checked.text).not.toContain('**Sources**');
    expect(checked.text).toStartWith('Here is the plan.\n\nNot cited');
    expect(checked.unbacked).toEqual(['CNET', 'Wired']);
  });

  test('ordinary words, links that cite nothing, the person’s own things and code are left alone', () => {
    const answer = [
      'It costs about $250 per day (per person, roughly) and opens at 9 (from 2019 on).',
      'Book at [Sushi Saito](https://sushisaito.example/booking) before Friday.',
      'Source: your notes from Tuesday.',
      '```',
      'Source: Bloomberg',
      '```',
    ].join('\n');
    const checked = checkCitations(answer, []);
    expect(checked.unbacked).toEqual([]);
    expect(checked.text).toBe(answer);
  });

  test('the same answer and reads always give the same result', () => {
    const answer = 'Rates rose (per Reuters). Sources: Reuters, aibriefs.news';
    const first = checkCitations(answer, aggregators);
    expect(checkCitations(answer, aggregators)).toEqual(first);
    expect(first.unbacked).toEqual(['Reuters']);
    // A line that cites a read page and an unread outlet keeps the line, flagged.
    expect(first.text).toContain('Sources: Reuters, aibriefs.news');
  });
});
