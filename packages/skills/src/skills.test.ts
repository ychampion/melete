import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_SKILLS } from '@melete/contracts';
import {
  chooseSkills,
  loadBuiltInSkills,
  loadIdentity,
  loadSkills,
  loadSpaceSkills,
  parseSkill,
  renderSkills,
} from './loader.ts';
import { estimateTokens, IDENTITY_MAX_TOKENS } from './tokens.ts';

const built = loadBuiltInSkills();
const names = (matches: ReturnType<typeof chooseSkills>) =>
  matches.map((m) => m.skill.frontmatter.name);

describe('the skills that ship with the release', () => {
  test('all six load, and nothing fails to parse', () => {
    expect(built.failures).toEqual([]);
    expect(built.skills.map((s) => s.frontmatter.name)).toEqual([...BUILT_IN_SKILLS]);
  });

  test('every one of them is inside its own token budget', () => {
    for (const skill of built.skills) {
      expect(skill.tokens).toBeLessThanOrEqual(skill.frontmatter.max_tokens);
      expect(skill.frontmatter.max_tokens).toBeLessThanOrEqual(400);
    }
  });

  test('every one of them declares triggers and a description a person can read', () => {
    for (const skill of built.skills) {
      expect(skill.frontmatter.triggers.length).toBeGreaterThan(0);
      expect(skill.frontmatter.description.length).toBeGreaterThan(20);
      expect(skill.body.length).toBeGreaterThan(100);
    }
  });

  test('three of them fit in a thousand tokens, which is what one attempt loads', () => {
    const worst = [...built.skills].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    expect(worst.reduce((sum, s) => sum + s.tokens, 0)).toBeLessThanOrEqual(1000);
  });

  test('the identity file loads and is inside its cap', () => {
    const identity = loadIdentity();
    expect(estimateTokens(identity)).toBeLessThanOrEqual(IDENTITY_MAX_TOKENS);
    expect(identity).toContain('receipt');
  });
});

describe('choosing a skill for an objective', () => {
  test.each([
    ['Follow up with the landlord about the lease', 'draft-follow-up'],
    ['Remind me on Friday to check in with the accountant', 'schedule-a-check-in'],
    ['Research the options for a standing desk', 'research-with-sources'],
    ['File these invoices somewhere sensible', 'organize-documents'],
    ['Remember that I use bun for everything', 'remember-this'],
    ['Plan the move out of the flat', 'plan-a-responsibility'],
  ])('%s picks %s', (objective, expected) => {
    expect(names(chooseSkills(objective, '', built.skills))[0]).toBe(expected);
  });

  test('nothing matches an objective none of them cover', () => {
    expect(chooseSkills('book a flight to Lisbon', 'thanks', built.skills)).toEqual([]);
  });

  test('at most three load, however many match', () => {
    const picked = chooseSkills(
      'plan this, research it, follow up, remind me, file these, remember it',
      '',
      built.skills,
    );
    expect(picked).toHaveLength(3);
  });

  test('the same inputs always give the same bundle', () => {
    const once = names(chooseSkills('follow up and research this', '', built.skills));
    const twice = names(chooseSkills('follow up and research this', '', built.skills));
    expect(once).toEqual(twice);
  });

  test('the latest message outweighs the objective', () => {
    const picked = chooseSkills(
      'research the market for standing desks',
      'actually just follow up with the supplier',
      built.skills,
    );
    expect(names(picked)[0]).toBe('draft-follow-up');
  });

  test('a bundle says which triggers fired, so it can be explained', () => {
    const picked = chooseSkills('follow up and chase the invoice', '', built.skills);
    expect(picked[0]?.matched.sort()).toEqual(['chase', 'follow up']);
  });

  test('rendering a bundle puts each skill under its own heading', () => {
    const rendered = renderSkills(chooseSkills('follow up with the landlord', '', built.skills));
    expect(rendered).toContain('## draft-follow-up');
    expect(rendered).toContain('Read the thread before writing.');
  });
});

describe('skills a person adds to a space', () => {
  let root: string;
  let skillsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'melete-skills-'));
    skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const put = (name: string, text: string) => writeFileSync(join(skillsDir, name), text, 'utf8');

  const aSkill = (name: string, trigger: string, body = 'Do the thing.') =>
    `---\nname: ${name}\ndescription: A skill this person added for themselves.\ntriggers:\n  - ${trigger}\ntools: []\nmax_tokens: 400\n---\n\n${body}\n`;

  test('load alongside the built-ins', () => {
    put('book-a-flight.md', aSkill('book-a-flight', 'book a flight'));
    const loaded = loadSkills({ spaceSkillsDirectory: skillsDir });
    expect(loaded.failures).toEqual([]);
    expect(loaded.skills).toHaveLength(BUILT_IN_SKILLS.length + 1);
    expect(names(chooseSkills('book a flight to Lisbon', '', loaded.skills))).toEqual([
      'book-a-flight',
    ]);
  });

  test('one with a built-in name replaces the built-in, keeping its place', () => {
    put('remember-this.md', aSkill('remember-this', 'remember', 'Write it in the notebook.'));
    const loaded = loadSkills({ spaceSkillsDirectory: skillsDir });
    expect(loaded.skills).toHaveLength(BUILT_IN_SKILLS.length);
    const chosen = chooseSkills('remember that I use bun', '', loaded.skills)[0];
    expect(chosen?.skill.source).toBe('space');
    expect(chosen?.skill.body).toBe('Write it in the notebook.');
  });

  test('a directory with a SKILL.md in it is loaded too', () => {
    mkdirSync(join(skillsDir, 'book-a-flight'));
    writeFileSync(
      join(skillsDir, 'book-a-flight', 'SKILL.md'),
      aSkill('book-a-flight', 'book a flight'),
      'utf8',
    );
    expect(loadSpaceSkills(skillsDir).skills).toHaveLength(1);
  });

  test('a broken one is reported and the rest still load', () => {
    put('broken.md', 'no frontmatter here\n');
    put('fine.md', aSkill('fine', 'fine'));
    const loaded = loadSpaceSkills(skillsDir);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.failures).toHaveLength(1);
    expect(loaded.failures[0]?.issues[0]).toContain('frontmatter');
  });

  test('a space with no skills directory is not an error', () => {
    expect(loadSpaceSkills(join(root, 'nothing-here')).skills).toEqual([]);
  });
});

describe('parsing one skill file', () => {
  test('refuses a skill with no triggers, which could never be selected', () => {
    const parsed = parseSkill(
      '---\nname: orphan\ndescription: never loads\ntriggers: []\n---\nx\n',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('triggers');
  });

  test('refuses a name that is not kebab-case', () => {
    const parsed = parseSkill(
      '---\nname: Not Kebab\ndescription: x\ntriggers:\n  - x\n---\nbody\n',
    );
    expect(parsed.ok).toBe(false);
  });

  test('refuses a skill longer than its own cap, and says by how much', () => {
    const long = `---\nname: too-long\ndescription: x\ntriggers:\n  - x\nmax_tokens: 50\n---\n\n${'word '.repeat(200)}\n`;
    const parsed = parseSkill(long);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain('its own cap is 50');
  });
});

describe('the hosts a skill says it reads', () => {
  const withDomains = (domains: string) =>
    `---\nname: read-a-page\ndescription: A skill this person added for themselves.\ntriggers:\n  - read a page\ndomains:\n${domains}\nmax_tokens: 400\n---\n\nDo the thing.\n`;

  test('are parsed from the file, as host names', () => {
    const parsed = parseSkill(withDomains('  - ombudsman.example\n  - support.acme.test'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.frontmatter.domains).toEqual(['ombudsman.example', 'support.acme.test']);
  });

  test('are absent when the skill reads nothing of its own', () => {
    const parsed = parseSkill(
      '---\nname: quiet\ndescription: A skill this person added for themselves.\ntriggers:\n  - quiet\n---\n\nDo the thing.\n',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter.domains ?? []).toEqual([]);
  });

  test('refuse anything that is not a plain host name', () => {
    for (const bad of [
      '*.evil.test',
      'https://evil.test',
      'evil.test:8443',
      '10.0.0.1',
      'localhost',
    ])
      expect(parseSkill(withDomains(`  - ${bad}`)).ok).toBe(false);
  });
});
