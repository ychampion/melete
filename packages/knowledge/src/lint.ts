/**
 * The whole-space lint. The contract owns the checks that need one record; this
 * owns the ones that need all of them at once, and the ones that keep the
 * generated files honest.
 *
 * The list is adapted from the checks a maintained LLM wiki needs: unique ids,
 * a space that matches its directory, supersedes pointers that agree in both
 * directions, legal status moves, tags that were declared before they were
 * used, a catalog in step with the files, pages short enough to read, and no
 * links to things that are not there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { lintRecord, lintStatusTransition } from '@melete/contracts';
import { declaredTags, type IndexEntry, renderIndex } from './catalog.ts';
import { type Finding, finding, fromLint, hasErrors } from './findings.ts';
import { parseRecord } from './frontmatter.ts';
import type { SpacePaths } from './layout.ts';
import { readAtHead } from './space.ts';
import { type LoadedRecord, loadSpace } from './store.ts';

/** A page longer than this has stopped being one idea. */
export const MAX_PAGE_LINES = 200;

export type LintReport = {
  space: string;
  records: number;
  findings: Finding[];
  ok: boolean;
};

export type LintSpaceOptions = {
  spacesRoot?: string;
  /**
   * Compare each record against the version in the last commit, so an illegal
   * status move is caught. Off for a space with no git repository.
   */
  useGit?: boolean;
};

const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Links out to the web, to mail, or within a page are not this check's business. */
const isLocalLink = (target: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#') && !target.startsWith('//');

function checkIdsUnique(records: readonly LoadedRecord[]): Finding[] {
  const seen = new Map<string, string>();
  const findings: Finding[] = [];
  for (const record of records) {
    const first = seen.get(record.frontmatter.id);
    if (first) {
      findings.push(
        finding('ids-unique', `id ${record.frontmatter.id} is already used by ${first}`, {
          path: record.path,
          field: 'id',
        }),
      );
      continue;
    }
    seen.set(record.frontmatter.id, record.path);
  }
  return findings;
}

/**
 * A supersedes chain has to agree with itself from both ends, or the trail that
 * explains why Melete changed its mind only reads in one direction.
 */
function checkSupersedeSymmetry(records: readonly LoadedRecord[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(records.map((r) => [r.frontmatter.id, r]));

  for (const record of records) {
    for (const olderId of record.frontmatter.supersedes) {
      const older = byId.get(olderId);
      if (!older) continue; // the contract lint already reports a dangling id
      if (older.frontmatter.superseded_by !== record.frontmatter.id) {
        findings.push(
          finding(
            'supersede-symmetry',
            `${record.frontmatter.id} supersedes ${olderId}, but ${olderId} does not point back`,
            { path: older.path, field: 'superseded_by' },
          ),
        );
      }
      if (older.frontmatter.status === 'active') {
        findings.push(
          finding(
            'supersede-symmetry',
            `${olderId} was superseded by ${record.frontmatter.id} but is still active`,
            { path: older.path, field: 'status' },
          ),
        );
      }
    }

    const newerId = record.frontmatter.superseded_by;
    if (!newerId) continue;
    const newer = byId.get(newerId);
    if (newer && !newer.frontmatter.supersedes.includes(record.frontmatter.id)) {
      findings.push(
        finding(
          'supersede-symmetry',
          `${record.frontmatter.id} says ${newerId} replaced it, but ${newerId} does not say so`,
          { path: newer.path, field: 'supersedes' },
        ),
      );
    }
  }
  return findings;
}

function checkTags(paths: SpacePaths, records: readonly LoadedRecord[]): Finding[] {
  if (!existsSync(paths.schema)) {
    return [
      finding('tags-declared', `${paths.space} has no SCHEMA.md, so no tag is declared`, {
        path: 'SCHEMA.md',
      }),
    ];
  }
  const declared = declaredTags(readFileSync(paths.schema, 'utf8'));
  const findings: Finding[] = [];
  for (const record of records) {
    for (const tag of record.frontmatter.tags) {
      if (declared.has(tag)) continue;
      findings.push(
        finding(
          'tags-declared',
          `tag "${tag}" is not declared in SCHEMA.md; add the line there first`,
          { path: record.path, field: 'tags' },
        ),
      );
    }
  }
  return findings;
}

function checkIndex(paths: SpacePaths, records: readonly LoadedRecord[]): Finding[] {
  const entries: IndexEntry[] = records.map((record) => ({
    id: record.frontmatter.id,
    path: record.path,
    title: record.frontmatter.title,
    type: record.frontmatter.type,
    status: record.frontmatter.status,
    tags: record.frontmatter.tags,
  }));
  const expected = renderIndex(entries);
  const actual = existsSync(paths.index) ? readFileSync(paths.index, 'utf8') : '';
  if (actual === expected) return [];
  return [
    finding('index-in-sync', 'index.md is not what the records say it should be; regenerate it', {
      path: 'index.md',
    }),
  ];
}

function checkPageAndLinks(paths: SpacePaths, records: readonly LoadedRecord[]): Finding[] {
  const findings: Finding[] = [];
  for (const record of records) {
    const text = readFileSync(record.absolutePath, 'utf8');
    const lines = text.replace(/\n$/, '').split('\n').length;
    if (lines > MAX_PAGE_LINES) {
      findings.push(
        finding(
          'page-length',
          `the page is ${lines} lines; the cap is ${MAX_PAGE_LINES}. Split it into two records`,
          { path: record.path },
        ),
      );
    }

    const from = posix.dirname(record.path);
    for (const match of record.body.matchAll(linkPattern)) {
      const target = match[1];
      if (!target || !isLocalLink(target)) continue;
      const withoutAnchor = target.split('#')[0];
      if (!withoutAnchor) continue;
      const resolved = posix.normalize(posix.join(from, decodeURIComponent(withoutAnchor)));
      if (resolved.startsWith('..')) {
        findings.push(
          finding('orphan-links', `link to "${target}" points outside the space`, {
            path: record.path,
          }),
        );
        continue;
      }
      if (!existsSync(join(paths.root, resolved))) {
        findings.push(
          finding('orphan-links', `link to "${target}" points at nothing`, { path: record.path }),
        );
      }
    }
  }
  return findings;
}

async function checkStatusMoves(
  paths: SpacePaths,
  records: readonly LoadedRecord[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const record of records) {
    const previousText = await readAtHead(paths, record.path);
    if (previousText === null) continue;
    const previous = parseRecord(previousText);
    if (!previous.ok) continue;
    findings.push(
      ...lintStatusTransition(previous.record.frontmatter.status, record.frontmatter.status).map(
        (lint) => fromLint(lint, record.path),
      ),
    );
  }
  return findings;
}

/**
 * Run every check over one space. Errors mean the space is not in a state the
 * mediator should write to; warnings are worth a person's attention and do not
 * block anything.
 */
export async function lintSpace(
  paths: SpacePaths,
  options: LintSpaceOptions = {},
): Promise<LintReport> {
  const spacesRoot = options.spacesRoot ?? dirname(paths.root);
  const contents = loadSpace(paths);
  const findings: Finding[] = [];

  for (const failure of contents.failures) {
    for (const issue of failure.issues) {
      findings.push(finding('record-parses', issue, { path: failure.path }));
    }
  }

  const knownIds = new Set(contents.records.map((r) => r.frontmatter.id));
  for (const record of contents.records) {
    findings.push(
      ...lintRecord(record.frontmatter, {
        filePath: record.absolutePath,
        spacesRoot,
        knownIds,
      }).map((lint) => fromLint(lint, record.path)),
    );
  }

  findings.push(...checkIdsUnique(contents.records));
  findings.push(...checkSupersedeSymmetry(contents.records));
  findings.push(...checkTags(paths, contents.records));
  findings.push(...checkIndex(paths, contents.records));
  findings.push(...checkPageAndLinks(paths, contents.records));
  if (options.useGit !== false) {
    findings.push(...(await checkStatusMoves(paths, contents.records)));
  }

  return {
    space: paths.space,
    records: contents.records.length,
    findings,
    ok: !hasErrors(findings),
  };
}
