/**
 * Test support: one well-formed record to vary, and the ids the suites share.
 * Not exported from the package barrel, because nothing outside the tests
 * should be building records from a template.
 */
import { cpSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { type SpacePaths, spacePaths } from './layout.ts';
import { initSpace } from './space.ts';

/** Each test copies an independent real Git history instead of rebuilding the same seed. */
export async function seededSpace(prepare?: (paths: SpacePaths) => Promise<void>) {
  const parent = realpathSync(tmpdir());
  const templateRoot = mkdtempSync(join(parent, 'melete-seeded-space-'));
  const paths = await initSpace(templateRoot, 'personal');
  await prepare?.(paths);
  return {
    copy(root: string): SpacePaths {
      cpSync(templateRoot, root, { recursive: true });
      return spacePaths(root, 'personal');
    },
    close() {
      if (
        dirname(templateRoot) !== parent ||
        !basename(templateRoot).startsWith('melete-seeded-space-') ||
        lstatSync(templateRoot).isSymbolicLink() ||
        realpathSync(templateRoot) !== templateRoot
      )
        throw new Error('Unverified test template directory');
      rmSync(templateRoot, { recursive: true, force: true });
    },
  };
}

export const IDS = {
  bun: 'k_01J8ZP3QWABCDEFGHJKMNPQRST',
  flights: 'k_01J8ZP3QWABCDEFGHJKMNPQRSV',
  landlord: 'k_01J8ZP3QWABCDEFGHJKMNPQRSW',
  fresh: 'k_01J8ZP3QWABCDEFGHJKMNPQRSX',
  absent: 'k_01J8ZP3QWZZZZZZZZZZZZZZZZZ',
} as const;

export const aRecord = (over: Partial<KnowledgeFrontmatter> = {}): KnowledgeFrontmatter => ({
  id: IDS.bun,
  title: 'Prefers bun over npm for all package management',
  space: 'personal',
  audience: 'private',
  type: 'preference',
  status: 'active',
  confidence: 'high',
  asserted_by: 'user',
  source: {
    kind: 'statement',
    ref: 'session:2026-09-10T14:22:31Z',
    quote: 'always use bun instead of npm',
    sha256: null,
  },
  observed_at: '2026-09-10',
  valid_from: '2026-07-10',
  valid_until: null,
  supersedes: [],
  superseded_by: null,
  created: '2026-09-10',
  updated: '2026-09-10',
  tags: ['tooling'],
  links: [],
  schema_version: 1,
  ...over,
});

/** A clock that does not move, so commits and logs are the same on every run. */
export const fixedClock =
  (iso = '2026-09-11T09:00:00.000Z') =>
  (): Date =>
    new Date(iso);
