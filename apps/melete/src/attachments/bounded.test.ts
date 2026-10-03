/**
 * Files built to make a reader spend: each is read in its child process
 * within a bounded time and a bounded output, and a read that passes its
 * deadline is refused with the plain sentence, never a crash.
 */
import { describe, expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS } from '@melete/contracts';
import { extractBounded } from './bounded.ts';
import { MAX_PDF_PAGES, TOO_COMPLEX, UnreadableFile } from './extract.ts';
import { pdfWith, zipOf } from './fixtures.ts';

/**
 * A workbook whose every sheet names the same part, and whose one sheet holds
 * 20,000 rows, each with a single cell in the last column there is (XFD).
 */
function spreadsheetBomb(sheetRefs: number): Uint8Array {
  const rows: string[] = [];
  for (let r = 1; r <= 20_000; r++) rows.push(`<row r="${r}"><c r="XFD${r}"><v>${r}</v></c></row>`);
  return zipOf({
    'xl/workbook.xml': `<workbook><sheets>${Array.from(
      { length: sheetRefs },
      (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId1"/>`,
    ).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`,
  });
}

/** One table row of 200,000 cells, then a run of tags left open. */
function deepDocument(): Uint8Array {
  const cells = '<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>'.repeat(200_000);
  return zipOf({
    'word/document.xml': `<w:document><w:body><w:tbl><w:tr>${cells}</w:tr></w:tbl>${'<w:t '.repeat(200_000)}</w:body></w:document>`,
  });
}

const timed = async <T>(work: () => Promise<T>) => {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
};

describe('reading a file built to make the reader spend', () => {
  test('a spreadsheet naming one huge sheet many times is read once, briefly, within the budget', async () => {
    const bomb = spreadsheetBomb(20);
    expect(bomb.length).toBeLessThan(200_000);
    const { result, ms } = await timed(() => extractBounded('xlsx', bomb));
    expect(ms).toBeLessThan(10_000);
    const text = result.text ?? '';
    expect(text.length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.stored_characters);
    // A cell far to the right costs a marker, not a comma for every empty column.
    expect(text).toContain('[16383 empty columns],1\n');
    expect(text).toContain('[Sheet: S1]\n[The same sheet as one above.]');
    expect(result.pages).toBe(20);
  }, 30_000);

  test('a Word document with a huge row and unclosed tags is read in bounded time', async () => {
    const { result, ms } = await timed(() => extractBounded('docx', deepDocument()));
    expect(ms).toBeLessThan(10_000);
    expect((result.text ?? '').length).toBeLessThanOrEqual(ATTACHMENT_LIMITS.stored_characters);
    expect(result.text?.startsWith('x | x | x')).toBe(true);
  }, 30_000);

  test('a PDF with more pages than the cap is read to the cap and says how many were left', async () => {
    const pages = MAX_PDF_PAGES + 100;
    const { result, ms } = await timed(() =>
      extractBounded('pdf', pdfWith(Array.from({ length: pages }, (_, i) => `Page text ${i + 1}`))),
    );
    expect(ms).toBeLessThan(15_000);
    expect(result.pages).toBe(pages);
    expect(result.text).toContain(`[Page ${MAX_PDF_PAGES}]\nPage text ${MAX_PDF_PAGES}`);
    expect(result.text).not.toContain(`[Page ${MAX_PDF_PAGES + 1}]`);
    expect(result.text).toContain('[The other 100 pages are not read here.]');
  }, 60_000);

  test('a read that passes its deadline is refused with the plain sentence', async () => {
    const read = extractBounded('xlsx', spreadsheetBomb(5), { deadlineMs: 1 });
    await expect(read).rejects.toBeInstanceOf(UnreadableFile);
    await expect(read).rejects.toThrow(TOO_COMPLEX);
  }, 30_000);

  test.if(process.platform === 'linux')(
    'a read that passes its memory ceiling is stopped and refused with the plain sentence',
    async () => {
      const read = extractBounded(
        'pdf',
        pdfWith(Array.from({ length: MAX_PDF_PAGES }, (_, i) => `Page ${i}`)),
        { memoryBytes: 1 },
      );
      await expect(read).rejects.toThrow(TOO_COMPLEX);
    },
    30_000,
  );

  test('a PDF whose page cannot be read is refused with a sentence, not an error', async () => {
    const broken = new TextEncoder().encode(
      new TextDecoder()
        .decode(pdfWith(['fine']))
        .replace('/Contents 5 0 R', '/Contents 99 0 R /Kids 7'),
    );
    const read = await extractBounded('pdf', broken).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if ('error' in read) expect(read.error).toBeInstanceOf(UnreadableFile);
    else expect(read.value.pages).toBe(1);
    await expect(
      extractBounded('pdf', new TextEncoder().encode('%PDF-1.4\ngarbage')),
    ).rejects.toThrow('the PDF could not be opened');
  }, 30_000);
});
