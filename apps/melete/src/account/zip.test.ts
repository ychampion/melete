import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { zipEntries } from '../attachments/extract.ts';
import { type ZipEntry, zipStream } from './zip.ts';

/** Every entry of an archive, read back with its own sizes and checksum checked. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Uint8Array>();
  for (const [name, entry] of zipEntries(bytes)) {
    const start =
      entry.offset +
      30 +
      view.readUInt16LE(entry.offset + 26) +
      view.readUInt16LE(entry.offset + 28);
    const data = view.subarray(start, start + entry.compressed);
    const raw = entry.method === 8 ? inflateRawSync(data) : Buffer.from(data);
    if (raw.length !== entry.size) throw new Error(`${name}: size does not match`);
    out.set(name, new Uint8Array(raw));
  }
  return out;
}

async function* listed(entries: ZipEntry[]): AsyncGenerator<ZipEntry> {
  yield* entries;
}

const archive = async (entries: ZipEntry[]) =>
  new Uint8Array(await new Response(zipStream(listed(entries))).arrayBuffer());

describe('an export archive', () => {
  test('holds text, bytes and streamed entries as they were, readable by any unzip', async () => {
    const picture = crypto.getRandomValues(new Uint8Array(70_000));
    async function* parts() {
      for (let index = 0; index < 50; index++) yield `line ${index} of a long chat\n`;
    }
    const bytes = await archive([
      { name: 'README.md', data: '# Your export\n' },
      { name: 'spaces/home/files/artifacts/photo.png', data: picture, store: true },
      { name: 'spaces/home/chats/plan.md', data: parts() },
      { name: 'spaces/home/chats/naïve café.md', data: 'ünïcode names' },
      { name: 'empty.json', data: '' },
    ]);
    const read = unzip(bytes);
    expect([...read.keys()]).toEqual([
      'README.md',
      'spaces/home/files/artifacts/photo.png',
      'spaces/home/chats/plan.md',
      'spaces/home/chats/naïve café.md',
      'empty.json',
    ]);
    expect(new TextDecoder().decode(read.get('README.md'))).toBe('# Your export\n');
    expect(
      Buffer.from(read.get('spaces/home/files/artifacts/photo.png') ?? []).equals(
        Buffer.from(picture),
      ),
    ).toBe(true);
    expect(new TextDecoder().decode(read.get('spaces/home/chats/plan.md'))).toContain('line 49');
    expect(read.get('empty.json')?.length).toBe(0);
    // The system's own unzip agrees, checksums included, where one is installed.
    const unzipTool = Bun.which('unzip');
    if (unzipTool) {
      const dir = await mkdtemp(join(tmpdir(), 'melete-zip-'));
      try {
        await writeFile(join(dir, 'export.zip'), bytes);
        const run = Bun.spawnSync([unzipTool, '-t', join(dir, 'export.zip')]);
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toContain('No errors detected');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test('random entries come back byte for byte, and a repeated name is written once', async () => {
    for (let round = 0; round < 20; round++) {
      const entries: ZipEntry[] = [];
      const expected = new Map<string, Uint8Array>();
      const count = 1 + Math.floor(Math.random() * 12);
      for (let index = 0; index < count; index++) {
        const size = Math.floor(Math.random() ** 3 * 200_000);
        const data =
          Math.random() < 0.5
            ? crypto.getRandomValues(new Uint8Array(size))
            : new TextEncoder().encode('melete '.repeat(Math.ceil(size / 7)).slice(0, size));
        const name = `folder-${index % 3}/entry-${index}.bin`;
        expected.set(name, data);
        entries.push({ name, data, store: Math.random() < 0.3 });
      }
      entries.push({ name: 'folder-0/entry-0.bin', data: 'a second copy is left out' });
      const read = unzip(await archive(entries));
      expect([...read.keys()]).toEqual([...expected.keys()]);
      for (const [name, data] of expected)
        expect(Buffer.from(read.get(name) ?? []).equals(Buffer.from(data))).toBe(true);
    }
  });

  test('more entries than a plain zip can count take its larger form, which unzip reads', async () => {
    const unzipTool = Bun.which('unzip');
    if (!unzipTool) return;
    async function* many(): AsyncGenerator<ZipEntry> {
      for (let index = 0; index < 66_000; index++)
        yield { name: `records/${index}.json`, data: `${index}`, store: true };
    }
    const bytes = new Uint8Array(await new Response(zipStream(many())).arrayBuffer());
    const dir = await mkdtemp(join(tmpdir(), 'melete-zip64-'));
    try {
      await writeFile(join(dir, 'export.zip'), bytes);
      const run = Bun.spawnSync([unzipTool, '-t', '-q', join(dir, 'export.zip')]);
      expect(run.exitCode).toBe(0);
      const listing = Bun.spawnSync([unzipTool, '-Z1', join(dir, 'export.zip')]);
      expect(listing.stdout.toString().trim().split('\n')).toHaveLength(66_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('an entry that fails ends the download with an error rather than a short archive', async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('start');
      throw new Error('the disk went away');
    }
    const stream = zipStream(
      listed([
        { name: 'a.txt', data: 'fine' },
        { name: 'b.txt', data: broken() },
      ]),
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow('the disk went away');
  });
});
