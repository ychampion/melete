import { expect, test } from 'bun:test';
import { clashSkeleton, nameSkeleton, sameName } from './name-skeleton.ts';

test('names that read alike are one name', () => {
  // Cyrillic А, Greek Α, fullwidth Ａ, Lisu ꓮ, Cherokee Ꭺ: each reads as a Latin A.
  for (const a of ['А', 'Α', 'Ａ', 'ꓮ', 'Ꭺ'])
    expect([a, sameName(`${a}lice`, 'Alice')]).toEqual([a, true]);
  expect(sameName('Alıce', 'Alice')).toBe(true);
  expect(sameName('Расо', 'Paco')).toBe(true);
  // Cherokee in its lower case form reads the same as in upper case.
  expect(sameName('Ꭺlice'.toLowerCase(), 'alice')).toBe(true);
  // Case, invisible characters and extra space change nothing.
  expect(sameName('  ALI‍CE ', 'alice')).toBe(true);
  for (const invisible of ['͏', '️', 'ㅤ', 'ᅟ', 'ᅠ', 'ﾠ'])
    expect([invisible, sameName(`Alice${invisible}`, 'Alice')]).toEqual([invisible, true]);
  expect(sameName('Ana  María', 'ana maría')).toBe(true);
  expect(nameSkeleton('Sam Okafor')).toBe('sam okafor');
});

test('names that differ in a letter or a mark stay different to the service', () => {
  expect(sameName('Alice.', 'Alice')).toBe(false);
  expect(sameName('Alice (design)', 'Alice')).toBe(false);
  expect(sameName('Alicé', 'Alice')).toBe(false);
  expect(sameName('Bob', 'Rob')).toBe(false);
  // These only clash on screen: the service keeps ordinary names like Eli and Ell apart.
  expect(sameName('AIice', 'Alice')).toBe(false);
  expect(sameName('Eli', 'Ell')).toBe(false);
  expect(sameName('Arnie', 'Amie')).toBe(false);
});

test('on screen, I, l, 1 and | read as one letter, and rn as m', () => {
  for (const name of ['AIice', 'A1ice', 'A|ice', 'ALICE', 'Аlice͏'])
    expect([name, clashSkeleton(name)]).toEqual([name, clashSkeleton('Alice')]);
  expect(clashSkeleton('Eli')).toBe(clashSkeleton('Ell'));
  expect(clashSkeleton('Arnie')).toBe(clashSkeleton('Amie'));
  expect(clashSkeleton('Bob')).not.toBe(clashSkeleton('Rob'));
});
