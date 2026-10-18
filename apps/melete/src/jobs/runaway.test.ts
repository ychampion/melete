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
  test('four copies of the letter are a loop, and the first copy is kept', () => {
    const text = looped(RUNAWAY_COPIES);
    const found = repeatedBlock(text, true);
    expect(found?.copies).toBe(RUNAWAY_COPIES);
    // The line introducing the second copy goes with it.
    expect(found?.kept).toBe(
      `Here's your cover letter:\n\n${LETTER}\n\nIt's 217 words, counted on my computer.`,
    );
    expect(found?.kept.split('Dear Hiring Manager').length).toBe(2);
  });

  test('three copies are not yet a loop', () => {
    expect(RUNAWAY_COPIES).toBe(4);
    expect(repeatedBlock(looped(RUNAWAY_COPIES - 1), true)).toBeNull();
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

  // The body is the same long run of paragraphs each time: only the greeting
  // differs. Three people asked for is three copies, and that is the request.
  const BODY = LETTER.split('\n\n').slice(1).join('\n\n');

  test('the same letter to three people, each greeted by name', () => {
    const text = ['Alice', 'Bob', 'Carol']
      .map((name) => `Letter for ${name}:\n\nDear ${name},\n\n${BODY}`)
      .join('\n\n');
    expect(repeatedBlock(text, true)).toBeNull();
  });

  test('three versions that differ only in how they open', () => {
    const openings = [
      'I am writing to apply for the Operations Coordinator role, which I saw on your careers page.',
      'A friend at Greenleaf told me about the Operations Coordinator opening, and I would love to be considered.',
      'Every grocery shelf is the end of a long chain of deliveries, and keeping that chain on time is what I do.',
    ];
    const text = openings
      .map((opening, n) => `Version ${n + 1}:\n\n${opening}\n\n${BODY}`)
      .join('\n\n');
    expect(repeatedBlock(text, true)).toBeNull();
  });
});

describe('copies that differ only in spacing, punctuation or case', () => {
  test('rewrapped lines, doubled spaces, curly quotes and dashes are still the same copy', () => {
    const drift = (n: number) =>
      n % 2
        ? LETTER.replace(/I'm/g, 'I’m')
            .replace(/, /g, ',  ')
            .replace('scheduling and', 'scheduling\nand')
            .replace(/a third\./, 'a third —')
        : LETTER.replace(/Grocery/g, 'GROCERY');
    const text = Array.from({ length: RUNAWAY_COPIES + 1 }, (_, n) => drift(n)).join('\n\n');
    const found = repeatedBlock(text, true);
    expect(found?.copies).toBe(RUNAWAY_COPIES + 1);
    expect(found?.kept).toBe(drift(0));
  });
});

describe('while the reply streams', () => {
  test('it fires once the last copy has ended, not before', () => {
    const text = looped(RUNAWAY_COPIES);
    const watch = runawayWatch();
    let firedAt = -1;
    // Small uneven pieces, as a stream sends them.
    for (let at = 0, n = 0; at < text.length; n++) {
      const size = 3 + (n % 17);
      const piece = text.slice(at, at + size);
      at += size;
      if (watch.see(piece) && firedAt < 0) firedAt = at;
    }
    // The last copy's last paragraph ends at its closing note.
    const lastStart = text.lastIndexOf('Dear Hiring Manager');
    expect(firedAt).toBeGreaterThan(lastStart + LETTER.length);
  });

  test('a reply still on its last copy, mid-paragraph, has not tripped it', () => {
    const text = looped(RUNAWAY_COPIES);
    const partial = text.slice(0, text.lastIndexOf('Sincerely,') + 5);
    expect(repeatedBlock(partial)).toBeNull();
    // A line that has ended is not yet a paragraph that has.
    expect(repeatedBlock(text.slice(0, text.lastIndexOf('Riya Sharma')))).toBeNull();
  });

  test('a long reply costs time in proportion to its length', () => {
    // Lines with no blank line between them, as code or a long list streams,
    // and plain paragraphs: each piece is read once, never the whole reply again.
    const line = (n: number) =>
      `- the river letter vendor road morning list table code plan ${n}\n`;
    const paragraph = (n: number) =>
      `Day ${n}: ${'the morning plan for the week, the vendor and the store. '.repeat(6)}\n\n`;
    const time = (unit: (n: number) => string, chars: number) => {
      let text = '';
      for (let n = 0; text.length < chars; n++) text += unit(n);
      const watch = runawayWatch();
      const started = performance.now();
      for (let at = 0; at < text.length; at += 7) watch.see(text.slice(at, at + 7));
      return performance.now() - started;
    };
    for (const unit of [line, paragraph]) {
      time(unit, 20_000);
      const small = time(unit, 50_000);
      const large = time(unit, 400_000);
      // Eight times the text: linear work is about eight times the time; the
      // whole-reply rescan this replaced took about sixty times as long.
      expect(large).toBeLessThan(Math.max(small, 5) * 24);
      expect(large).toBeLessThan(1_500);
    }
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
        for (let copy = 0; copy < RUNAWAY_COPIES; copy++) parts.push(...block);
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

  test('a long block said again and again side by side is always found', () => {
    const random = seeded(7);
    for (let round = 0; round < 200; round++) {
      const block = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        paragraph(random, 30 + Math.floor(random() * 40)),
      );
      if (block.join('').length < MIN_BLOCK_CHARS + 10) continue;
      const before = paragraph(random, 15);
      const copies = Array.from({ length: RUNAWAY_COPIES }, () => block).flat();
      const text = [before, ...copies].join('\n\n');
      const found = repeatedBlock(text, true);
      expect(found).not.toBeNull();
      expect(found?.kept).toBe([before, ...block].join('\n\n'));
    }
  });

  test('streamed in random pieces, it finds what reading the whole text finds', () => {
    const random = seeded(1018);
    let fired = 0;
    for (let round = 0; round < 300; round++) {
      // Single line breaks inside some paragraphs, and some list items, as replies have.
      const pool = Array.from({ length: 2 + Math.floor(random() * 4) }, () => {
        const part = paragraph(random, 40 + Math.floor(random() * 60));
        return random() < 0.2 ? part.replace(' ', '\n') : random() < 0.1 ? `- ${part}` : part;
      });
      const parts: string[] = [];
      for (let i = 0, length = 4 + Math.floor(random() * 16); i < length; i++)
        parts.push(pool[Math.floor(random() * pool.length)] as string);
      if (random() < 0.4) {
        const block = pool.slice(0, 1 + Math.floor(random() * pool.length));
        for (let copy = 0; copy < RUNAWAY_COPIES; copy++) parts.push(...block);
      }
      const text = parts.join('\n\n');
      const watch = runawayWatch();
      let firedAt = -1;
      let before = 0;
      let found: ReturnType<typeof repeatedBlock> = null;
      for (let at = 0; at < text.length; ) {
        const size = 1 + Math.floor(random() * 30);
        found = watch.see(text.slice(at, at + size));
        if (found && firedAt < 0) {
          before = at;
          firedAt = Math.min(at + size, text.length);
        }
        at += size;
      }
      if (firedAt < 0) {
        expect(repeatedBlock(text)).toBeNull();
        continue;
      }
      fired++;
      expect(found).toEqual(repeatedBlock(text.slice(0, firedAt)));
      // Not a piece earlier: the loop was not there yet.
      expect(repeatedBlock(text.slice(0, before))).toBeNull();
    }
    expect(fired).toBeGreaterThan(20);
  });
});
