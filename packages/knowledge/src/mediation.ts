/**
 * Write mediation. The sandboxed agent has read access to the spaces in its
 * grant and write access to none of them: the only path is a proposal in
 * `.proposed/`, which a person sees as a diff before anything reaches the space.
 *
 * v0.1 status: proposing, listing, diffing, and discarding are implemented here.
 * Applying is a git commit carrying a `Melete-Proposed-By:` trailer, and lands
 * with the git store.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasLintErrors, type LintFinding, lintRecord, type ProposedWrite } from '@melete/contracts';
import { serializeRecord } from './frontmatter.ts';
import { resolveInSpace, type SpacePaths } from './layout.ts';

export type Proposal = {
  id: string;
  space: string;
  /** Where the record would land, relative to the space root. */
  path: string;
  rationale: string;
  /** The full file as it would be written. */
  content: string;
  proposedAt: string;
};

export type ProposalRejected = {
  ok: false;
  findings: LintFinding[];
};

export type ProposalAccepted = {
  ok: true;
  proposal: Proposal;
  diff: string;
};

export type ProposalResult = ProposalAccepted | ProposalRejected;

const finding = (message: string, field?: string): LintFinding => ({
  rule: 'space-equals-directory',
  severity: 'error',
  message,
  ...(field ? { field } : {}),
});

/**
 * A minimal unified diff. Enough for a person to see what changes; the git
 * store renders the real one once a proposal is applied.
 */
export function renderDiff(before: string, after: string, path: string): string {
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      if (b !== undefined) lines.push(` ${b}`);
      continue;
    }
    if (b !== undefined) lines.push(`-${b}`);
    if (a !== undefined) lines.push(`+${a}`);
  }
  return `${lines.join('\n')}\n`;
}

export type MediatorOptions = {
  paths: SpacePaths;
  spacesRoot: string;
  knownIds: ReadonlySet<string>;
  /** Injected so proposal ids are deterministic in tests. */
  now?: () => Date;
};

/**
 * Validates a proposed write and stages it. Everything it checks is a reason a
 * write could quietly corrupt a space: bad frontmatter, a space that does not
 * match the directory, a dangling supersedes, a path that escapes the root.
 */
export class ProposalStore {
  private readonly now: () => Date;

  constructor(private readonly options: MediatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  propose(write: ProposedWrite): ProposalResult {
    const findings: LintFinding[] = [];

    if (write.space !== this.options.paths.space) {
      findings.push(
        finding(
          `proposal names space "${write.space}" but this store serves "${this.options.paths.space}"`,
          'space',
        ),
      );
    }

    const target = resolveInSpace(this.options.paths, write.path);
    if (!target) {
      findings.push(finding(`path "${write.path}" resolves outside the space root`, 'path'));
    }

    if (target) {
      findings.push(
        ...lintRecord(write.frontmatter, {
          filePath: target,
          spacesRoot: this.options.spacesRoot,
          knownIds: this.options.knownIds,
        }),
      );
    }

    if (hasLintErrors(findings)) return { ok: false, findings };

    const content = serializeRecord(write.frontmatter, write.body);
    const proposal: Proposal = {
      id: `${write.frontmatter.id}-${this.now().getTime()}`,
      space: write.space,
      path: write.path,
      rationale: write.rationale,
      content,
      proposedAt: this.now().toISOString(),
    };

    mkdirSync(this.options.paths.proposed, { recursive: true });
    writeFileSync(this.stagePath(proposal.id), JSON.stringify(proposal, null, 2), 'utf8');

    const before = target && existsSync(target) ? readFileSync(target, 'utf8') : '';
    return { ok: true, proposal, diff: renderDiff(before, content, write.path) };
  }

  list(): Proposal[] {
    if (!existsSync(this.options.paths.proposed)) return [];
    return readdirSync(this.options.paths.proposed)
      .filter((f) => f.endsWith('.json'))
      .map(
        (f) => JSON.parse(readFileSync(join(this.options.paths.proposed, f), 'utf8')) as Proposal,
      )
      .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
  }

  get(id: string): Proposal | null {
    const path = this.stagePath(id);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as Proposal;
  }

  discard(id: string): boolean {
    const path = this.stagePath(id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /**
   * Applying is a git apply plus a commit, which is the audit record and the
   * undo. The git store is not implemented yet; until then this refuses
   * loudly rather than half-writing a space.
   */
  apply(_id: string): never {
    throw new Error(
      'applying a proposal requires the git store, which arrives with the git store',
    );
  }

  private stagePath(id: string): string {
    return join(this.options.paths.proposed, `${id}.json`);
  }
}
