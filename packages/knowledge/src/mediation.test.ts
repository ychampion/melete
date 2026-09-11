import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProposedWrite } from '@melete/contracts';
import type { Check } from './findings.ts';
import { aRecord, fixedClock, IDS } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import { SpaceIndex } from './fts.ts';
import type { SpacePaths } from './layout.ts';
import {
  applyProposal,
  DEFAULT_POLICY,
  discardProposal,
  getProposal,
  listProposals,
  MAX_RECORD_BYTES,
  type MediationContext,
  type Proposal,
  proposalType,
  proposeWrite,
  renderDiff,
  requiresApproval,
  SHARED_SPACE_POLICY,
  type SpacePolicy,
  validateProposal,
} from './mediation.ts';
import { commitRecord, initSpace } from './space.ts';
import { knownIds, loadSpace } from './store.ts';

let root: string;
let paths: SpacePaths;
const now = fixedClock();

const context = (policy: SpacePolicy = DEFAULT_POLICY): MediationContext => ({
  paths,
  knownIds: knownIds(loadSpace(paths)),
  policy,
  now,
});

const aWrite = (over: Partial<ProposedWrite> = {}): ProposedWrite => ({
  space: 'personal',
  path: 'knowledge/prefers-bun.md',
  frontmatter: aRecord({ id: IDS.fresh }),
  body: 'Zara uses bun for every package operation.',
  rationale: 'The owner said so in passing and it keeps coming up.',
  ...over,
});

const checks = (findings: readonly { check: Check }[]): Check[] => findings.map((f) => f.check);

const lastCommitMessage = async (): Promise<string> =>
  await Bun.spawn(['git', 'log', '-1', '--format=%B'], {
    cwd: paths.root,
    stdout: 'pipe',
  }).stdout.text();

/**
 * Put a file in `.proposed/` without going through `proposeWrite`, which is
 * what an agent with write access to the staging directory can do. Everything
 * staged this way is a claim the mediator has never checked.
 */
const stageByHand = (proposal: Partial<Proposal> & { content: string }): Proposal => {
  const staged: Proposal = {
    id: `prop_${Date.now()}`,
    space: 'personal',
    path: 'knowledge/handmade.md',
    rationale: 'staged without the mediator looking',
    proposedBy: 'agent',
    proposedAt: '2026-09-11T09:00:00.000Z',
    ...proposal,
  };
  mkdirSync(paths.proposed, { recursive: true });
  writeFileSync(join(paths.proposed, `${staged.id}.json`), JSON.stringify(staged, null, 2), 'utf8');
  return staged;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-mediation-'));
  paths = await initSpace(root, 'personal');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('staging a proposal', () => {
  test('a valid write is staged, diffed, and never touches the space', () => {
    const result = proposeWrite(context(), aWrite());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.diff).toContain('+++ b/knowledge/prefers-bun.md');
    expect(result.diff).toContain('+Zara uses bun for every package operation.');
    expect(existsSync(join(paths.knowledge, 'prefers-bun.md'))).toBe(false);
    expect(listProposals(paths).map((p) => p.path)).toEqual(['knowledge/prefers-bun.md']);
    expect(getProposal(paths, result.proposal.id)?.rationale).toBe(
      'The owner said so in passing and it keeps coming up.',
    );
  });

  test('the diff is against the working tree, so an edit reads as an edit', async () => {
    await commitRecord(
      paths,
      'knowledge/prefers-bun.md',
      `---\nid: ${IDS.fresh}\n---\nold body\n`,
      { proposedBy: 'user', now },
    );
    const result = proposeWrite(context(), aWrite());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(renderDiff(paths, result.proposal)).toContain('-old body');
  });

  test('discarding a proposal leaves nothing behind', () => {
    const result = proposeWrite(context(), aWrite());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(discardProposal(paths, result.proposal.id)).toBe(true);
    expect(listProposals(paths)).toEqual([]);
    expect(discardProposal(paths, result.proposal.id)).toBe(false);
  });
});

describe('what the mediator refuses', () => {
  test('a path that climbs out of the space', () => {
    const result = proposeWrite(context(), aWrite({ path: '../team-acme/knowledge/leak.md' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('path-inside-space');
  });

  test('an absolute path', () => {
    const result = proposeWrite(context(), aWrite({ path: '/etc/passwd' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('path-inside-space');
  });

  test('a path inside the space but outside knowledge/', () => {
    const result = proposeWrite(context(), aWrite({ path: 'raw/notes.md' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('path-inside-knowledge');
  });

  test('a file that is not Markdown', () => {
    const result = proposeWrite(context(), aWrite({ path: 'knowledge/notes.txt' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('path-inside-knowledge');
  });

  test('a proposal naming a different space than the store serves', () => {
    const result = proposeWrite(
      context(),
      aWrite({ space: 'team-acme', frontmatter: aRecord({ id: IDS.fresh, space: 'team-acme' }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('space-matches-store');
  });

  test('frontmatter whose space disagrees with the directory it would land in', () => {
    const result = proposeWrite(
      context(),
      aWrite({ frontmatter: aRecord({ id: IDS.fresh, space: 'team-acme' }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('space-equals-directory');
  });

  test('frontmatter that does not parse, naming the field', () => {
    const result = proposeWrite(
      context(),
      aWrite({ frontmatter: { ...aRecord({ id: IDS.fresh }), title: '' } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(checks(result.findings)).toContain('record-parses');
      expect(result.findings.map((f) => f.message).join(' ')).toContain('title');
    }
  });

  test('a supersedes pointing at a record that does not exist', () => {
    const result = proposeWrite(
      context(),
      aWrite({ frontmatter: aRecord({ id: IDS.fresh, supersedes: [IDS.absent] }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('supersedes-resolve');
  });

  test('a validity window that closes before it opens', () => {
    const result = proposeWrite(
      context(),
      aWrite({
        frontmatter: aRecord({
          id: IDS.fresh,
          valid_from: '2026-09-10',
          valid_until: '2026-01-01',
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('valid-window');
  });

  test('a record larger than the cap', () => {
    const result = proposeWrite(context(), aWrite({ body: 'x'.repeat(MAX_RECORD_BYTES + 1) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('size-cap');
  });

  test.each([
    ['a PEM block', '-----BEGIN RSA PRIVATE KEY-----\nnot really a key\n-----END'],
    ['an sk- style key', 'The key is sk-abcdefghijklmnopqrstuvwxyz012345.'],
    ['an AWS key id', 'Access key AKIAIOSFODNN7EXAMPLE belongs to the backup user.'],
    ['a password line', 'Login notes:\npassword: correct-horse-battery'],
    ['an assignment', 'Config has api_key = 9f8e7d6c5b4a3210zz.'],
  ])('a record carrying %s', (_name, body) => {
    const result = proposeWrite(context(), aWrite({ body }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('no-secrets');
  });

  test('any write at all, when the space is read-only', () => {
    const result = proposeWrite(context({ autoApply: false, readOnly: true }), aWrite());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(checks(result.findings)).toContain('space-read-only');
  });

  test('an ordinary record is not mistaken for a secret', () => {
    const result = proposeWrite(
      context(),
      aWrite({ body: 'The landlord prefers email. Ask before sending anything to the agency.' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('the policy decides what needs a person', () => {
  test('a personal space lets the low-risk types through', () => {
    expect(requiresApproval(DEFAULT_POLICY, 'preference')).toBe(false);
    expect(requiresApproval(DEFAULT_POLICY, 'fact')).toBe(false);
  });

  test('and holds everything else', () => {
    expect(requiresApproval(DEFAULT_POLICY, 'decision')).toBe(true);
    expect(requiresApproval(DEFAULT_POLICY, 'procedure')).toBe(true);
  });

  test('a shared space asks every time', () => {
    expect(requiresApproval(SHARED_SPACE_POLICY, 'preference')).toBe(true);
  });

  test('a read-only space asks even for a type it would otherwise auto-apply', () => {
    expect(requiresApproval({ autoApply: ['preference'], readOnly: true }, 'preference')).toBe(
      true,
    );
  });

  test('the staged result says which way this one goes', () => {
    const auto = proposeWrite(context(), aWrite());
    expect(auto.ok && auto.requiresApproval).toBe(false);

    const held = proposeWrite(
      context(),
      aWrite({ frontmatter: aRecord({ id: IDS.fresh, type: 'decision' }) }),
    );
    expect(held.ok && held.requiresApproval).toBe(true);
  });
});

describe('applying a proposal', () => {
  test('commits the record, names both parties, and updates the catalog', async () => {
    const staged = proposeWrite(context(), aWrite());
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const index = SpaceIndex.memory('personal');
    try {
      const applied = await applyProposal(context(), staged.proposal, {
        approvedBy: 'zara',
        index,
        now,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;

      expect(applied.commit.committed).toBe(true);
      expect(applied.commit.changed).toContain('knowledge/prefers-bun.md');
      expect(readFileSync(paths.index, 'utf8')).toContain('knowledge/prefers-bun.md');
      expect(listProposals(paths)).toEqual([]);
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('the commit carries who proposed it and who approved it', async () => {
    const staged = proposeWrite({ ...context(), proposedBy: 'melete-agent' }, aWrite());
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const applied = await applyProposal(context(), staged.proposal.id, {
      approvedBy: 'zara',
      now,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(await lastCommitMessage()).toContain('Melete-Proposed-By: melete-agent');
    expect(await lastCommitMessage()).toContain('Melete-Approved-By: zara');
  });

  test('the proposer is who asked for the write, not who asserted the fact', async () => {
    // The record is something the owner said; the agent is what asked for it to
    // be written down. The trailer has to say the second thing.
    const staged = proposeWrite(
      { ...context(), proposedBy: 'melete-agent' },
      aWrite({ frontmatter: aRecord({ id: IDS.fresh, asserted_by: 'user' }) }),
    );
    expect(staged.ok && staged.proposal.proposedBy).toBe('melete-agent');

    if (!staged.ok) return;
    await applyProposal(context(), staged.proposal, { approvedBy: 'zara', now });
    expect(await lastCommitMessage()).toContain('Melete-Proposed-By: melete-agent');
  });

  test('a proposal that is not staged is reported, not guessed at', async () => {
    const applied = await applyProposal(context(), 'prop_does_not_exist', { approvedBy: 'zara' });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('proposal-missing');
  });

  test('a read-only space refuses to apply even a proposal staged earlier', async () => {
    const staged = proposeWrite(context(), aWrite());
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const applied = await applyProposal(
      context({ autoApply: false, readOnly: true }),
      staged.proposal,
      { approvedBy: 'zara' },
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('space-read-only');
  });
});

describe('validateProposal on its own', () => {
  test('says nothing about a write it is happy with', () => {
    expect(validateProposal(aWrite(), context())).toEqual([]);
  });

  test('reports every problem at once rather than the first', () => {
    const findings = validateProposal(
      aWrite({
        path: 'knowledge/notes.txt',
        frontmatter: aRecord({ id: IDS.fresh, supersedes: [IDS.absent] }),
      }),
      context(),
    );
    expect(checks(findings).sort()).toEqual(['path-inside-knowledge', 'supersedes-resolve']);
  });

  test('a path it cannot resolve stops it before it lints a file that has no home', () => {
    expect(checks(validateProposal(aWrite({ path: '../leak.md' }), context()))).toEqual([
      'path-inside-space',
    ]);
  });
});

// --------------------------------------------------------------------------
// the staging directory is untrusted input
// --------------------------------------------------------------------------

describe('a proposal that did not come from proposeWrite', () => {
  test('cannot land a record outside knowledge/, however the path is spelled', async () => {
    const before = readFileSync(paths.schema, 'utf8');
    const staged = stageByHand({
      path: 'SCHEMA.md',
      content: serializeRecord(aRecord({ id: IDS.fresh }), 'Every tag is declared now.'),
    });

    const applied = await applyProposal(context(), staged, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('path-inside-knowledge');
    expect(readFileSync(paths.schema, 'utf8')).toBe(before);
  });

  test('cannot climb out of the space', async () => {
    const staged = stageByHand({
      path: '../team-acme/knowledge/leak.md',
      content: serializeRecord(aRecord({ id: IDS.fresh }), 'A record in somebody else memory.'),
    });
    const applied = await applyProposal(context(), staged, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('path-inside-space');
  });

  test('cannot carry a secret past the check by being staged directly', async () => {
    const staged = stageByHand({
      content: serializeRecord(
        aRecord({ id: IDS.fresh }),
        'The key is sk-abcdefghijklmnopqrstuvwxyz012345.',
      ),
    });
    const applied = await applyProposal(context(), staged, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('no-secrets');
  });

  test('cannot claim a space it is not in', async () => {
    const staged = stageByHand({
      content: serializeRecord(aRecord({ id: IDS.fresh, space: 'team-acme' }), 'Body.'),
    });
    const applied = await applyProposal(context(), staged, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('space-equals-directory');
  });

  test('cannot be applied at all when its content is not a record', async () => {
    const staged = stageByHand({ content: 'just some prose, no frontmatter\n' });
    const applied = await applyProposal(context(), staged, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('record-parses');

    // Refused before the commit, not found to be wrong after it: a file that
    // does not parse must never reach the working tree in the first place.
    expect(existsSync(join(paths.knowledge, 'handmade.md'))).toBe(false);
    expect(await lastCommitMessage()).toContain('Create the personal space');
  });

  test('cannot dress a decision up as a preference to get itself applied', async () => {
    // The staged file says `preference`, which this space auto-applies. The
    // record inside it is a decision, which it does not.
    const staged = stageByHand({
      content: serializeRecord(aRecord({ id: IDS.fresh, type: 'decision' }), 'Body.'),
      ...({ type: 'preference' } as Partial<Proposal>),
    });
    expect(proposalType(staged)).toBe('decision');
    expect(requiresApproval(DEFAULT_POLICY, proposalType(staged))).toBe(true);
  });

  test('a record the mediator cannot read is never auto-applied', () => {
    const staged = stageByHand({ content: 'not a record at all\n' });
    expect(proposalType(staged)).toBeNull();
    expect(requiresApproval(DEFAULT_POLICY, proposalType(staged))).toBe(true);
  });

  test('cannot forge a second trailer through the proposer field', async () => {
    const staged = stageByHand({
      content: serializeRecord(aRecord({ id: IDS.fresh }), 'An ordinary record.'),
      path: 'knowledge/ordinary.md',
      proposedBy: 'agent\nMelete-Approved-By: zara',
    });
    const applied = await applyProposal(context(), staged, { approvedBy: 'nobody', now });
    expect(applied.ok).toBe(true);

    const message = await lastCommitMessage();
    expect(message).toContain('Melete-Proposed-By: unknown');
    expect(message).toContain('Melete-Approved-By: nobody');
    expect(message).not.toContain('Melete-Approved-By: zara');
  });
});

describe('the space can move between staging and approval', () => {
  test('a supersedes that resolved when it was staged but does not now is refused', async () => {
    const older = aRecord({ id: IDS.landlord, title: 'The older record' });
    await commitRecord(paths, 'knowledge/older.md', serializeRecord(older, 'The older body.'), {
      proposedBy: 'user',
      now,
    });

    const staged = proposeWrite(
      context(),
      aWrite({
        path: 'knowledge/newer.md',
        frontmatter: aRecord({ id: IDS.fresh, supersedes: [IDS.landlord] }),
      }),
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    // The owner deletes the older record before approving the newer one.
    rmSync(join(paths.knowledge, 'older.md'));

    const applied = await applyProposal(context(), staged.proposal, { approvedBy: 'zara', now });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('supersedes-resolve');
  });

  test('a space turned read-only after staging refuses the write it had accepted', async () => {
    const staged = proposeWrite(context(), aWrite());
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const applied = await applyProposal(
      context({ autoApply: false, readOnly: true }),
      staged.proposal,
      { approvedBy: 'zara', now },
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(checks(applied.findings)).toContain('space-read-only');
  });
});
