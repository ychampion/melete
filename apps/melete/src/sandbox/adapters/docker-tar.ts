/**
 * The smallest tar writer the docker sandbox needs: regular files and
 * directories with an owner and permission bits, and a PAX record for a name
 * longer than the classic header holds. Docker's archive endpoint reads it with
 * Go's `archive/tar`, which accepts both.
 */

export type TarEntry = {
  /** Relative, `/`-separated, without `.` or `..` segments. */
  name: string;
  directory: boolean;
  mode: number;
  uid: number;
  gid: number;
  bytes?: Uint8Array;
};

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, type: string, size: number, entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number, width: number) => {
    const bytes = encoder.encode(text);
    if (bytes.byteLength > width) throw new Error('a tar header field is too long');
    block.set(bytes, offset);
  };
  put(name, 0, 100);
  put(octal(entry.mode & 0o7777, 8), 100, 8);
  put(octal(entry.uid, 8), 108, 8);
  put(octal(entry.gid, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  // The checksum is summed with its own field read as spaces.
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** One PAX `path` record, whose length counts its own digits. */
function paxPath(name: string): Uint8Array {
  const body = ` path=${name}\n`;
  const size = encoder.encode(body).byteLength;
  let length = size + String(size).length;
  if (String(length).length !== String(size).length) length += 1;
  return encoder.encode(`${length}${body}`);
}

function padded(bytes: Uint8Array): Uint8Array[] {
  const rest = bytes.byteLength % BLOCK;
  return rest ? [bytes, new Uint8Array(BLOCK - rest)] : [bytes];
}

export function checkTarName(name: string): string {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\0') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`a tar entry name must be a plain relative path: ${JSON.stringify(name)}`);
  return name;
}

export function tarArchive(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const name = checkTarName(entry.name) + (entry.directory ? '/' : '');
    const size = entry.directory ? 0 : (entry.bytes?.byteLength ?? 0);
    let short = name;
    if (encoder.encode(name).byteLength > 100) {
      const record = paxPath(name);
      parts.push(header('PaxHeaders/entry', 'x', record.byteLength, entry), ...padded(record));
      short = `long-${parts.length}${entry.directory ? '/' : ''}`;
    }
    parts.push(header(short, entry.directory ? '5' : '0', size, entry));
    if (!entry.directory && entry.bytes?.byteLength) parts.push(...padded(entry.bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
