/**
 * Conformance scenario 7 at the level of one package: a retracted record leaves
 * retrieval at once and stays gone. The full scenario retracts a record while a
 * job is running and then restarts the stack; here the running job is an index
 * handle that stays open across the retraction, and the restart is reopening
 * the index file from disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aRecord, fixedClock, IDS } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import { SpaceIndex } from './fts.ts';
import type { SpacePaths } from './layout.ts';
import { hardDelete, retract } from './records.ts';
import { commitRecord, history, initSpace } from './space.ts';
import { buildIndex, loadSpace } from './store.ts';

let root: string;
let paths: SpacePaths;
const now = fixedClock();

const RETRACTED = 'The lease was renewed, so the renewal window is wrong.';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-retract-'));
  paths = await initSpace(root, 'personal');

  await commitRecord(
    paths,
    'knowledge/landlord-contact.md',
    serializeRecord(
      aRecord({ id: IDS.landlord, title: 'Landlord contact and renewal window', type: 'fact' }),
      'The lease renews in March. The landlord answers email but never the phone.',
    ),
    { proposedBy: 'user', now },
  );
  await commitRecord(
    paths,
    'knowledge/prefers-bun.md',
    serializeRecord(aRecord({ id: IDS.bun }), 'Zara uses bun for every package operation.'),
    { proposedBy: 'user', now },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const findLandlord = () => {
  const record = loadSpace(paths).records.find((r) => r.frontmatter.id === IDS.landlord);
  if (!record) throw new Error('the fixture record is missing');
  return record;
};

describe('retracting a record while a job is running', () => {
  test('the running job stops seeing it, and it is absent rather than filtered', async () => {
    const { index } = buildIndex(paths);
    try {
      expect(index.search('landlord')).toHaveLength(1);

      await retract(paths, index, findLandlord(), { reason: RETRACTED, by: 'zara', now });

      // The handle the job is holding, mid-run.
      expect(index.search('landlord')).toEqual([]);
      expect(index.has(IDS.landlord)).toBe(false);
      // The rest of the space is untouched.
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('it is still gone after the index is reloaded from disk', async () => {
    const first = buildIndex(paths);
    await retract(paths, first.index, findLandlord(), { reason: RETRACTED, by: 'zara', now });
    first.index.close();

    const reopened = SpaceIndex.open(paths);
    try {
      expect(reopened.search('landlord')).toEqual([]);
      expect(reopened.has(IDS.landlord)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  test('and gone again when the index is rebuilt from the files', async () => {
    const first = buildIndex(paths);
    await retract(paths, first.index, findLandlord(), { reason: RETRACTED, by: 'zara', now });
    first.index.close();

    const rebuilt = buildIndex(paths);
    try {
      expect(rebuilt.index.search('landlord')).toEqual([]);
      expect(rebuilt.index.count()).toBe(1);
    } finally {
      rebuilt.index.close();
    }
  });

  test('the text and the reason stay readable, in the file and in git', async () => {
    const { index } = buildIndex(paths);
    try {
      await retract(paths, index, findLandlord(), { reason: RETRACTED, by: 'zara', now });
    } finally {
      index.close();
    }

    const file = readFileSync(join(paths.knowledge, 'landlord-contact.md'), 'utf8');
    expect(file).toContain('status: retracted');
    expect(file).toContain('The lease renews in March.');
    expect(file).toContain(RETRACTED);

    const entries = await history(paths, 'knowledge/landlord-contact.md');
    expect(entries[0]?.subject).toContain('Retract');
    expect(entries[0]?.proposedBy).toBe('zara');
    expect(entries).toHaveLength(2);
  });

  test('a retracted record cannot be retracted again', async () => {
    const { index } = buildIndex(paths);
    try {
      await retract(paths, index, findLandlord(), { reason: RETRACTED, by: 'zara', now });
      await expect(
        retract(paths, index, findLandlord(), { reason: 'again', by: 'zara', now }),
      ).rejects.toThrow('is already retracted');
    } finally {
      index.close();
    }
  });

  test('retraction closes the validity window if it was open', async () => {
    const { index } = buildIndex(paths);
    try {
      await retract(paths, index, findLandlord(), { reason: RETRACTED, by: 'zara', now });
    } finally {
      index.close();
    }
    const record = loadSpace(paths).records.find((r) => r.frontmatter.id === IDS.landlord);
    expect(record?.frontmatter.valid_until).toBe('2026-09-11');
  });
});

describe('deleting a record outright', () => {
  test('removes the file, commits the removal, and rebuilds the index in one call', async () => {
    const { index } = buildIndex(paths);
    try {
      const result = await hardDelete(paths, index, findLandlord(), {
        reason: 'the owner asked for it to be gone',
        by: 'zara',
        now,
      });

      expect(result.commit.committed).toBe(true);
      expect(existsSync(join(paths.knowledge, 'landlord-contact.md'))).toBe(false);
      expect(index.search('landlord')).toEqual([]);
      expect(index.count()).toBe(1);
      expect(result.contents.records).toHaveLength(1);
      expect(loadSpace(paths).records.map((r) => r.frontmatter.id)).toEqual([IDS.bun]);
    } finally {
      index.close();
    }
  });

  test('the removal is in git, so it is auditable and reversible', async () => {
    const { index } = buildIndex(paths);
    try {
      await hardDelete(paths, index, findLandlord(), {
        reason: 'the owner asked for it to be gone',
        by: 'zara',
        now,
      });
    } finally {
      index.close();
    }

    const entries = await history(paths, 'knowledge/landlord-contact.md');
    expect(entries[0]?.subject).toContain('the owner asked for it to be gone');
    expect(entries[0]?.proposedBy).toBe('zara');
  });
});
