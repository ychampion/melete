import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProposedWrite } from '@melete/contracts';
import type { Check } from './findings.ts';
import { aRecord, fixedClock, IDS } from './fixtures.ts';
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
  spacesRoot: root,
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
    const staged = proposeWrite(
      context(),
      aWrite({ frontmatter: aRecord({ id: IDS.fresh, asserted_by: 'agent' }) }),
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const applied = await applyProposal(context(), staged.proposal.id, {
      approvedBy: 'zara',
      now,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const message = await Bun.spawn(['git', 'log', '-1', '--format=%B'], {
      cwd: paths.root,
      stdout: 'pipe',
    }).stdout.text();
    expect(message).toContain('Melete-Proposed-By: agent');
    expect(message).toContain('Melete-Approved-By: zara');
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
