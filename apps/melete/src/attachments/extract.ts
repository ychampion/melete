/**
 * The words in a file, for the model to read.
 *
 * A PDF gives its text page by page, each page marked, so an answer can say
 * where something was. A Word document gives its paragraphs, and its tables
 * as rows of cells. A spreadsheet gives each sheet as CSV under its name. A
 * text file is read as UTF-8. Nothing here runs what a file contains: a PDF's
 * scripts, a document's macros and a sheet's formulas are never evaluated
 * (a formula cell gives the value the file last saved for it).
 *
 * Every read is bounded in what it builds, not only in what it unpacks: one
 * character budget runs across every page, sheet and row and the read stops
 * the moment it is spent; sheets, pages, zip entries and the bytes unpacked
 * across all entries are capped; a repeated sheet is read once; and the XML
 * is scanned once, front to back, with no pattern that can look ahead to the
 * end of the input from every position. The service runs these functions in a
 * separate process with a time and memory limit (`bounded.ts`), so even a
 * file that defeats all of this costs a refusal, never the service.
 */
import { inflateRawSync } from 'node:zlib';
import { ATTACHMENT_LIMITS, type AttachmentKind } from '@melete/contracts';

export type Extracted = {
  /** The words, or null when none could be read (a scanned PDF, an empty sheet). */
  text: string | null;
  /** Pages in a PDF, sheets in a spreadsheet; null for other kinds. */
  pages: number | null;
};

export class UnreadableFile extends Error {
  readonly code = 'attachment_unreadable';
}

/** The sentence every limit ends in: the file is refused, plainly. */
export const TOO_COMPLEX = 'it is too complex to read';

/** The most one entry of a Word document or spreadsheet may unpack to. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** The most all the entries one document reads may unpack to, together. */
const MAX_TOTAL_INFLATED = 128 * 1024 * 1024;
/** The most entries a document's zip may list. */
const MAX_ZIP_ENTRIES = 10_000;
/** The most sheets read from one workbook. */
export const MAX_SHEETS = 50;
/** The most pages read from one PDF. */
export const MAX_PDF_PAGES = 2_000;
/** Empty columns between two cells written as commas; a wider gap is one marker. */
const MAX_GAP = 20;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Whether these bytes are what a file of this kind starts with. */
export function looksLike(kind: AttachmentKind, bytes: Uint8Array, mediaType = ''): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  switch (kind) {
    case 'image':
      if (mediaType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
      if (mediaType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
      if (mediaType === 'image/gif') return starts(0x47, 0x49, 0x46, 0x38);
      if (mediaType === 'image/webp')
        return (
          starts(0x52, 0x49, 0x46, 0x46) &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x45 &&
          bytes[10] === 0x42 &&
          bytes[11] === 0x50
        );
      return false;
    case 'pdf':
      // The header may follow a little junk; readers look in the first kilobyte.
      return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');
    case 'docx':
    case 'xlsx':
      return starts(0x50, 0x4b, 0x03, 0x04);
    case 'csv':
    case 'text':
      return isText(bytes);
  }
}

/** UTF-8 with no NUL byte: a text file, not a binary one. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a read may still produce. Every piece of output is taken from it, and
 * once it is spent the read stops where it is.
 */
export class Budget {
  private left: number;
  private readonly parts: string[] = [];
  constructor(characters: number = ATTACHMENT_LIMITS.stored_characters) {
    this.left = characters;
  }
  get spent(): boolean {
    return this.left <= 0;
  }
  /** Add a line; false once the budget is spent, which the caller stops on. */
  line(text: string): boolean {
    if (this.left <= 0) return false;
    const piece = text.length > this.left ? text.slice(0, this.left) : text;
    this.parts.push(piece);
    this.left -= piece.length + 1;
    return this.left > 0;
  }
  text(): string {
    return this.parts.join('\n');
  }
}

/**
 * The text of a file of this kind, read in this process. The service calls
 * `extractBounded` instead, which runs this in its own process. Throws
 * UnreadableFile when the bytes are not that kind or a limit is reached.
 */
export async function extractText(kind: AttachmentKind, bytes: Uint8Array): Promise<Extracted> {
  switch (kind) {
    case 'image':
      return { text: null, pages: null };
    case 'pdf':
      return pdfText(bytes);
    case 'docx':
      return { text: nonEmpty(docxText(bytes)), pages: null };
    case 'xlsx':
      return xlsxText(bytes);
    case 'csv':
    case 'text': {
      if (!isText(bytes)) throw new UnreadableFile('the file is not UTF-8 text');
      const budget = new Budget();
      budget.line(UTF8.decode(bytes).replace(/^﻿/, ''));
      return { text: nonEmpty(budget.text()), pages: null };
    }
  }
}

const nonEmpty = (text: string): string | null => {
  const trimmed = text.replace(/[ \t]+\n/g, '\n').trim();
  return trimmed ? trimmed : null;
};

/** Each page's text under a `[Page N]` line, up to the page cap and the budget. */
export async function pdfText(bytes: Uint8Array): Promise<Extracted> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // A copy: the reader takes ownership of the buffer it is given.
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch {
      throw new UnreadableFile('the PDF could not be opened');
    }
    const budget = new Budget();
    let words = false;
    const last = Math.min(document.numPages, MAX_PDF_PAGES);
    try {
      for (let number = 1; number <= last && !budget.spent; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const pieces: string[] = [];
        for (const item of content.items) {
          if (!('str' in item)) continue;
          pieces.push(item.str);
          if (item.hasEOL) pieces.push('\n');
          else if (item.str && !item.str.endsWith(' ')) pieces.push(' ');
        }
        page.cleanup();
        const clean = pieces
          .join('')
          .replace(/[ \t]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .trim();
        if (clean) words = true;
        budget.line(`[Page ${number}]\n${clean}\n`);
      }
    } catch (error) {
      if (error instanceof UnreadableFile) throw error;
      // A broken page tree, a bad cross-reference, a filter the reader does not know.
      throw new UnreadableFile('the PDF could not be read');
    }
    if (document.numPages > last && !budget.spent)
      budget.line(`[The other ${document.numPages - last} pages are not read here.]`);
    return { text: words ? nonEmpty(budget.text()) : null, pages: document.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/* ---------- Word and Excel: a zip of XML parts ---------- */

type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number };

/** The entries of a zip archive, from its central directory. */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = view.length - 22; at >= Math.max(0, view.length - 22 - 65_535); at--)
    if (view.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new UnreadableFile('the file is not a complete Office document');
  const count = view.readUInt16LE(end + 10);
  if (count > MAX_ZIP_ENTRIES) throw new UnreadableFile(TOO_COMPLEX);
  let at = view.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > view.length || view.readUInt32LE(at) !== 0x02014b50)
      throw new UnreadableFile('the file is not a complete Office document');
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const name = view.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    entries.set(name, {
      name,
      method: view.readUInt16LE(at + 10),
      compressed: view.readUInt32LE(at + 20),
      size: view.readUInt32LE(at + 24),
      offset: view.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** What one document's reads have unpacked so far, against the total cap. */
export type Unpacked = { bytes: number };

/** One entry's bytes as text, unpacked within the per-entry and total limits. */
export function zipText(
  bytes: Uint8Array,
  entry: ZipEntry,
  unpacked: Unpacked = { bytes: 0 },
): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > view.length || view.readUInt32LE(entry.offset) !== 0x04034b50)
    throw new UnreadableFile('the file is not a complete Office document');
  const start =
    entry.offset + 30 + view.readUInt16LE(entry.offset + 26) + view.readUInt16LE(entry.offset + 28);
  const data = view.subarray(start, start + entry.compressed);
  const room = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_INFLATED - unpacked.bytes);
  if (entry.size > room) throw new UnreadableFile(TOO_COMPLEX);
  let raw: Buffer;
  if (entry.method === 0) raw = data;
  else if (entry.method === 8)
    try {
      raw = inflateRawSync(data, { maxOutputLength: Math.max(1, room) });
    } catch {
      throw new UnreadableFile(TOO_COMPLEX);
    }
  else throw new UnreadableFile('the document is packed in a way Melete does not read');
  unpacked.bytes += raw.length;
  return raw.toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character data as text. */
export function xmlText(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-z]{2,4});/g, (whole, name: string) => {
    if (name.startsWith('#x')) return safeChar(Number.parseInt(name.slice(2), 16), whole);
    if (name.startsWith('#')) return safeChar(Number.parseInt(name.slice(1), 10), whole);
    return ENTITIES[name] ?? whole;
  });
}

const safeChar = (code: number, fallback: string) =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;

/** One tag in an XML part, as the scanner meets it. */
type Tag = {
  /** The element name, prefix included (`w:t`, `row`). */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** The text inside the tag after its name: its attributes. */
  attributes: string;
  /** Where the character data after this tag starts. */
  end: number;
};

/**
 * The tags of an XML part, front to back. Each step finds the next `<` and
 * the `>` after it with `indexOf`, so the whole part is read once; an
 * unclosed tag ends the scan instead of being searched for again from every
 * later position. Comments, processing instructions and declarations are
 * skipped, and nothing declared in them is honoured.
 */
function* tags(xml: string): Generator<Tag> {
  let at = 0;
  for (;;) {
    const open = xml.indexOf('<', at);
    if (open < 0) return;
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4);
      if (close < 0) return;
      at = close + 3;
      continue;
    }
    const close = xml.indexOf('>', open + 1);
    if (close < 0) return;
    at = close + 1;
    const first = xml.charCodeAt(open + 1);
    // `<?…?>` and `<!…>`: nothing to read.
    if (first === 63 || first === 33) continue;
    const closing = first === 47;
    const selfClosing = xml.charCodeAt(close - 1) === 47;
    const bodyStart = open + (closing ? 2 : 1);
    const bodyEnd = selfClosing ? close - 1 : close;
    let nameEnd = bodyStart;
    while (nameEnd < bodyEnd) {
      const code = xml.charCodeAt(nameEnd);
      if (code === 32 || code === 9 || code === 10 || code === 13) break;
      nameEnd++;
    }
    yield {
      name: xml.slice(bodyStart, nameEnd),
      closing,
      selfClosing,
      attributes: closing ? '' : xml.slice(nameEnd, bodyEnd),
      end: close + 1,
    };
  }
}

/** The character data from a tag's end to the next `<`. */
function textAfter(xml: string, tag: Tag): string {
  const next = xml.indexOf('<', tag.end);
  return xmlText(xml.slice(tag.end, next < 0 ? xml.length : next));
}

/** One attribute's value from a tag's attribute text. */
function attribute(attributes: string, name: string): string | undefined {
  // Scanned with indexOf: the attribute text is a single tag's, already bounded.
  let at = 0;
  for (;;) {
    const found = attributes.indexOf(`${name}="`, at);
    if (found < 0) return undefined;
    const before = found === 0 ? 32 : attributes.charCodeAt(found - 1);
    const valueStart = found + name.length + 2;
    if (before === 32 || before === 9 || before === 10 || before === 13) {
      const valueEnd = attributes.indexOf('"', valueStart);
      return valueEnd < 0 ? undefined : xmlText(attributes.slice(valueStart, valueEnd));
    }
    at = valueStart;
  }
}

/** The paragraphs of a Word document; a table's cells are joined with " | ". */
export function docxText(bytes: Uint8Array, budget: Budget = new Budget()): string {
  const entries = zipEntries(bytes);
  const main = entries.get('word/document.xml');
  if (!main) throw new UnreadableFile('the file is not a Word document');
  const xml = zipText(bytes, main);
  // The paragraph being read, the cell it is in, and the row of cells.
  let paragraph: string[] = [];
  let cell: string[] = [];
  let row: string[] = [];
  let depth = 0;
  for (const tag of tags(xml)) {
    if (budget.spent) break;
    switch (tag.name) {
      case 'w:t':
        if (!tag.closing && !tag.selfClosing) paragraph.push(textAfter(xml, tag));
        break;
      case 'w:tab':
        paragraph.push('\t');
        break;
      case 'w:br':
        paragraph.push(depth > 0 ? ' ' : '\n');
        break;
      case 'w:p':
        if (!tag.closing) break;
        if (depth > 0) cell.push(paragraph.join(''));
        else budget.line(paragraph.join(''));
        paragraph = [];
        break;
      case 'w:tc':
        if (!tag.closing) depth++;
        else {
          depth = Math.max(0, depth - 1);
          row.push(cell.join(' ').trim());
          cell = [];
        }
        break;
      case 'w:tr':
        if (tag.closing) {
          budget.line(row.join(' | '));
          row = [];
        }
        break;
    }
  }
  if (paragraph.length) budget.line(paragraph.join(''));
  return budget.text().replace(/\n{3,}/g, '\n\n');
}

/** Each sheet of a workbook as CSV, under a `[Sheet: name]` line. */
export function xlsxText(bytes: Uint8Array): Extracted {
  const entries = zipEntries(bytes);
  const unpacked: Unpacked = { bytes: 0 };
  const workbook = entries.get('xl/workbook.xml');
  if (!workbook) throw new UnreadableFile('the file is not a spreadsheet');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (rels)
    for (const tag of tags(zipText(bytes, rels, unpacked))) {
      if (tag.name !== 'Relationship' || tag.closing) continue;
      const id = attribute(tag.attributes, 'Id');
      const target = attribute(tag.attributes, 'Target');
      if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  const shared = sharedStrings(entries, bytes, unpacked);
  const budget = new Budget();
  const read = new Set<string>();
  let index = 0;
  let words = false;
  for (const tag of tags(zipText(bytes, workbook, unpacked))) {
    if (tag.name !== 'sheet' || tag.closing) continue;
    index++;
    if (index > MAX_SHEETS || budget.spent) continue;
    const name = attribute(tag.attributes, 'name') ?? `Sheet ${index}`;
    const rel = attribute(tag.attributes, 'r:id');
    const target = (rel && targets.get(rel)) ?? `worksheets/sheet${index}.xml`;
    budget.line(`${index > 1 ? '\n' : ''}[Sheet: ${name}]`);
    // Two sheets naming one part read it once.
    if (read.has(target)) {
      budget.line('[The same sheet as one above.]');
      continue;
    }
    read.add(target);
    const entry = entries.get(`xl/${target}`);
    if (entry && sheetRows(zipText(bytes, entry, unpacked), shared, budget)) words = true;
  }
  if (index > MAX_SHEETS && !budget.spent)
    budget.line(`\n[The other ${index - MAX_SHEETS} sheets are not read here.]`);
  return { text: words ? nonEmpty(budget.text()) : null, pages: index };
}

/** The workbook's shared strings, in order: each `<si>`'s runs joined. */
function sharedStrings(
  entries: Map<string, ZipEntry>,
  bytes: Uint8Array,
  unpacked: Unpacked,
): string[] {
  const entry = entries.get('xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = zipText(bytes, entry, unpacked);
  const shared: string[] = [];
  let current: string[] | null = null;
  for (const tag of tags(xml)) {
    if (tag.name === 'si') {
      if (!tag.closing) current = [];
      else if (current) {
        shared.push(current.join(''));
        current = null;
      }
    } else if (tag.name === 't' && !tag.closing && !tag.selfClosing && current)
      current.push(textAfter(xml, tag));
  }
  return shared;
}

/**
 * A sheet's rows as CSV lines, taken from the budget. A gap of a few empty
 * cells is kept as commas; a wider one is one marker, so a single cell far to
 * the right costs a few characters, not one per column. True when any cell
 * had text.
 */
function sheetRows(xml: string, shared: readonly string[], budget: Budget): boolean {
  let words = false;
  let cells: { column: number; text: string }[] = [];
  let cell: { column: number; type: string; value: string[]; inline: string[] } | null = null;
  let inValue = false;
  for (const tag of tags(xml)) {
    if (budget.spent) break;
    switch (tag.name) {
      case 'row':
        if (!tag.closing) cells = [];
        if (tag.closing || tag.selfClosing) {
          budget.line(csvLine(cells));
          cells = [];
        }
        break;
      case 'c': {
        if (!tag.closing) {
          const reference = attribute(tag.attributes, 'r');
          const letters = reference ? /^[A-Z]{1,3}/.exec(reference)?.[0] : undefined;
          cell = {
            column: letters ? columnIndex(letters) : (cells.at(-1)?.column ?? -1) + 1,
            type: attribute(tag.attributes, 't') ?? 'n',
            value: [],
            inline: [],
          };
        }
        if ((tag.closing || tag.selfClosing) && cell) {
          const value = cell.value.join('');
          let text = '';
          if (cell.type === 's') text = shared[Number(value)] ?? '';
          else if (cell.type === 'inlineStr') text = cell.inline.join('');
          else if (cell.type === 'b') text = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '';
          else text = value;
          if (text) {
            words = true;
            cells.push({ column: cell.column, text });
          }
          cell = null;
        }
        break;
      }
      case 'v':
        inValue = !tag.closing && !tag.selfClosing;
        if (inValue && cell) cell.value.push(textAfter(xml, tag));
        break;
      case 't':
        if (!tag.closing && !tag.selfClosing && cell) cell.inline.push(textAfter(xml, tag));
        break;
    }
  }
  return words;
}

function csvLine(cells: readonly { column: number; text: string }[]): string {
  const fields: string[] = [];
  let next = 0;
  for (const { column, text } of cells) {
    const gap = column - next;
    if (gap > MAX_GAP) fields.push(`[${gap} empty columns]`);
    else for (let index = 0; index < gap; index++) fields.push('');
    fields.push(csvField(text));
    next = Math.max(next, column + 1);
  }
  return fields.join(',');
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.min(index - 1, 16_383);
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
