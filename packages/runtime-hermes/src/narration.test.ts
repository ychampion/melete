import { expect, test } from 'bun:test';
import { onlyNarration, withoutNarration } from './narration.ts';

test('an opening line about the next step goes, the answer stays', () => {
  expect(withoutNarration('Let me check the forecast… It will rain after 4 PM.')).toBe(
    'It will rain after 4 PM.',
  );
  expect(withoutNarration("I'll look that up.\n\nThe library opens at 9 AM.")).toBe(
    'The library opens at 9 AM.',
  );
  expect(withoutNarration('Let me check: it is 18°C and clear.')).toBe('It is 18°C and clear.');
});

test('lines about skills go wherever they are', () => {
  expect(
    withoutNarration('Saved: you prefer aisle seats. I used the remember-this skill to keep it.'),
  ).toBe('Saved: you prefer aisle seats.');
});

test('promises, plans in the answer and ordinary words are kept', () => {
  const kept = [
    "I'll check the price again tomorrow at 9. For now it is $40.",
    'Let me know if you want the longer list.',
    'The forecast says rain. Let me check the radar later tonight if you want.',
    'I found three flights under $300.',
    '> Let me check the forecast…\nThat is what they wrote.',
  ];
  for (const text of kept) expect(withoutNarration(text)).toBe(text);
});

test('a reply that is only narration is kept whole, and said to be', () => {
  const text = "I'll read the remember-this skill…";
  expect(withoutNarration(text)).toBe(text);
  expect(onlyNarration(text)).toBe(true);
  expect(onlyNarration('Let me check the forecast.')).toBe(true);
  expect(onlyNarration('It will rain after 4 PM.')).toBe(false);
  expect(onlyNarration("I'll check again tomorrow at 9.")).toBe(false);
  expect(onlyNarration('')).toBe(false);
});
