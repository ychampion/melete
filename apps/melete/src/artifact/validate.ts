/**
 * The deterministic and render validators.
 *
 * Everything here is a function of bytes, declared kind, and declared checks.
 * Nothing here asks a model anything, and nothing here trusts a claim made in a
 * payload: the numbers are added up again, the sections are looked for again,
 * the image header is read again. A check that cannot be computed fails and
 * says why, because "could not tell" presented as a pass is the failure this
 * whole file exists to prevent.
 */
import {
  type ArtifactCheck,
  type ArtifactExpectation,
  type ArtifactKind,
  artifactCheckName,
  type PendingArtifactValidation,
} from '@melete/contracts';
import { Ajv } from 'ajv';

const now = () => new Date().toISOString();
const validator = new Ajv({ strict: false, allErrors: false });

type Result = Omit<PendingArtifactValidation, 'checked_at'>;
const pass = (cls: Result['class'], name: string, evidence: Result['evidence'] = {}): Result => ({
  class: cls,
  name,
  status: 'passed',
  detail: '',
  evidence,
  advisory: false,
});
const fail = (
  cls: Result['class'],
  name: string,
  detail: string,
  evidence: Result['evidence'] = {},
): Result => ({ class: cls, name, status: 'failed', detail, evidence, advisory: false });
const unavailable = (cls: Result['class'], name: string, detail: string): Result => ({
  class: cls,
  name,
  status: 'unavailable',
  detail,
  evidence: {},
  advisory: cls === 'critique',
});

// --------------------------------------------------------------------------
// parsing
// --------------------------------------------------------------------------

/**
 * RFC 4180 enough for a spreadsheet export: quoted fields, doubled quotes
 * inside them, CRLF or LF. A ragged row is an error and not a silent pad,
 * because a row with a missing cell is exactly how a total stops adding up.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      if (started || field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (quoted) throw new Error('an opened quote is never closed');
  if (started || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  for (const [index, entry] of rows.entries()) {
    if (entry.length !== header.length) {
      throw new Error(
        `row ${index + 2} has ${entry.length} cells where the header has ${header.length}`,
      );
    }
  }
  return { header, rows };
}

/** Headings a Markdown document declares, in order, with their level dropped. */
export function markdownHeadings(text: string): string[] {
  const headings: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[2]) headings.push(match[2].trim());
  }
  return headings;
}

/** Width and height from the file's own header. No decoding, no dependency. */
export function imageDimensions(
  bytes: Uint8Array,
): { format: string; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = view.getUint16(offset + 2);
      // SOF0..SOF15, minus the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          format: 'jpeg',
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

const numberFrom = (raw: string): number | null => {
  const cleaned = raw
    .trim()
    .replace(/[$£€\s]/g, '')
    .replace(/,/g, '');
  if (!cleaned || !/^-?\(?\d*\.?\d+\)?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')');
  const value = Number(negative ? cleaned.slice(1, -1) : cleaned);
  return Number.isFinite(value) ? (negative ? -value : value) : null;
};

// --------------------------------------------------------------------------
// deterministic checks
// --------------------------------------------------------------------------

type Parsed =
  | { kind: 'csv'; table: { header: string[]; rows: string[][] } }
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'bytes' };

function parseFor(kind: ArtifactKind, bytes: Uint8Array): { parsed: Parsed; error?: string } {
  const text = () => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    switch (kind) {
      case 'csv':
        return { parsed: { kind: 'csv', table: parseCsv(text()) } };
      case 'json':
        return { parsed: { kind: 'json', value: JSON.parse(text()) } };
      case 'markdown':
      case 'text':
      case 'html':
        return { parsed: { kind: 'text', text: text() } };
      default:
        return { parsed: { kind: 'bytes' } };
    }
  } catch (error) {
    return { parsed: { kind: 'bytes' }, error: (error as Error).message };
  }
}

function runCheck(check: ArtifactCheck, kind: ArtifactKind, parsed: Parsed, bytes: Uint8Array) {
  switch (check.kind) {
    case 'parses':
      // The parse already happened; reaching here means it worked.
      return pass('deterministic', `${kind}.parses`);
    case 'non_empty': {
      const empty =
        parsed.kind === 'text'
          ? parsed.text.trim().length === 0
          : parsed.kind === 'csv'
            ? parsed.table.rows.length === 0
            : bytes.byteLength === 0;
      return empty
        ? fail('deterministic', 'non_empty', 'the file has no content')
        : pass('deterministic', 'non_empty', { bytes: bytes.byteLength });
    }
    case 'schema': {
      if (parsed.kind !== 'json')
        return fail('deterministic', 'schema', 'a schema check needs a JSON artifact');
      const ok = validator.validate(check.schema, parsed.value);
      return ok
        ? pass('deterministic', 'schema')
        : fail(
            'deterministic',
            'schema',
            validator.errors?.[0]
              ? `${validator.errors[0].instancePath || '<root>'} ${validator.errors[0].message}`
              : 'the document does not match the declared schema',
          );
    }
    case 'required_sections': {
      if (parsed.kind !== 'text')
        return fail('deterministic', 'required_sections', 'sections need a text artifact');
      const headings = markdownHeadings(parsed.text).map((h) => h.toLowerCase());
      const missing = check.sections.filter((want) => !headings.includes(want.toLowerCase()));
      return missing.length === 0
        ? pass('deterministic', 'required_sections', { headings })
        : fail(
            'deterministic',
            'required_sections',
            `missing ${missing.map((m) => `"${m}"`).join(', ')}`,
            { headings, missing },
          );
    }
    case 'required_columns': {
      if (parsed.kind !== 'csv')
        return fail('deterministic', 'required_columns', 'columns need a tabular artifact');
      const header = parsed.table.header.map((h) => h.trim().toLowerCase());
      const missing = check.columns.filter((want) => !header.includes(want.trim().toLowerCase()));
      return missing.length === 0
        ? pass('deterministic', 'required_columns', { header })
        : fail(
            'deterministic',
            'required_columns',
            `missing ${missing.map((m) => `"${m}"`).join(', ')}`,
            { header, missing },
          );
    }
    case 'row_count': {
      if (parsed.kind !== 'csv')
        return fail('deterministic', 'row_count', 'a row count needs a tabular artifact');
      const count = parsed.table.rows.length;
      if (count < check.min)
        return fail('deterministic', 'row_count', `${count} rows, at least ${check.min} expected`, {
          count,
        });
      if (check.max !== null && count > check.max)
        return fail('deterministic', 'row_count', `${count} rows, at most ${check.max} allowed`, {
          count,
        });
      return pass('deterministic', 'row_count', { count });
    }
    case 'totals': {
      const name = artifactCheckName(check);
      if (parsed.kind !== 'csv')
        return fail('deterministic', name, 'a totals check needs a tabular artifact');
      const index = parsed.table.header.findIndex(
        (h) => h.trim().toLowerCase() === check.column.trim().toLowerCase(),
      );
      if (index < 0) return fail('deterministic', name, `no column named "${check.column}"`);
      let sum = 0;
      let stated: number | null = check.equals;
      let counted = 0;
      for (const row of parsed.table.rows) {
        const label = (row[0] ?? '').trim().toLowerCase();
        const cell = row[index] ?? '';
        const value = numberFrom(cell);
        if (check.total_label && label === check.total_label.trim().toLowerCase()) {
          if (value === null)
            return fail('deterministic', name, `the "${check.total_label}" row has no number`);
          stated = value;
          continue;
        }
        if (cell.trim() === '') continue;
        if (value === null)
          return fail('deterministic', name, `"${cell.trim()}" in ${check.column} is not a number`);
        sum += value;
        counted += 1;
      }
      if (stated === null)
        return fail('deterministic', name, 'nothing declared what the total should be', { sum });
      const delta = Math.abs(sum - stated);
      return delta <= check.tolerance
        ? pass('deterministic', name, { sum, stated, rows: counted })
        : fail(
            'deterministic',
            name,
            `${check.column} adds up to ${sum}, but the total says ${stated}`,
            { sum, stated, delta, rows: counted },
          );
    }
    case 'image_dimensions': {
      const size = imageDimensions(bytes);
      if (!size)
        return fail('deterministic', 'image_dimensions', 'the file has no readable image header');
      const problems: string[] = [];
      if (check.width !== null && size.width !== check.width)
        problems.push(`width ${size.width} is not ${check.width}`);
      if (check.height !== null && size.height !== check.height)
        problems.push(`height ${size.height} is not ${check.height}`);
      if (check.min_width !== null && size.width < check.min_width)
        problems.push(`width ${size.width} is under ${check.min_width}`);
      if (check.min_height !== null && size.height < check.min_height)
        problems.push(`height ${size.height} is under ${check.min_height}`);
      return problems.length === 0
        ? pass('deterministic', 'image_dimensions', { ...size })
        : fail('deterministic', 'image_dimensions', problems.join('; '), { ...size });
    }
  }
}

// --------------------------------------------------------------------------
// render
// --------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

/**
 * Markdown to HTML: headings, paragraphs, lists, fenced code, block quotes,
 * and the inline forms. It is small on purpose. Its job is not typesetting, it
 * is to open the file the way a reader would and see whether anything comes
 * out, so a "report" that is one unterminated code fence is caught here.
 */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let list: 'ul' | 'ol' | null = null;
  let fence: string | null = null;
  let code: string[] = [];
  let paragraph: string[] = [];
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closeParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fenceMatch?.[1]) {
      if (fence === null) {
        closeParagraph();
        closeList();
        fence = fenceMatch[1];
        code = [];
      } else if (fenceMatch[1] === fence) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        fence = null;
      } else code.push(line);
      continue;
    }
    if (fence !== null) {
      code.push(line);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      closeParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) {
        closeList();
        list = wanted;
        out.push(`<${wanted}>`);
      }
      out.push(`<li>${inline(item)}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeParagraph();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (fence !== null) throw new Error('a code fence is opened and never closed');
  closeParagraph();
  closeList();
  return out.join('\n');
}

/** A CSV rendered as the table a reader would see. Ragged rows have already failed. */
export function renderCsvTable(table: { header: string[]; rows: string[][] }): string {
  const head = table.header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
  const body = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function render(kind: ArtifactKind, parsed: Parsed, bytes: Uint8Array): Result {
  try {
    switch (kind) {
      case 'markdown': {
        if (parsed.kind !== 'text')
          return fail('render', 'render:markdown', 'the file is not text');
        const html = renderMarkdown(parsed.text);
        return html.trim()
          ? pass('render', 'render:markdown', { html_bytes: html.length })
          : fail('render', 'render:markdown', 'the document renders to nothing');
      }
      case 'csv': {
        if (parsed.kind !== 'csv') return fail('render', 'render:csv', 'the file is not tabular');
        const html = renderCsvTable(parsed.table);
        return pass('render', 'render:csv', {
          html_bytes: html.length,
          rows: parsed.table.rows.length,
        });
      }
      case 'json':
      case 'text':
      case 'html':
        return parsed.kind === 'bytes'
          ? fail('render', `render:${kind}`, 'the file is not decodable text')
          : pass('render', `render:${kind}`);
      case 'image': {
        const size = imageDimensions(bytes);
        return size
          ? pass('render', 'render:image', { ...size })
          : fail('render', 'render:image', 'no decoder recognised the file header');
      }
      default:
        // DOCX, XLSX and PDF need a maintained reader. Bun ships none and this
        // release adds no dependency for it, so the honest result is the word
        // `unavailable` rather than a pass nobody earned.
        // Advisory on purpose. A missing renderer says nothing about the file,
        // and a validator that establishes nothing must not be able to block a
        // job; a renderer that runs and fails still does, because that is a
        // fact about the bytes.
        return {
          ...unavailable(
            'render',
            `render:${kind}`,
            'no renderer for this kind is available in this release',
          ),
          advisory: true,
        };
    }
  } catch (error) {
    return fail('render', `render:${kind}`, (error as Error).message);
  }
}

// --------------------------------------------------------------------------
// the entry point
// --------------------------------------------------------------------------

/**
 * Run everything that can be decided without asking anyone. A critique is
 * declared here as `pending` and left for the recorder to resolve; a human
 * acceptance is declared as `pending` and left for a person.
 */
export function validateArtifact(
  expectation: ArtifactExpectation,
  bytes: Uint8Array,
): PendingArtifactValidation[] {
  const checkedAt = now();
  const { parsed, error } = parseFor(expectation.kind, bytes);
  const results: Result[] = [];
  if (error) {
    results.push(fail('deterministic', `${expectation.kind}.parses`, error));
  } else if (parsed.kind !== 'bytes') {
    results.push(pass('deterministic', `${expectation.kind}.parses`));
  }
  for (const check of expectation.checks) {
    // A file that did not parse cannot answer a question about its contents.
    if (error && check.kind !== 'non_empty') {
      results.push(
        fail(
          'deterministic',
          artifactCheckName(check),
          'the file did not parse, so this check could not be computed',
        ),
      );
      continue;
    }
    results.push(runCheck(check, expectation.kind, parsed, bytes));
  }
  if (expectation.render) results.push(render(expectation.kind, parsed, bytes));
  if (expectation.critique) {
    results.push({
      class: 'critique',
      name: 'critique',
      status: 'pending',
      detail: expectation.critique,
      evidence: {},
      advisory: true,
    });
  }
  if (expectation.human) {
    results.push({
      class: 'human',
      name: 'human',
      status: 'pending',
      detail: 'waiting for the owner to accept this artifact',
      evidence: {},
      advisory: false,
    });
  }
  // Names are unique by construction: `artifactExpectation` refuses two checks
  // that would be recorded under the same name, so nothing is dropped here.
  // A collision at this point is a bug in the namer and is worth a crash.
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.name)) throw new Error(`two validations named ${result.name}`);
    seen.add(result.name);
  }
  return results.map((result) => ({ ...result, checked_at: checkedAt }));
}
