import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { extractText, looksLike, UnreadableFile, zipEntries, zipText } from './extract.ts';
import { docxWith, pdfWith, TINY_PNG, xlsxWith, zipOf } from './fixtures.ts';

describe('the words in a file', () => {
  test('a PDF gives each page under its own marker, and its page count', async () => {
    const read = await extractText(
      'pdf',
      pdfWith(['The lease starts in May.', 'Rent is due on the first.', 'Pets need consent.']),
    );
    expect(read.pages).toBe(3);
    expect(read.text).toContain('[Page 1]\nThe lease starts in May.');
    expect(read.text).toContain('[Page 3]\nPets need consent.');
    expect(read.text?.indexOf('[Page 2]')).toBeLessThan(read.text?.indexOf('[Page 3]') ?? 0);
  });

  test('a PDF with no text says so with null rather than empty markers', async () => {
    const read = await extractText('pdf', pdfWith(['']));
    expect(read).toEqual({ text: null, pages: 1 });
  });

  test('a Word document gives its paragraphs, and table rows as cells joined by bars', async () => {
    const read = await extractText(
      'docx',
      docxWith(
        ['Water damage report', 'Seen on 2 October & reported.'],
        [
          ['Room', 'Damage'],
          ['Kitchen', 'Ceiling stain'],
        ],
      ),
    );
    expect(read.text).toBe(
      'Water damage report\nSeen on 2 October & reported.\nRoom | Damage\nKitchen | Ceiling stain',
    );
  });

  test('a spreadsheet gives each sheet as CSV under its name', async () => {
    const read = await extractText(
      'xlsx',
      xlsxWith({
        Budget: [
          ['Item', 'Cost'],
          ['Rent, May', 2400],
        ],
        Notes: [['Paid "on time"']],
      }),
    );
    expect(read.pages).toBe(2);
    expect(read.text).toBe(
      '[Sheet: Budget]\nItem,Cost\n"Rent, May",2400\n\n[Sheet: Notes]\n"Paid ""on time"""',
    );
  });

  test('text and CSV are read as UTF-8; a file that is not is refused', async () => {
    expect((await extractText('text', new TextEncoder().encode('\uFEFFhello\n'))).text).toBe(
      'hello',
    );
    expect((await extractText('csv', new TextEncoder().encode('a,b\n1,2'))).text).toBe('a,b\n1,2');
    await expect(extractText('text', Uint8Array.from([0x68, 0x00, 0x69]))).rejects.toBeInstanceOf(
      UnreadableFile,
    );
  });

  test('bytes are checked against what the file says it is', () => {
    expect(looksLike('image', TINY_PNG, 'image/png')).toBe(true);
    expect(looksLike('image', TINY_PNG, 'image/jpeg')).toBe(false);
    expect(looksLike('pdf', pdfWith(['x']))).toBe(true);
    expect(looksLike('pdf', TINY_PNG)).toBe(false);
    expect(looksLike('docx', docxWith(['x']))).toBe(true);
    expect(looksLike('xlsx', new TextEncoder().encode('not a zip'))).toBe(false);
  });

  test('a document that is not one, or unpacks past the limit, is refused rather than read', async () => {
    await expect(extractText('docx', zipOf({ 'other.xml': '<x/>' }))).rejects.toBeInstanceOf(
      UnreadableFile,
    );
    await expect(
      extractText('xlsx', new TextEncoder().encode('PK\u0003\u0004junk')),
    ).rejects.toBeInstanceOf(UnreadableFile);
    // An entry that claims to be larger than any document part may be is not unpacked.
    const bomb = zipOf({ 'word/document.xml': 'x' });
    const entry = zipEntries(bomb).get('word/document.xml');
    if (!entry) throw new Error('expected the entry');
    expect(() => zipText(bomb, { ...entry, size: 512 * 1024 * 1024 })).toThrow(UnreadableFile);
    // One that lies about its size is still cut off at the limit while it unpacks.
    const huge = deflateRawSync(Buffer.alloc(80 * 1024 * 1024));
    const packed = Buffer.from(bomb);
    expect(() =>
      zipText(new Uint8Array(Buffer.concat([packed.subarray(0, 30 + 17), huge])), {
        ...entry,
        compressed: huge.length,
        size: 1,
      }),
    ).toThrow(UnreadableFile);
  });
});
