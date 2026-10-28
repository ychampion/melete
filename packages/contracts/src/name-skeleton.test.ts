import { expect, test } from 'bun:test';
import { nameSkeleton, sameName } from './name-skeleton.ts';

test('names that read alike are one name', () => {
  // Cyrillic А, Greek Α, fullwidth Ａ: each reads as a Latin A.
  expect(sameName('Аlice', 'Alice')).toBe(true);
  expect(sameName('Αlice', 'Alice')).toBe(true);
  expect(sameName('Ａlice', 'Alice')).toBe(true);
  expect(sameName('Alıce', 'Alice')).toBe(true);
  expect(sameName('Расо', 'Paco')).toBe(true);
  // Case, a zero-width joiner and extra space change nothing.
  expect(sameName('  ALI‍CE ', 'alice')).toBe(true);
  expect(sameName('Ana  María', 'ana maría')).toBe(true);
  expect(nameSkeleton('Sam Okafor')).toBe('sam okafor');
});

test('names that differ in a letter or a mark stay different', () => {
  expect(sameName('Alice.', 'Alice')).toBe(false);
  expect(sameName('Alice (design)', 'Alice')).toBe(false);
  expect(sameName('Alicé', 'Alice')).toBe(false);
  expect(sameName('Bob', 'Rob')).toBe(false);
});
