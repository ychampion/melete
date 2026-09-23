import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

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

  test('each migration has its schema snapshot, and each snapshot follows the one before it', () => {
    // `drizzle-kit generate` diffs the schema against the newest snapshot. A
    // migration written by hand without one leaves that snapshot behind, and
    // every later branch generates the missing migration again as its own.
    let previous: string | undefined;
    for (const entry of journal.entries) {
      const file = new URL(
        `../../drizzle/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`,
        import.meta.url,
      );
      expect([entry.tag, existsSync(file)]).toEqual([entry.tag, true]);
      const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { id: string; prevId: string };
      if (previous !== undefined)
        expect([entry.tag, snapshot.prevId]).toEqual([entry.tag, previous]);
      previous = snapshot.id;
    }
  });
});
