/**
 * A silent WAV with the script inside it.
 *
 * The fake text-to-speech adapter has to produce a real file, not a placeholder
 * string: the artifact is what a person downloads, the content hash is what
 * verify compares, and a test that asserts on a fake format proves nothing
 * about the real one. So it writes a valid RIFF/WAVE of silence, with the
 * script in a LIST/INFO comment chunk where any tool that reads WAV metadata
 * can find it.
 *
 * That makes the whole capability path testable with no key and no network,
 * and the assertion "the episode says what the script said" is a real read of a
 * real file.
 */

const SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A RIFF chunk: four ASCII bytes, a little-endian length, the body, and a pad byte if odd. */
function chunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length % 2 === 1 ? body.length + 1 : body.length;
  const out = new Uint8Array(8 + padded);
  out.set(ascii(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export type SilentWavOptions = {
  /** How long the silence runs. A script is read at roughly 150 words a minute. */
  durationMs?: number;
  /** Goes into the LIST/INFO comment chunk verbatim. */
  script: string;
  /** Goes into the LIST/INFO name chunk. */
  title?: string;
};

/** Roughly how long a script takes to read aloud, so a fake file has an honest length. */
export const spokenDurationMs = (script: string): number => {
  const words = script.trim().split(/\s+/u).filter(Boolean).length;
  return Math.max(1000, Math.round((words / 150) * 60_000));
};

/** A playable file: 16 kHz mono silence, with the script in its metadata. */
export function silentWav(options: SilentWavOptions): Uint8Array {
  const durationMs = options.durationMs ?? spokenDurationMs(options.script);
  const frames = Math.max(1, Math.round((SAMPLE_RATE * durationMs) / 1000));
  const bytesPerFrame = (CHANNELS * BITS_PER_SAMPLE) / 8;

  const fmt = new Uint8Array(16);
  const view = new DataView(fmt.buffer);
  view.setUint16(0, 1, true); // PCM
  view.setUint16(2, CHANNELS, true);
  view.setUint32(4, SAMPLE_RATE, true);
  view.setUint32(8, SAMPLE_RATE * bytesPerFrame, true);
  view.setUint16(12, bytesPerFrame, true);
  view.setUint16(14, BITS_PER_SAMPLE, true);

  const info = concat([
    ascii('INFO'),
    chunk('INAM', ascii(options.title ?? 'Melete episode')),
    chunk('ICMT', ascii(options.script)),
    chunk('ISFT', ascii('melete-fake-tts/1')),
  ]);

  const body = concat([
    ascii('WAVE'),
    chunk('fmt ', fmt),
    chunk('LIST', info),
    chunk('data', new Uint8Array(frames * bytesPerFrame)),
  ]);

  const file = new Uint8Array(8 + body.length);
  file.set(ascii('RIFF'), 0);
  new DataView(file.buffer).setUint32(4, body.length, true);
  file.set(body, 8);
  return file;
}

/**
 * Read the script back out of a WAV's LIST/INFO comment. Returns null when the
 * file is not a WAV or carries no comment, which is the honest answer for a
 * file some other tool produced.
 */
export function scriptFromWav(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false });
  if (text.decode(bytes.subarray(0, 4)) !== 'RIFF') return null;
  if (text.decode(bytes.subarray(8, 12)) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = text.decode(bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'LIST' && text.decode(bytes.subarray(body, body + 4)) === 'INFO') {
      let inner = body + 4;
      while (inner + 8 <= body + size) {
        const innerId = text.decode(bytes.subarray(inner, inner + 4));
        const innerSize = view.getUint32(inner + 4, true);
        if (innerId === 'ICMT')
          return text.decode(bytes.subarray(inner + 8, inner + 8 + innerSize));
        inner += 8 + innerSize + (innerSize % 2);
      }
    }
    at = body + size + (size % 2);
  }
  return null;
}

export const WAV_MIME = 'audio/wav';
