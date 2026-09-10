import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_SKILLS,
  normalizeForMatch,
  type SkillCandidate,
  selectSkills,
  skillFrontmatter,
} from './skills.ts';

const make = (name: string, triggers: string[]): SkillCandidate => ({
  frontmatter: {
    name,
    description: `${name} skill`,
    triggers,
    tools: [],
    max_tokens: 400,
  },
});

const skills: SkillCandidate[] = [
  make('draft-follow-up', ['follow up', 'chase', 'reply to']),
  make('research-with-sources', ['research', 'find out', 'look up']),
  make('schedule-a-check-in', ['check in', 'remind me', 'schedule']),
  make('organize-documents', ['organize', 'file these', 'sort']),
  make('remember-this', ['remember', 'note that']),
];

const names = (matches: ReturnType<typeof selectSkills>) =>
  matches.map((m) => m.skill.frontmatter.name);

describe('selectSkills', () => {
  test('matches a trigger in the objective', () => {
    const picked = selectSkills('Follow up with the landlord about the lease', '', skills);
    expect(names(picked)).toEqual(['draft-follow-up']);
  });

  test('matches a trigger in the latest message', () => {
    const picked = selectSkills('Deal with the inbox', 'can you remind me on Friday', skills);
    expect(names(picked)).toEqual(['schedule-a-check-in']);
  });

  test('the latest message outweighs the objective', () => {
    const picked = selectSkills(
      'research the market for standing desks',
      'actually just follow up with the supplier',
      skills,
    );
    expect(names(picked)[0]).toBe('draft-follow-up');
  });

  test('loads at most three skills, however many match', () => {
    const picked = selectSkills(
      'follow up, research, check in, organize, remember',
      'follow up research check in organize remember',
      skills,
    );
    expect(picked).toHaveLength(3);
  });

  test('respects a lower maximum', () => {
    const picked = selectSkills('follow up and research this', '', skills, 1);
    expect(picked).toHaveLength(1);
  });

  test('returns nothing when nothing matches', () => {
    expect(selectSkills('book a flight to Lisbon', 'thanks', skills)).toEqual([]);
  });

  test('matching ignores case and punctuation', () => {
    const picked = selectSkills('FOLLOW UP -- with the landlord!', '', skills);
    expect(names(picked)).toEqual(['draft-follow-up']);
  });

  test('reports which triggers matched, so a bundle can be explained', () => {
    const picked = selectSkills('follow up and chase the invoice', '', skills);
    expect(picked[0]?.matched.sort()).toEqual(['chase', 'follow up']);
    expect(picked[0]?.score).toBe(2);
  });

  test('is deterministic: ties break on the order the skills were supplied', () => {
    const tied = [make('alpha', ['ping']), make('beta', ['ping'])];
    expect(names(selectSkills('ping', '', tied, 2))).toEqual(['alpha', 'beta']);
    expect(names(selectSkills('ping', '', [...tied].reverse(), 2))).toEqual(['beta', 'alpha']);
  });

  test('a maximum of zero selects nothing rather than throwing', () => {
    expect(selectSkills('follow up', '', skills, 0)).toEqual([]);
  });
});

describe('normalizeForMatch', () => {
  test('collapses whitespace and strips punctuation', () => {
    expect(normalizeForMatch('  Follow   up, please!  ')).toBe('follow up please');
  });
});

describe('skill frontmatter', () => {
  test('accepts a built-in shape', () => {
    const parsed = skillFrontmatter.safeParse({
      name: 'draft-follow-up',
      description: 'Draft a short follow-up email from selected messages and knowledge.',
      triggers: ['follow up', 'chase', 'reply to'],
      tools: ['email.search', 'email.read', 'email.draft', 'knowledge.search'],
      max_tokens: 400,
    });
    expect(parsed.success).toBe(true);
  });

  test('refuses a skill with no triggers, which could never be selected', () => {
    const parsed = skillFrontmatter.safeParse({
      name: 'orphan',
      description: 'never loads',
      triggers: [],
    });
    expect(parsed.success).toBe(false);
  });

  test('refuses a skill that is longer than the contract allows', () => {
    const parsed = skillFrontmatter.safeParse({
      name: 'too-long',
      description: 'x',
      triggers: ['x'],
      max_tokens: 4000,
    });
    expect(parsed.success).toBe(false);
  });

  test('every built-in name is valid frontmatter', () => {
    for (const name of BUILT_IN_SKILLS) {
      const parsed = skillFrontmatter.safeParse({
        name,
        description: name,
        triggers: [name],
      });
      expect(parsed.success).toBe(true);
    }
  });
});
