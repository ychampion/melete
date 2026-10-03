/**
 * Keeps an account's secret out of what the computer reads back.
 *
 * Works on bytes, not text, so a binary answer (a git pack, an archive) passes
 * through unchanged unless it holds the secret, and a secret split across two
 * chunks is still found: the last few bytes of each chunk wait for the next.
 * Every occurrence becomes `[redacted]`. The relay asks upstream for an
 * uncompressed answer, so a compressed copy of the secret cannot slip past.
 */
const MARK = Buffer.from('[redacted]');

export class ByteRedactor {
  private readonly secrets: Buffer[];
  private readonly keep: number;
  private pending: Buffer = Buffer.alloc(0);

  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter((secret) => secret.length > 0))].map((secret) =>
      Buffer.from(secret, 'utf8'),
    );
    this.keep = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  /** The bytes that are safe to pass on now. */
  feed(chunk: Uint8Array): Buffer {
    if (!this.secrets.length) return Buffer.from(chunk);
    const joined = Buffer.concat([this.pending, chunk]);
    const { output, rest } = this.scan(joined, false);
    this.pending = rest;
    return output;
  }

  /** What was held back, once the answer is over. */
  end(): Buffer {
    const { output } = this.scan(this.pending, true);
    this.pending = Buffer.alloc(0);
    return output;
  }

  /** Redacts a whole value at once: a header, a message. */
  text(value: string): string {
    if (!this.secrets.length) return value;
    return this.scan(Buffer.from(value, 'utf8'), true).output.toString('utf8');
  }

  private scan(input: Buffer, final: boolean): { output: Buffer; rest: Buffer } {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      let found = -1;
      let length = 0;
      for (const secret of this.secrets) {
        const at = input.indexOf(secret, offset);
        if (at >= 0 && (found < 0 || at < found || (at === found && secret.length > length))) {
          found = at;
          length = secret.length;
        }
      }
      if (found < 0) break;
      parts.push(input.subarray(offset, found), MARK);
      offset = found + length;
    }
    // Bytes that could be the start of a secret wait for the next chunk.
    const safe = final ? input.length : Math.max(offset, input.length - this.keep);
    parts.push(input.subarray(offset, safe));
    return { output: Buffer.concat(parts), rest: Buffer.from(input.subarray(safe)) };
  }
}
