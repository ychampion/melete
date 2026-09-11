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
  type KnowledgeFrontmatter,
  type KnowledgeType,
  knowledgeFrontmatter,
  lintRecord,
  type ProposedWrite,
} from '@melete/contracts';
import { ulid } from 'ulid';
import { type Finding, finding, fromLint, hasErrors } from './findings.ts';
import { parseRecord, serializeRecord } from './frontmatter.ts';
import type { SpaceIndex } from './fts.ts';
import { resolveInSpace, type SpacePaths } from './layout.ts';
import { commitRecord, readWorkingTree, type SpaceCommit } from './space.ts';
import { type LoadedRecord, loadSpace, markIndexFresh, toIndexed } from './store.ts';

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

/**
 * A staged write, as it sits in `.proposed/`.
 *
 * Everything in here is a claim. The staging directory is the one place an
 * agent can write, which is the whole point of it, and that makes every file in
 * it untrusted input on the way back out. Nothing downstream may believe a
 * field here without checking it against `content`, and the record's type is
 * deliberately absent: a second copy of a fact is a second thing to disagree
 * with, and it was the copy the policy would have read.
 */
export type Proposal = {
  id: string;
  space: string;
  /** Where the record would land, relative to the space root. */
  path: string;
  rationale: string;
  /** The full file as it would be written. */
  content: string;
  /** Who the staged file says asked for the write. A claim, not a finding. */
  proposedBy: string;
  proposedAt: string;
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
  /** Every record id that exists in this space, for resolving supersedes. */
  knownIds: ReadonlySet<string>;
  policy?: SpacePolicy;
  /**
   * Who is asking for the write: an agent's name, or `user` when a person
   * typed it. It comes from the caller, never from the record: who asserted a
   * fact and who asked for it to be written down are different questions, and
   * only the second one belongs in the audit trail.
   */
  proposedBy?: string;
  /** Injected so proposal timestamps are pinned in tests. */
  now?: () => Date;
};

const policyOf = (context: MediationContext): SpacePolicy => context.policy ?? DEFAULT_POLICY;

/**
 * Does this write need a person, given the space's policy? A type of null means
 * the mediator could not read the record well enough to say what it is, and
 * something it cannot read is something it must not apply on its own.
 */
export function requiresApproval(policy: SpacePolicy, type: KnowledgeType | null): boolean {
  if (policy.readOnly) return true;
  if (type === null) return true;
  if (policy.autoApply === false) return true;
  return !policy.autoApply.includes(type);
}

/** A proposer's name as it will appear in a commit trailer, or a refusal to guess. */
const safeProposer = (claimed: string): string =>
  /^[A-Za-z0-9 ._:@-]{1,64}$/.test(claimed) ? claimed : 'unknown';

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
        spacesRoot: context.paths.spacesRoot,
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
    proposedBy: safeProposer(context.proposedBy ?? 'agent'),
    proposedAt: now().toISOString(),
  };

  mkdirSync(context.paths.proposed, { recursive: true });
  writeFileSync(stagePath(context.paths, proposal.id), JSON.stringify(proposal, null, 2), 'utf8');

  return {
    ok: true,
    proposal,
    diff: renderDiff(context.paths, proposal),
    requiresApproval: requiresApproval(policyOf(context), frontmatter.type),
    findings,
  };
}

/**
 * What kind of record a staged proposal actually holds, read from the record
 * itself. Null when the content does not parse, which the policy treats as
 * needing a person.
 */
export function proposalType(proposal: Proposal): KnowledgeType | null {
  const parsed = parseRecord(proposal.content);
  return parsed.ok ? parsed.record.frontmatter.type : null;
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

export type VerifiedProposal = {
  path: string;
  frontmatter: KnowledgeFrontmatter;
  body: string;
  /** Serialized again from what was checked, so only checked bytes are committed. */
  content: string;
  type: KnowledgeType;
};

export type VerifyResult =
  | { ok: true; verified: VerifiedProposal }
  | { ok: false; findings: Finding[] };

/**
 * Read a staged proposal back as something that can be trusted, or say why it
 * cannot be.
 *
 * This is the trust boundary. A proposal is a file in the directory the agent
 * is allowed to write to, so between staging and applying it may have been
 * written by something other than `proposeWrite`: the path could name
 * `SCHEMA.md` rather than a record, the content could carry a secret or fail to
 * parse, and the metadata beside it could describe a record it does not hold.
 * Everything is therefore derived from `content` and checked again from
 * scratch, against the space as it is now rather than as it was when the
 * proposal was staged.
 */
export function verifyProposal(context: MediationContext, proposal: Proposal): VerifyResult {
  const parsed = parseRecord(proposal.content);
  if (!parsed.ok) {
    return {
      ok: false,
      findings: parsed.issues.map((issue) =>
        finding('record-parses', issue, { path: proposal.path }),
      ),
    };
  }

  const path = proposal.path.replace(/\\/g, '/');
  const write: ProposedWrite = {
    space: proposal.space,
    path,
    frontmatter: parsed.record.frontmatter,
    body: parsed.record.body,
    rationale: proposal.rationale,
  };

  const findings = validateProposal(write, context);
  if (hasErrors(findings)) return { ok: false, findings };

  return {
    ok: true,
    verified: {
      path,
      frontmatter: parsed.record.frontmatter,
      body: parsed.record.body,
      content: serializeRecord(parsed.record.frontmatter, parsed.record.body),
      type: parsed.record.frontmatter.type,
    },
  };
}

/**
 * Apply a staged proposal: commit it, update the catalog, and put it in the
 * index. The commit carries who proposed it and who approved it, which is the
 * audit record; reverting that commit is the undo.
 *
 * The proposal is checked again here, by `verifyProposal`. Between staging and
 * approval the space can have moved and the staged file can have changed, and
 * an approval must never be spent on a record that no longer makes sense or on
 * one that was never checked.
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

  const checked = verifyProposal(context, proposal);
  if (!checked.ok) return { ok: false, findings: checked.findings };

  const commit = await commitRecord(
    context.paths,
    checked.verified.path,
    checked.verified.content,
    {
      proposedBy: safeProposer(proposal.proposedBy),
      approvedBy: options.approvedBy,
      subject: proposal.rationale,
      ...(options.now ? { now: options.now } : {}),
    },
  );

  discardProposal(context.paths, proposal.id);

  const record = loadSpace(context.paths).records.find((r) => r.path === checked.verified.path);
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
  if (options.index) {
    options.index.upsert(toIndexed(record));
    markIndexFresh(context.paths, options.index);
  }

  return { ok: true, commit, path: checked.verified.path, record };
}
