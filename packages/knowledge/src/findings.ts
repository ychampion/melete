/**
 * What a check found. The contract owns the five rules that decide whether one
 * record is coherent; this adds the checks that only make sense with a whole
 * space in front of you, or with a proposal that has not landed yet.
 *
 * Both kinds travel in one list, because the person reading the output does not
 * care which layer noticed.
 */
import type { LintFinding, LintRule, LintSeverity } from '@melete/contracts';

/** Checks the mediator runs before a proposal is allowed to become a diff. */
export const MEDIATION_CHECKS = [
  'space-matches-store',
  'path-inside-space',
  'path-inside-knowledge',
  'size-cap',
  'no-secrets',
  'space-read-only',
  'proposal-missing',
] as const;

/** Checks that need every record in the space at once. */
export const SPACE_CHECKS = [
  'ids-unique',
  'supersede-symmetry',
  'tags-declared',
  'index-in-sync',
  'page-length',
  'orphan-links',
  'record-parses',
] as const;

export type Check = LintRule | (typeof MEDIATION_CHECKS)[number] | (typeof SPACE_CHECKS)[number];

export type Finding = {
  check: Check;
  severity: LintSeverity;
  message: string;
  /** Relative to the space root, when the finding is about one file. */
  path?: string;
  field?: string;
};

export const finding = (
  check: Check,
  message: string,
  extra: { severity?: LintSeverity; path?: string; field?: string } = {},
): Finding => ({
  check,
  severity: extra.severity ?? 'error',
  message,
  ...(extra.path ? { path: extra.path } : {}),
  ...(extra.field ? { field: extra.field } : {}),
});

/** Carry a contract lint finding into the same list as everything else. */
export const fromLint = (lint: LintFinding, path?: string): Finding => ({
  check: lint.rule,
  severity: lint.severity,
  message: lint.message,
  ...(path ? { path } : {}),
  ...(lint.field ? { field: lint.field } : {}),
});

export const hasErrors = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === 'error');

/** One line per finding, in the shape the lint command prints. */
export const formatFinding = (f: Finding): string =>
  `${f.severity === 'error' ? 'error' : 'warning'}  ${f.path ?? '-'}  ${f.check}: ${f.message}`;
