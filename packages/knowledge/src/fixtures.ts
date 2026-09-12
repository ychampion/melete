/**
 * Test support: one well-formed record to vary, and the ids the suites share.
 * Not exported from the package barrel, because nothing outside the tests
 * should be building records from a template.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { type SpacePaths, spacePaths } from './layout.ts';
import { initSpace } from './space.ts';

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

/**
 * Seed real committed files once, then copy them into an independent directory
 * for every test. No Git process or index handle remains open in the template.
 * The space initialization suite still exercises initSpace directly.
 */
export async function createSpaceTemplate(
  prefix: string,
  seed?: (paths: SpacePaths) => Promise<void>,
) {
  const template = mkdtempSync(join(tmpdir(), `${prefix}template-`));
  try {
    const paths = await initSpace(template, 'personal');
    await seed?.(paths);
  } catch (error) {
    rmSync(template, { recursive: true, force: true });
    throw error;
  }
  return {
    copy() {
      const root = mkdtempSync(join(tmpdir(), prefix));
      cpSync(template, root, { recursive: true });
      return { root, paths: spacePaths(root, 'personal') };
    },
    close() {
      rmSync(template, { recursive: true, force: true });
    },
  };
}
