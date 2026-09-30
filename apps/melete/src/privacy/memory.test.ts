import { expect, test } from 'bun:test';
import { PRIVACY_CATEGORIES } from '@melete/contracts';
import { reanchorSpans } from './memory.ts';
import { Redactor } from './redact.ts';
import { Rehydrator } from './stream.ts';
import { Vault } from './vault.ts';

test('memory extraction spans survive redaction: offsets move to the real quotes', () => {
  const segmentStart = 100;
  const text =
    'Reach me at sam.rivera@example.org or (415) 555-0132. I prefer tea to coffee. My nickname is Ann "Nan" O\'Neil.';
  const vault = new Vault();
  const redactor = new Redactor(vault, {
    enabled: new Set(PRIVACY_CATEGORIES),
    known: [{ id: 'k', label: 'Nickname', category: 'name', value: 'Ann "Nan" O\'Neil' }],
  });
  // The request memory sends is JSON text; the model sees its redacted form.
  const request = JSON.stringify({ evidence: { start: segmentStart, text } });
  const sent = redactor.body(
    { messages: [{ role: 'user', content: request }] },
    'chat/completions',
  ) as {
    messages: { content: string }[];
  };
  const seen = JSON.parse(sent.messages[0]?.content ?? '{}').evidence.text as string;
  expect(seen).toBe(
    'Reach me at ⟦EMAIL_1⟧ or ⟦PHONE_1⟧. I prefer tea to coffee. My nickname is ⟦NAME_1⟧.',
  );

  // The model cites what it read, with offsets into the redacted text.
  const cite = (quote: string) => ({
    source_id: 's',
    source_version: 1,
    start: segmentStart + seen.indexOf(quote),
    end: segmentStart + seen.indexOf(quote) + quote.length,
    quote,
  });
  const reply = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            proposals: [
              { op: 'add', content: 'prefers tea', sources: [cite('I prefer tea to coffee')] },
              { op: 'add', content: 'email ⟦EMAIL_1⟧', sources: [cite('⟦EMAIL_1⟧')] },
              { op: 'add', content: 'nickname', sources: [cite('My nickname is ⟦NAME_1⟧')] },
            ],
          }),
        },
      },
    ],
  });
  const back = JSON.parse(new Rehydrator(vault, 'chat/completions').json(reply)).choices[0].message
    .content as string;
  const proposals = reanchorSpans(
    JSON.parse(back).proposals as {
      content: string;
      sources: { start: number; end: number; quote: string }[];
    }[],
    text,
    segmentStart,
  );
  for (const proposal of proposals)
    for (const span of proposal.sources)
      expect(text.slice(span.start - segmentStart, span.end - segmentStart)).toBe(span.quote);
  expect(proposals[1]?.content).toBe('email sam.rivera@example.org');
  expect(proposals[2]?.sources[0]?.quote).toBe('My nickname is Ann "Nan" O\'Neil');
});

test('a quote that is not in the evidence is left for validation to refuse', () => {
  const [proposal] = reanchorSpans(
    [{ sources: [{ start: 0, end: 5, quote: 'never said' }] }],
    'something else entirely',
    0,
  );
  expect(proposal?.sources[0]).toEqual({ start: 0, end: 5, quote: 'never said' });
});
