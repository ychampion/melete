import { describe, expect, test } from 'bun:test';
import { MIN_BLOCK_CHARS, RUNAWAY_COPIES, repeatedBlock, runawayWatch } from './runaway.ts';

const LETTER = [
  'Dear Hiring Manager,',
  "I'm excited to apply for the Operations Coordinator position at Greenleaf Grocers. For the past three years, I've worked at a logistics startup, where I ran vendor scheduling and helped cut late deliveries by a third.",
  'In my role, I coordinated with vendors to keep deliveries on schedule, and I learned how much a store depends on the right products arriving in the right place at the right time.',
  'Grocery operations move quickly, and a small delay can ripple across a whole day. I enjoy that pace, and I am comfortable juggling many moving parts and spotting problems early.',
  'Thank you for your time and consideration. I would welcome the chance to discuss how my background in vendor scheduling can support your operations.',
  'Sincerely,\nRiya Sharma',
].join('\n\n');

/** The letter said `copies` times, each with a different line around it, as the loop wrote it. */
function looped(copies: number): string {
  const parts = [
    `Here's your cover letter:\n\n${LETTER}\n\nIt's 217 words, counted on my computer.`,
  ];
  for (let n = 2; n <= copies; n++)
    parts.push(
      `Here's the finished letter, take ${n}:\n\n${LETTER}\n\nI added no facts beyond yours.`,
    );
  return parts.join('\n\n');
}

describe('a reply that repeats one long block', () => {
  test('three copies of the letter are a loop, and the first copy is kept', () => {
    const text = looped(3);
    const found = repeatedBlock(text, true);
    expect(found?.copies).toBe(3);
    // The line introducing the second copy goes with it.
    expect(found?.kept).toBe(
      `Here's your cover letter:\n\n${LETTER}\n\nIt's 217 words, counted on my computer.`,
    );
    expect(found?.kept.split('Dear Hiring Manager').length).toBe(2);
  });

  test('two copies are not yet a loop', () => {
    expect(repeatedBlock(looped(2), true)).toBeNull();
  });

  test('many copies are counted, and the cut is still after the first', () => {
    const found = repeatedBlock(looped(28), true);
    expect(found?.copies).toBe(28);
    expect(found?.kept.split('Dear Hiring Manager').length).toBe(2);
  });

  test('copies run together with no line between them still count', () => {
    const text = [LETTER, LETTER, LETTER, LETTER].join('\n\n');
    const found = repeatedBlock(text, true);
    expect(found?.kept).toBe(LETTER);
  });
});

describe('repetition that belongs in a reply', () => {
  test('a chorus between different verses', () => {
    const chorus =
      'Oh the river runs so wide tonight, and the lights are burning low,\nwe will carry every song we know, wherever the long roads go.';
    const verse = (n: number) =>
      `Verse ${n}: the morning came on silver wings and found us by the shore, with stories ${n} times retold and wanting something more.`;
    const song = [1, 2, 3, 4].flatMap((n) => [verse(n), chorus]).join('\n\n');
    expect(repeatedBlock(song, true)).toBeNull();
  });

  test('the same code three times', () => {
    const code = [
      '```ts',
      'export function total(items: { price: number; quantity: number }[]): number {',
      '  let sum = 0;',
      '',
      '  for (const item of items) sum += item.price * item.quantity;',
      '  return Math.round(sum * 100) / 100;',
      '}',
      '```',
    ].join('\n');
    const prose =
      'This version keeps the rounding at the end, so every line item is added at full precision and only the total is rounded to cents for display.';
    const text = [1, 2, 3].map((n) => `Option ${n}:\n\n${code}\n\n${prose}`).join('\n\n');
    // The prose alone repeats three times, but it is shorter than a block.
    expect(prose.length).toBeLessThan(MIN_BLOCK_CHARS);
    expect(repeatedBlock(text, true)).toBeNull();
  });

  test('the same table three times', () => {
    const table = [
      '| Day | Breakfast | Lunch | Dinner |',
      '| --- | --- | --- | --- |',
      ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(
        (day) =>
          `| ${day} | Oats with berries and yoghurt | Lentil soup and bread | Grilled fish with greens |`,
      ),
    ].join('\n');
    expect(repeatedBlock([table, table, table, table].join('\n\n'), true)).toBeNull();
  });

  test('a list with the same long items again and again', () => {
    const item =
      '- Take the 8:15 train from the central station, change at the river stop, and walk the last ten minutes along the canal path to the office.';
    const list = [item, item, item, item].join('\n');
    expect(repeatedBlock([list, list, list].join('\n\n'), true)).toBeNull();
  });

  test('short lines said many times', () => {
    expect(repeatedBlock(Array(20).fill('Thank you!').join('\n\n'), true)).toBeNull();
  });
});

describe('while the reply streams', () => {
  test('it fires once the third copy has ended, not before', () => {
    const text = looped(3);
    const watch = runawayWatch();
    let firedAt = -1;
    // Small uneven pieces, as a stream sends them.
    for (let at = 0, n = 0; at < text.length; n++) {
      const size = 3 + (n % 17);
      const piece = text.slice(at, at + size);
      at += size;
      if (watch.see(piece) && firedAt < 0) firedAt = at;
    }
    // The third copy's last paragraph ends at its closing note.
    const thirdStart = text.lastIndexOf('Dear Hiring Manager');
    expect(firedAt).toBeGreaterThan(thirdStart + LETTER.length);
  });

  test('a reply still on its third copy, mid-paragraph, has not tripped it', () => {
    const text = looped(3);
    const partial = text.slice(0, text.lastIndexOf('Sincerely,') + 5);
    expect(repeatedBlock(partial)).toBeNull();
  });
});

/** A seeded generator, so a failure here can be replayed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('against a brute-force count', () => {
  const words =
    'the a river letter vendor road morning list table code plan week day light store'.split(' ');
  const paragraph = (random: () => number, length: number) =>
    Array.from({ length }, () => words[Math.floor(random() * words.length)]).join(' ');

  /** Every run of consecutive paragraphs of enough prose, counted wherever it recurs. */
  function brute(parts: string[]): boolean {
    for (let from = 0; from < parts.length; from++)
      for (let to = from + 1; to <= parts.length; to++) {
        const block = parts.slice(from, to);
        if (block.join('').length < MIN_BLOCK_CHARS) continue;
        // Copies that do not overlap, scanning left to right.
        let copies = 0;
        for (let at = 0; at + block.length <= parts.length; ) {
          if (block.every((part, offset) => parts[at + offset] === part)) {
            copies++;
            at += block.length;
          } else at++;
        }
        if (copies >= RUNAWAY_COPIES) return true;
      }
    return false;
  }

  test('random replies: it finds a loop exactly when one is there', () => {
    const random = seeded(20261018);
    let loops = 0;
    for (let round = 0; round < 400; round++) {
      // A small pool, so paragraphs repeat by chance as well as on purpose.
      const pool = Array.from({ length: 2 + Math.floor(random() * 6) }, () =>
        paragraph(random, 20 + Math.floor(random() * 40)),
      );
      const parts: string[] = [];
      const length = 3 + Math.floor(random() * 14);
      for (let i = 0; i < length; i++)
        parts.push(pool[Math.floor(random() * pool.length)] as string);
      if (random() < 0.3) {
        const block = pool.slice(0, 1 + Math.floor(random() * pool.length));
        for (let copy = 0; copy < 3; copy++) parts.push(...block);
      }
      const expected = brute(parts);
      const found = repeatedBlock(parts.join('\n\n'), true);
      if (expected) loops++;
      // Never a loop where there is none: every loop it finds is a real one.
      if (found) expect(expected).toBe(true);
      if (found) expect(found.kept.length).toBeLessThan(parts.join('\n\n').length);
    }
    expect(loops).toBeGreaterThan(50);
  });

  test('a long block said three times side by side is always found', () => {
    const random = seeded(7);
    for (let round = 0; round < 200; round++) {
      const block = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        paragraph(random, 30 + Math.floor(random() * 40)),
      );
      if (block.join('').length < MIN_BLOCK_CHARS + 10) continue;
      const before = paragraph(random, 15);
      const text = [before, ...block, ...block, ...block].join('\n\n');
      const found = repeatedBlock(text, true);
      expect(found).not.toBeNull();
      expect(found?.kept).toBe([before, ...block].join('\n\n'));
    }
  });
});
