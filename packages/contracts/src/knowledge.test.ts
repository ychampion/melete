import { describe, expect, test } from 'bun:test';
import {
  hasLintErrors,
  isRetrievable,
  type KnowledgeFrontmatter,
  knowledgeFrontmatter,
  lintRecord,
  lintSpaceMatchesDirectory,
  lintStatusTransition,
  lintSupersededNeedsPointer,
  lintSupersedesResolve,
  lintValidWindow,
} from './knowledge.ts';

const ID_A = 'k_01J8ZP3QWABCDEFGHJKMNPQRST';
const ID_B = 'k_01J8ZP3QWABCDEFGHJKMNPQRSV';

const base: KnowledgeFrontmatter = {
  id: ID_A,
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
};

describe('frontmatter schema', () => {
  test('accepts a complete record', () => {
    expect(knowledgeFrontmatter.safeParse(base).success).toBe(true);
  });

  test('fills the optional fields with their defaults', () => {
    const minimal = {
      ...base,
      supersedes: undefined,
      superseded_by: undefined,
      valid_until: undefined,
      tags: undefined,
      links: undefined,
    };
    const parsed = knowledgeFrontmatter.parse(minimal);
    expect(parsed.supersedes).toEqual([]);
    expect(parsed.superseded_by).toBeNull();
    expect(parsed.valid_until).toBeNull();
  });

  test('refuses a record with no observed_at, because provenance is the point', () => {
    const { observed_at: _dropped, ...withoutObservedAt } = base;
    expect(knowledgeFrontmatter.safeParse(withoutObservedAt).success).toBe(false);
  });

  test('refuses an id that is not a prefixed ULID', () => {
    expect(knowledgeFrontmatter.safeParse({ ...base, id: 'k_1' }).success).toBe(false);
  });

  test('refuses a schema_version it does not know how to read', () => {
    expect(knowledgeFrontmatter.safeParse({ ...base, schema_version: 2 }).success).toBe(false);
  });
});

describe('space-equals-directory', () => {
  const root = '/data/spaces';

  test('passes when the frontmatter matches the directory', () => {
    const findings = lintSpaceMatchesDirectory(base, `${root}/personal/knowledge/bun.md`, root);
    expect(findings).toEqual([]);
  });

  test('catches a record written into the wrong space', () => {
    const findings = lintSpaceMatchesDirectory(base, `${root}/team-acme/knowledge/bun.md`, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('space-equals-directory');
    expect(findings[0]?.severity).toBe('error');
  });

  test('catches a record outside the spaces root altogether', () => {
    const findings = lintSpaceMatchesDirectory(base, '/etc/passwd.md', root);
    expect(hasLintErrors(findings)).toBe(true);
  });

  test('treats Windows separators the same as POSIX ones', () => {
    const findings = lintSpaceMatchesDirectory(
      base,
      'C:\\data\\spaces\\personal\\knowledge\\bun.md',
      'C:\\data\\spaces',
    );
    expect(findings).toEqual([]);
  });
});

describe('supersedes-resolve', () => {
  test('passes when every referenced id exists', () => {
    const fm = { ...base, supersedes: [ID_B], superseded_by: null, links: [ID_B] };
    expect(lintSupersedesResolve(fm, new Set([ID_A, ID_B]))).toEqual([]);
  });

  test('catches a dangling supersedes', () => {
    const fm = { ...base, supersedes: [ID_B] };
    const findings = lintSupersedesResolve(fm, new Set([ID_A]));
    expect(hasLintErrors(findings)).toBe(true);
    expect(findings[0]?.field).toBe('supersedes');
  });

  test('catches a record that supersedes itself', () => {
    const fm = { ...base, supersedes: [ID_A] };
    expect(hasLintErrors(lintSupersedesResolve(fm, new Set([ID_A])))).toBe(true);
  });

  test('a dangling link is a warning, not an error', () => {
    const fm = { ...base, links: [ID_B] };
    const findings = lintSupersedesResolve(fm, new Set([ID_A]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(hasLintErrors(findings)).toBe(false);
  });
});

describe('status transitions', () => {
  test('allows the corrections that leave a trail', () => {
    expect(lintStatusTransition('active', 'superseded')).toEqual([]);
    expect(lintStatusTransition('active', 'retracted')).toEqual([]);
    expect(lintStatusTransition('active', 'disputed')).toEqual([]);
    expect(lintStatusTransition('disputed', 'active')).toEqual([]);
    expect(lintStatusTransition('superseded', 'retracted')).toEqual([]);
  });

  test('a retracted record never comes back', () => {
    expect(hasLintErrors(lintStatusTransition('retracted', 'active'))).toBe(true);
    expect(hasLintErrors(lintStatusTransition('retracted', 'disputed'))).toBe(true);
  });

  test('a superseded record cannot quietly become active again', () => {
    expect(hasLintErrors(lintStatusTransition('superseded', 'active'))).toBe(true);
  });

  test('staying put is always fine', () => {
    expect(lintStatusTransition('active', 'active')).toEqual([]);
    expect(lintStatusTransition('retracted', 'retracted')).toEqual([]);
  });
});

describe('the remaining rules', () => {
  test('a superseded record must name its replacement', () => {
    expect(
      hasLintErrors(lintSupersededNeedsPointer({ status: 'superseded', superseded_by: null })),
    ).toBe(true);
    expect(lintSupersededNeedsPointer({ status: 'superseded', superseded_by: ID_B })).toEqual([]);
  });

  test('a validity window cannot run backwards', () => {
    expect(
      hasLintErrors(lintValidWindow({ valid_from: '2026-07-10', valid_until: '2026-01-01' })),
    ).toBe(true);
    expect(lintValidWindow({ valid_from: '2026-07-10', valid_until: null })).toEqual([]);
  });
});

describe('lintRecord runs every rule at once', () => {
  test('a clean record produces nothing', () => {
    const findings = lintRecord(base, {
      filePath: '/data/spaces/personal/knowledge/bun.md',
      spacesRoot: '/data/spaces',
      knownIds: new Set([ID_A]),
      previousStatus: 'active',
    });
    expect(findings).toEqual([]);
  });

  test('a record that breaks three rules reports three findings', () => {
    const broken: KnowledgeFrontmatter = {
      ...base,
      status: 'superseded',
      superseded_by: null,
      supersedes: [ID_B],
      valid_until: '2020-01-01',
    };
    const findings = lintRecord(broken, {
      filePath: '/data/spaces/personal/knowledge/bun.md',
      spacesRoot: '/data/spaces',
      knownIds: new Set([ID_A]),
      previousStatus: 'active',
    });
    const rules = findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['superseded-needs-pointer', 'supersedes-resolve', 'valid-window']);
  });
});

describe('retrieval', () => {
  test('never returns a retracted or superseded record', () => {
    expect(isRetrievable('active')).toBe(true);
    expect(isRetrievable('disputed')).toBe(true);
    expect(isRetrievable('superseded')).toBe(false);
    expect(isRetrievable('retracted')).toBe(false);
  });
});
