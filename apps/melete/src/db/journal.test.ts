import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { idx: number; when: number; tag: string };
const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Entry[] };

/** From this entry on, each migration takes the next value, whatever clock generated it. */
const SEQUENCE_START = 1789232400000;

describe('migration journal order', () => {
  test('each migration sorts after the one before it and takes the next value in sequence', () => {
    // The migrator applies a migration only when its `when` is greater than the
    // newest one a database has already recorded. A generated wall-clock value
    // sorts after every later migration numbered in sequence, so a database
    // that applied it would silently skip those migrations on upgrade.
    const entries = journal.entries;
    for (const [index, entry] of entries.entries()) {
      expect([entry.tag, entry.idx]).toEqual([entry.tag, index]);
      if (index > 0) expect(entry.when).toBeGreaterThan(entries[index - 1]?.when ?? 0);
    }
    const first = entries.findIndex((entry) => entry.when === SEQUENCE_START);
    expect(first).toBeGreaterThan(-1);
    for (const [offset, entry] of entries.slice(first).entries())
      expect([entry.tag, entry.when]).toEqual([entry.tag, SEQUENCE_START + offset]);
  });
});
