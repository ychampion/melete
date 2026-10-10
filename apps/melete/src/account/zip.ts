/**
 * A zip archive written as it is read, so an export of any size streams to
 * the person without being held in memory or on disk first.
 *
 * Each entry's sizes and checksum follow its data (a data descriptor), since
 * they are known only once it has been read. Names are UTF-8. The central
 * directory takes the ZIP64 form only when the archive needs it: more than
 * 65,535 entries, or more than 4 GiB before the directory. A single entry is
 * limited to 4 GiB.
 */
import { crc32 } from 'node:zlib';

export type ZipEntry = {
  /** The path inside the archive, with `/` between folders. */
  name: string;
  data: Uint8Array | string | AsyncIterable<Uint8Array | string>;
  modified?: Date;
  /** Already compressed (an image, an archive): stored as it is. */
  store?: boolean;
};

const LIMIT_32 = 0xffffffff;
const encoder = new TextEncoder();

const bytesOf = (chunk: Uint8Array | string) =>
  typeof chunk === 'string' ? encoder.encode(chunk) : chunk;

async function* chunksOf(data: ZipEntry['data']): AsyncGenerator<Uint8Array> {
  if (typeof data === 'string' || data instanceof Uint8Array) {
    yield bytesOf(data);
    return;
  }
  for await (const chunk of data) yield bytesOf(chunk);
}

/** The time and date fields of a zip header, which count in local two-second steps. */
function dosTime(when: Date): { time: number; date: number } {
  const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

type Written = {
  name: Uint8Array;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
};

/** The archive as a stream of bytes. An entry that fails ends the stream with that error. */
export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator = archive(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

async function* archive(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for await (const entry of entries) {
    const clean = entry.name.replace(/^\/+/, '');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const name = encoder.encode(clean);
    const method = entry.store ? 0 : 8;
    const { time, date } = dosTime(entry.modified ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Sizes follow the data (bit 3); the name is UTF-8 (bit 11).
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const start = offset;
    yield local;
    yield name;
    offset += local.length + name.length;
    let crc = 0;
    let size = 0;
    let compressed = 0;
    if (method === 0) {
      for await (const chunk of chunksOf(entry.data)) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        compressed += chunk.length;
        yield chunk;
      }
    } else {
      const deflate = new CompressionStream('deflate-raw');
      const writer = deflate.writable.getWriter();
      const feeding = (async () => {
        try {
          for await (const chunk of chunksOf(entry.data)) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            await writer.write(chunk);
          }
          await writer.close();
        } catch (error) {
          await writer.abort(error).catch(() => {});
          throw error;
        }
      })();
      // Read while it is fed, so neither side waits on the other.
      const reader = deflate.readable.getReader();
      for (;;) {
        const part = await reader.read().catch(async (error) => {
          await feeding.catch(() => {});
          throw error;
        });
        if (part.done) break;
        compressed += part.value.length;
        yield part.value;
      }
      await feeding;
    }
    if (size > LIMIT_32 || compressed > LIMIT_32)
      throw new Error(`${clean} is larger than an export can hold`);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += compressed + descriptor.length;
    written.push({ name, method, time, date, crc: crc >>> 0, compressed, size, offset: start });
  }
  const directoryStart = offset;
  for (const entry of written) {
    const far = entry.offset >= LIMIT_32;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    // Made on Unix, so the permissions below are read.
    header.writeUInt16LE((3 << 8) | 45, 4);
    header.writeUInt16LE(far ? 45 : 20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(far ? 12 : 0, 30);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(far ? LIMIT_32 : entry.offset, 42);
    yield header;
    yield entry.name;
    offset += header.length + entry.name.length;
    if (far) {
      const extra = Buffer.alloc(12);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(entry.offset), 4);
      yield extra;
      offset += extra.length;
    }
  }
  const directorySize = offset - directoryStart;
  const count = written.length;
  if (count > 0xffff || directoryStart >= LIMIT_32 || directorySize >= LIMIT_32) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE((3 << 8) | 45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(count), 24);
    end64.writeBigUInt64LE(BigInt(count), 32);
    end64.writeBigUInt64LE(BigInt(directorySize), 40);
    end64.writeBigUInt64LE(BigInt(directoryStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    yield end64;
    yield locator;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(directorySize, LIMIT_32), 12);
  end.writeUInt32LE(Math.min(directoryStart, LIMIT_32), 16);
  yield end;
}
