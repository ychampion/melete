import { expect, test } from 'bun:test';
import { type AttachmentKind, originalKind } from '@melete/contracts/attachments';
import { renderToStaticMarkup } from 'react-dom/server';
import { kindWords } from '../screens/Files.tsx';
import { MessageFiles } from './MessageFiles.tsx';

const kinds: [AttachmentKind, string, string][] = [
  ['image', 'image/png', 'A picture'],
  ['pdf', 'application/pdf', 'A PDF document'],
  [
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'A Word document',
  ],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'A spreadsheet'],
  ['csv', 'text/csv', 'A spreadsheet'],
  ['text', 'text/plain', 'A text document'],
];

for (const [kind, mime, label] of kinds) {
  test(`a kept-back ${kind} uses the same words in its thread tile, Files and activity`, () => {
    const html = renderToStaticMarkup(
      <MessageFiles files={[{ id: 'file_kept', kind, kept_back: true }]} />,
    );
    expect(html).toContain(`>${label}</span>`);
    expect(originalKind(mime)).toBe(label);
    expect(kindWords({ mime })).toBe(label);
    expect(html).not.toContain('A document');
    expect(html).toContain('Opening it is noted in the room’s activity.');
  });
}

test('audio originals are labelled as recordings in Files and activity', () => {
  for (const mime of ['audio/wav', 'audio/mpeg', 'Audio/WebM; codecs=opus']) {
    expect(originalKind(mime)).toBe('A recording');
    expect(kindWords({ mime })).toBe('A recording');
  }
});
