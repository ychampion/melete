/**
 * Write mediation. The sandboxed agent has read access to the spaces in its
 * grant and write access to none of them. The only path from a model's output
 * into a person's memory runs through here: a proposal is staged in
 * `.proposed/`, checked, rendered as a diff, and applied as a git commit that
 * says who asked for it.
 *
 * Everything checked below is a way a write could quietly corrupt a space:
 * frontmatter that does not mean what it says, a space name that disagrees with
 * the directory, a path that climbs out of the root, a supersedes chain with a
 * hole in it, a record too large to have been written by a person, or a secret
 * that a model read somewhere and is about to write down forever.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type KnowledgeType,
  knowledgeFrontmatter,
  lintRecord,
  type ProposedWrite,
} from '@melete/contracts';
import { ulid } from 'ulid';
import { type Finding, finding, fromLint, hasErrors } from './findings.ts';
import { serializeRecord } from './frontmatter.ts';
import type { SpaceIndex } from './fts.ts';
import { resolveInSpace, type SpacePaths } from './layout.ts';
import { commitRecord, readWorkingTree, type SpaceCommit } from './space.ts';
import { type LoadedRecord, loadSpace, toIndexed } from './store.ts';

/**
 * What a space lets an agent do without asking. A personal space may let the
 * low-risk types through; a shared space asks every time; a read-only space is
 * searched and never written.
 */
export type SpacePolicy = {
  /** Types that apply without a person, or `false` for "always ask". */
  autoApply: readonly KnowledgeType[] | false;
  readOnly: boolean;
};

/** What a personal space starts with: the two types a correction can undo cheaply. */
export const DEFAULT_POLICY: SpacePolicy = {
  autoApply: ['preference', 'fact'],
  readOnly: false,
};

/** What a shared space starts with. Nothing lands without a person. */
export const SHARED_SPACE_POLICY: SpacePolicy = { autoApply: false, readOnly: false };

/** A record a person would actually write fits easily; anything larger is a paste. */
export const MAX_RECORD_BYTES = 32 * 1024;

/**
 * Secret shapes. This is a seatbelt, not a scanner: it catches the credential a
 * model copied out of a config file it was reading, which is the realistic way
 * one ends up in a person's memory forever.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'a PEM block', pattern: /-----BEGIN[A-Z ]*/ },
  { name: 'an sk- style API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a password field', pattern: /^[ \t]*password[ \t]*:[ \t]*\S/im },
  {
    name: 'a key or token assignment',
    pattern:
      /\b(api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)\b[ \t]*[:=][ \t]*\S{8,}/i,
  },
];

export type Proposal = {
  id: string;
  space: string;
  /** Where the record would land, relative to the space root. */
  path: string;
  rationale: string;
  /** The full file as it would be written. */
  content: string;
  /** The agent or person that asked for the write. */
  proposedBy: string;
  proposedAt: string;
  /** The record type, so the policy can be applied without re-parsing. */
  type: KnowledgeType;
};

export type ProposalRejected = { ok: false; findings: Finding[] };
export type ProposalAccepted = {
  ok: true;
  proposal: Proposal;
  diff: string;
  /** False when the space policy lets this type land without a person. */
  requiresApproval: boolean;
  findings: Finding[];
};
export type ProposalResult = ProposalAccepted | ProposalRejected;

export type MediationContext = {
  paths: SpacePaths;
  spacesRoot: string;
  /** Every record id that exists in this space, for resolving supersedes. */
  knownIds: ReadonlySet<string>;
  policy?: SpacePolicy;
  /** Injected so proposal timestamps are pinned in tests. */
  now?: () => Date;
};

const policyOf = (context: MediationContext): SpacePolicy => context.policy ?? DEFAULT_POLICY;

/** Does this write need a person, given the space's policy? */
export function requiresApproval(policy: SpacePolicy, type: KnowledgeType): boolean {
  if (policy.readOnly) return true;
  if (policy.autoApply === false) return true;
  return !policy.autoApply.includes(type);
}

/**
 * Everything that must be true before a proposal may become a diff. Returns a
 * list rather than throwing, because the agent that wrote the record deserves
 * to be told all of what is wrong with it at once.
 */
export function validateProposal(write: ProposedWrite, context: MediationContext): Finding[] {
  const findings: Finding[] = [];
  const policy = policyOf(context);

  if (policy.readOnly) {
    findings.push(
      finding('space-read-only', `the ${context.paths.space} space is read-only`, {
        path: write.path,
      }),
    );
  }

  if (write.space !== context.paths.space) {
    findings.push(
      finding(
        'space-matches-store',
        `proposal names space "${write.space}" but this store serves "${context.paths.space}"`,
        { field: 'space', path: write.path },
      ),
    );
  }

  const parsed = knowledgeFrontmatter.safeParse(write.frontmatter);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(
        finding('record-parses', `${issue.path.join('.') || '<root>'}: ${issue.message}`, {
          path: write.path,
        }),
      );
    }
    return findings;
  }

  const normalized = write.path.replace(/\\/g, '/');
  const target = resolveInSpace(context.paths, normalized);
  if (!target) {
    findings.push(
      finding('path-inside-space', `path "${write.path}" resolves outside the space root`, {
        field: 'path',
        path: write.path,
      }),
    );
  } else {
    if (!normalized.startsWith('knowledge/') || !normalized.endsWith('.md')) {
      findings.push(
        finding(
          'path-inside-knowledge',
          `records live in knowledge/ and end in .md; "${write.path}" does not`,
          { field: 'path', path: write.path },
        ),
      );
    }
    findings.push(
      ...lintRecord(parsed.data, {
        filePath: target,
        spacesRoot: context.spacesRoot,
        knownIds: context.knownIds,
      }).map((lint) => fromLint(lint, normalized)),
    );
  }

  const content = serializeRecord(parsed.data, write.body);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_RECORD_BYTES) {
    findings.push(
      finding(
        'size-cap',
        `the record is ${bytes} bytes; the cap is ${MAX_RECORD_BYTES}. Split it, or keep the source in raw/`,
        { path: write.path },
      ),
    );
  }

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(
        finding('no-secrets', `the record looks like it contains ${name}, so it was not staged`, {
          path: write.path,
        }),
      );
      break;
    }
  }

  return findings;
}

/**
 * A unified diff with no context lines elided: a knowledge record is small, and
 * a person approving a write should see the whole of it.
 */
export function renderUnifiedDiff(before: string, after: string, path: string): string {
  const beforeLines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const afterLines = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const lines: string[] = [
    `--- a/${before === '' ? 'dev/null' : path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
  ];
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

/** The diff a person is shown: this proposal against what is in the space now. */
export const renderDiff = (paths: SpacePaths, proposal: Proposal): string =>
  renderUnifiedDiff(readWorkingTree(paths, proposal.path), proposal.content, proposal.path);

const stagePath = (paths: SpacePaths, id: string): string => join(paths.proposed, `${id}.json`);

/**
 * Stage a write. Nothing reaches the space here: the proposal lands in
 * `.proposed/`, which is not committed, and the caller gets the diff.
 */
export function proposeWrite(context: MediationContext, write: ProposedWrite): ProposalResult {
  const findings = validateProposal(write, context);
  if (hasErrors(findings)) return { ok: false, findings };

  const now = context.now ?? (() => new Date());
  const frontmatter = knowledgeFrontmatter.parse(write.frontmatter);
  const proposal: Proposal = {
    id: `prop_${ulid(now().getTime())}`,
    space: write.space,
    path: write.path.replace(/\\/g, '/'),
    rationale: write.rationale,
    content: serializeRecord(frontmatter, write.body),
    proposedBy: frontmatter.asserted_by === 'user' ? 'user' : 'agent',
    proposedAt: now().toISOString(),
    type: frontmatter.type,
  };

  mkdirSync(context.paths.proposed, { recursive: true });
  writeFileSync(stagePath(context.paths, proposal.id), JSON.stringify(proposal, null, 2), 'utf8');

  return {
    ok: true,
    proposal,
    diff: renderDiff(context.paths, proposal),
    requiresApproval: requiresApproval(policyOf(context), proposal.type),
    findings,
  };
}

export function listProposals(paths: SpacePaths): Proposal[] {
  if (!existsSync(paths.proposed)) return [];
  return readdirSync(paths.proposed)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(paths.proposed, f), 'utf8')) as Proposal)
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id));
}

export function getProposal(paths: SpacePaths, id: string): Proposal | null {
  const file = stagePath(paths, id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Proposal;
}

export function discardProposal(paths: SpacePaths, id: string): boolean {
  const file = stagePath(paths, id);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export type ApplyOptions = {
  /** The person, or the policy, that let this write through. */
  approvedBy: string;
  /** Updated in place when given, so a running job sees the write at once. */
  index?: SpaceIndex;
  now?: () => Date;
};

export type ApplyRejected = { ok: false; findings: Finding[] };
export type ApplyAccepted = {
  ok: true;
  commit: SpaceCommit;
  path: string;
  /** The record as it now reads on disk. */
  record: LoadedRecord;
};
export type ApplyResult = ApplyAccepted | ApplyRejected;

/**
 * Apply a staged proposal: commit it, update the catalog, and put it in the
 * index. The commit carries who proposed it and who approved it, which is the
 * audit record; reverting that commit is the undo.
 *
 * The proposal is checked again here. Between staging and approval the space
 * can have moved, and an approval must never be spent on a record that no
 * longer makes sense.
 */
export async function applyProposal(
  context: MediationContext,
  proposalOrId: Proposal | string,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const proposal =
    typeof proposalOrId === 'string' ? getProposal(context.paths, proposalOrId) : proposalOrId;
  if (!proposal) {
    return {
      ok: false,
      findings: [finding('proposal-missing', `no staged proposal ${String(proposalOrId)}`)],
    };
  }
  if (policyOf(context).readOnly) {
    return {
      ok: false,
      findings: [
        finding('space-read-only', `the ${context.paths.space} space is read-only`, {
          path: proposal.path,
        }),
      ],
    };
  }

  const commit = await commitRecord(context.paths, proposal.path, proposal.content, {
    proposedBy: proposal.proposedBy,
    approvedBy: options.approvedBy,
    subject: proposal.rationale,
    ...(options.now ? { now: options.now } : {}),
  });

  discardProposal(context.paths, proposal.id);

  const record = loadSpace(context.paths).records.find((r) => r.path === proposal.path);
  if (!record) {
    return {
      ok: false,
      findings: [
        finding('record-parses', `${proposal.path} was committed but does not parse back`, {
          path: proposal.path,
        }),
      ],
    };
  }
  options.index?.upsert(toIndexed(record));

  return { ok: true, commit, path: proposal.path, record };
}
