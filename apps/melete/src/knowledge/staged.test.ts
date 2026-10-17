import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as knowledge from '@melete/knowledge';
import { STAGED_WRITE_DAYS } from '@melete/knowledge';
import { ItemFailures } from '../ops/item-failures.ts';
import { startStagedWriteSweep, sweepStagedWrites } from './staged.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T10:00:00Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A staged write in `<root>/<space>/.proposed/`, its file written `daysAgo` before NOW. */
function stage(root: string, space: string, name: string, daysAgo: number): string {
  const dir = join(root, space, '.proposed');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ id: name.replace(/\.json$/, ''), content: 'the text' }));
  const at = new Date(NOW - daysAgo * DAY_MS);
  utimesSync(file, at, at);
  return file;
}

function spacesRoot() {
  const root = mkdtempSync(join(tmpdir(), 'melete-staged-'));
  roots.push(root);
  return root;
}

describe('writes staged in a space that nothing applied', () => {
  test(`go after ${STAGED_WRITE_DAYS} days, in every space, and nothing else does`, async () => {
    const root = spacesRoot();
    const old = stage(root, 'sp_a', 'prop_01AAAAAAAAAAAAAAAAAAAAAAAA.json', STAGED_WRITE_DAYS + 1);
    const recent = stage(
      root,
      'sp_a',
      'prop_01BBBBBBBBBBBBBBBBBBBBBBBB.json',
      STAGED_WRITE_DAYS - 1,
    );
    const otherSpace = stage(root, 'sp_b', 'prop_01CCCCCCCCCCCCCCCCCCCCCCCC.json', 30);
    // Not a space's folder, and not a staged file: both are left alone.
    const notASpace = stage(root, 'notes', 'prop_01DDDDDDDDDDDDDDDDDDDDDDDD.json', 30);
    const notStaged = stage(root, 'sp_a', 'keep.json', 30);

    expect(await sweepStagedWrites(root, NOW)).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(otherSpace)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(notASpace)).toBe(true);
    expect(existsSync(notStaged)).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'a space that is a link to somewhere else is not swept',
    async () => {
      const root = spacesRoot();
      const elsewhere = spacesRoot();
      const outside = stage(elsewhere, 'target', 'prop_01EEEEEEEEEEEEEEEEEEEEEEEE.json', 30);
      symlinkSync(join(elsewhere, 'target'), join(root, 'sp_link'));
      expect(await sweepStagedWrites(root, NOW)).toBe(0);
      expect(existsSync(outside)).toBe(true);
    },
  );

  test('a missing spaces folder sweeps nothing', async () => {
    expect(await sweepStagedWrites(join(spacesRoot(), 'absent'), NOW)).toBe(0);
  });

  for (const leading of [false, true])
    test(`the sweep ${leading ? 'runs' : 'does nothing'} when this instance ${leading ? 'leads' : 'does not lead'}`, async () => {
      const root = spacesRoot();
      const old = stage(root, 'sp_a', 'prop_01FFFFFFFFFFFFFFFFFFFFFFFF.json', 365);
      const said: string[] = [];
      const stop = startStagedWriteSweep(
        root,
        () => leading,
        (line) => said.push(line),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      stop();
      expect(existsSync(old)).toBe(!leading);
      expect(said).toEqual([]);
    });

  test('a space whose staged writes cannot be removed never stops the sweep of the others', async () => {
    const root = spacesRoot();
    const old = ['sp_a', 'sp_b', 'sp_c', 'sp_d'].map((space) =>
      stage(root, space, 'prop_01GGGGGGGGGGGGGGGGGGGGGGGG.json', 365),
    );
    stage(root, 'sp_held', 'prop_01HHHHHHHHHHHHHHHHHHHHHHHH.json', 365);
    const expire = knowledge.expireProposals;
    const refused = spyOn(knowledge, 'expireProposals').mockImplementation((paths, before) => {
      if (paths.space === 'sp_held') throw new Error('operation not permitted');
      return expire(paths, before);
    });
    const said: string[] = [];
    const failures = new ItemFailures('staged write sweep', {
      firstMs: 3_600_000,
      maxMs: 3_600_000,
      say: (line) => said.push(line),
    });
    try {
      expect(await sweepStagedWrites(root, NOW, STAGED_WRITE_DAYS, failures)).toBe(4);
    } finally {
      refused.mockRestore();
    }
    for (const file of old) expect(existsSync(file)).toBe(false);
    expect(said).toEqual([
      'staged write sweep: sp_held failed (operation not permitted); the others carry on, and it is tried again in 1 h',
    ]);
  });
});
