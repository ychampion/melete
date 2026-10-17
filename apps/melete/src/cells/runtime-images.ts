/**
 * The images the configured runtime name has stood for, as the Melete service
 * was told when it looked the name up through this cell service.
 *
 * The Melete service resolves the runtime image's name once, when it starts,
 * and starts every attempt cell from the image id it got. The name may move
 * afterwards: any pull of it on the engine moves it, such as another
 * installation on the same engine updating. The policy accepts an attempt cell
 * from any image recorded here, so a moved name cannot refuse a running
 * service's engines; the service takes the new image when it next starts.
 *
 * The record is kept in a file in this service's own volume, so a restart of
 * the cell service alone still accepts the image a running Melete service
 * holds. It keeps the newest few ids, and starts afresh when the configured
 * name changes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

/** What the policy reads: whether the configured name has stood for this image here. */
export type SeenImages = {
  has(id: string): boolean;
  /** Records that the configured name stands for `id` now. */
  add(id: string): Promise<void>;
};

export class RuntimeImages implements SeenImages {
  private ids: string[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    /** The configured runtime image name (MELETE_RUNTIME_IMAGE). */
    private readonly reference: string,
    /** Where the record is kept; in memory only when left out. */
    private readonly file?: string,
    private readonly keep = 8,
  ) {
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const saved = JSON.parse(text) as { reference?: unknown; ids?: unknown };
      if (saved.reference !== reference || !Array.isArray(saved.ids)) return;
      this.ids = saved.ids
        .filter((id): id is string => typeof id === 'string' && IMAGE_ID.test(id))
        .slice(-keep);
    } catch {
      process.stderr.write(`cells: ${file} is not a record of runtime images; starting afresh\n`);
    }
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  add(id: string): Promise<void> {
    if (!IMAGE_ID.test(id)) return Promise.resolve();
    if (this.ids.at(-1) === id) return this.writing;
    this.ids = [...this.ids.filter((seen) => seen !== id), id].slice(-this.keep);
    const file = this.file;
    if (!file) return Promise.resolve();
    const record = `${JSON.stringify({ reference: this.reference, ids: this.ids })}\n`;
    // One write at a time, each the whole record; a rename makes it whole on disk.
    this.writing = this.writing.then(() => {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, record, { mode: 0o644 });
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        process.stderr.write(
          `cells: the runtime images seen could not be saved (${error instanceof Error ? error.message : String(error)}); a restart of this service will accept only the image the name stands for then\n`,
        );
      }
    });
    return this.writing;
  }
}
