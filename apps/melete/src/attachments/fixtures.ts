/**
 * Small, real files for tests: a PDF with a page per string, and the zip
 * packages a Word document and a spreadsheet are. Each is the least a reader
 * needs, written byte for byte so a test does not depend on a document tool.
 */
import { deflateRawSync } from 'node:zlib';

/** A PDF whose pages each show one line of text, with a correct cross-reference table. */
export function pdfWith(pages: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (const [index, text] of pages.entries()) {
    const page = pageIds[index] as number;
    const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`);
    const stream = `BT /F1 12 Tf 40 700 Td (${escaped}) Tj ET`;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[page + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A zip archive of these entries, deflated. */
export function zipOf(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const packed = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = Bun.hash.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Word document with these paragraphs, and a table of these rows after them. */
export function docxWith(
  paragraphs: readonly string[],
  table: readonly string[][] = [],
): Uint8Array {
  const body = [
    ...paragraphs.map(
      (text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    ),
    table.length
      ? `<w:tbl>${table
          .map(
            (row) =>
              `<w:tr>${row.map((cell) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`,
          )
          .join('')}</w:tbl>`
      : '',
  ].join('');
  return zipOf({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** A workbook with these sheets, each a list of rows; strings are shared, numbers inline. */
export function xlsxWith(sheets: Record<string, (string | number)[][]>): Uint8Array {
  const shared: string[] = [];
  const index = (text: string) => {
    const at = shared.indexOf(text);
    if (at >= 0) return at;
    shared.push(text);
    return shared.length - 1;
  };
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  };
  const names = Object.keys(sheets);
  for (const [position, name] of names.entries()) {
    const rows = (sheets[name] ?? [])
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell, c) => {
              const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
              return typeof cell === 'number'
                ? `<c r="${ref}"><v>${cell}</v></c>`
                : `<c r="${ref}" t="s"><v>${index(cell)}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    entries[`xl/worksheets/sheet${position + 1}.xml`] =
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  }
  entries['xl/workbook.xml'] =
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`;
  entries['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')}</Relationships>`;
  entries['xl/sharedStrings.xml'] =
    `<?xml version="1.0"?><sst>${shared.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join('')}</sst>`;
  return zipOf(entries);
}

/** A 1x1 PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
