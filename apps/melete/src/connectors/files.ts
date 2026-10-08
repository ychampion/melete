import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  type Action,
  ARTIFACT_MIME,
  artifactExpectation,
  artifactKindForPath,
  type ConnectorManifest,
  type JsonValue,
  type Receipt,
  type VerifyResult,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { validateArtifact } from '../artifact/validate.ts';
import { extractBounded, ReadersBusy } from '../attachments/bounded.ts';
import { looksLike, UnreadableFile } from '../attachments/extract.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { LEGACY_SCREEN_PATH } from '../devices/screen-paths.ts';
import { noLinks, segmentsFor } from '../paths.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { ConnectorFaultError } from './faults.ts';
import { beneath, loadFileRecords, personGivenReason } from './files-ownership.ts';
import {
  DEFAULT_TRASH_DAYS,
  filesTrash,
  hasTrash,
  latestTrash,
  moveToTrash,
  restoreFromTrash,
  type TrashPlace,
} from './files-trash.ts';
import type { Connector, ConnectorContext } from './types.ts';
import type { PrivateContext } from './web.ts';

type Area = 'work' | 'artifacts';
type FilesOptions = {
  workRoot: string;
  spacesRoot: string;
  maxBytes?: number;
  /** How many days a delete stays in the trash, restorable (`MELETE_TRASH_DAYS`). */
  trashDays?: number;
  /** The most one conversation's trash holds, in bytes (`MELETE_TRASH_MAX_MB`). */
  trashMaxBytes?: number;
  /** Where saved files are recorded, so other conversations' files can be found. */
  sql?: Sql;
  /**
   * Whether a space or agent is private. A file saved where the person spoke
   * privately is offered to no other conversation unless that one is private
   * too; without this check, no other conversation's file is offered.
   */
  privateContext?: PrivateContext;
  /** The files people sent in chat, which `files.save_attachment` copies into a job's workspace. */
  attachments?: SentFiles;
};

/** Where a chat's sent files are read from: only this job's own, or its conversation's. */
export type SentFiles = {
  forJob(jobId: string, id: string): Promise<{ name: string; bytes: Uint8Array } | null>;
};

/**
 * The folder in the artifacts area that lists what was saved in the person's
 * other conversations in this space. It is read from the records, not from a
 * directory, and each file is `from-chats/<record id>/<name>`.
 */
export const FROM_CHATS = 'from-chats';
const FROM_CHATS_LIMIT = 100;
const RECORD_ID = /^(art|act)_[A-Za-z0-9]+$/;

/** A file saved in another conversation, as `files.list` shows it. */
type SavedElsewhere = {
  id: string;
  name: string;
  chat: string;
  savedAt: string;
  /** Where its bytes are: a job's workspace or the space's artifacts folder. */
  jobId: string | null;
  area: Area;
  path: string;
};
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const PICTURE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif|ico)$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** What a read hands back: the words, or why there are none. */
export type FileContent = {
  /** The file as text, or the words read from a PDF, Word document or spreadsheet; null for any other binary file. */
  content: string | null;
  /** Set when the words were read out of a document rather than the file being text. */
  format?: 'pdf' | 'docx' | 'xlsx';
  /** Pages in a PDF, sheets in a spreadsheet. */
  pages?: number | null;
  /** A sentence for the agent when there are no words to give. */
  note?: string;
};

/**
 * What a read hands back. A text file is given as it is. A PDF gives its text
 * page by page, a Word document its paragraphs and a spreadsheet each sheet as
 * CSV. Any other file with a NUL byte or bytes that are not UTF-8 is a picture
 * or another binary: the read succeeds with no content and a sentence saying
 * so, so the agent hears why at once instead of waiting on a read that cannot
 * give it anything.
 */
export async function readableContent(content: Buffer, relative: string): Promise<FileContent> {
  // A PDF can be all ASCII; its header, or its name with the header near the top, says what it is.
  const pdf =
    content.subarray(0, 5).toString('latin1') === '%PDF-' ||
    (/\.pdf$/i.test(relative) && looksLike('pdf', content));
  if (!pdf && !content.includes(0)) {
    try {
      return { content: UTF8.decode(content) };
    } catch {
      // Not UTF-8: one of the documents below, or a binary file.
    }
  }
  const name = JSON.stringify(relative);
  const unreadable = (what: string): FileContent => ({
    content: null,
    note: `${name} is ${what}, and no text could be read from it.`,
  });
  // Documents are read in a child process with a deadline and a memory ceiling,
  // as uploads are: a file the agent fetched is no more trusted than one sent.
  const format: 'pdf' | 'docx' | 'xlsx' | null =
    pdf || looksLike('pdf', content)
      ? 'pdf'
      : looksLike('docx', content) && /\.docx$/i.test(relative)
        ? 'docx'
        : looksLike('xlsx', content) && /\.xlsx$/i.test(relative)
          ? 'xlsx'
          : null;
  if (format) {
    let read: { text: string | null; pages: number | null };
    try {
      read = await extractBounded(format, content);
    } catch (error) {
      if (error instanceof ReadersBusy) return { content: null, format, note: error.message };
      if (!(error instanceof UnreadableFile)) throw error;
      return unreadable(`a document Melete could not read (${error.message})`);
    }
    if (format === 'pdf' && read.text === null)
      return {
        content: null,
        format,
        pages: read.pages,
        note: `${name} is a PDF with no text to read; its pages may be scanned pictures.`,
      };
    return {
      content: read.text ?? '',
      format,
      ...(format === 'docx' ? {} : { pages: read.pages }),
    };
  }
  const what = PICTURE.test(relative) ? 'a picture' : 'a binary file';
  return {
    content: null,
    note: `${name} is ${what} of ${content.byteLength} bytes. files.read gives text, and the words in PDFs, Word documents and spreadsheets; work with this file another way, such as code on your computer.`,
  };
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function areaFor(value: JsonValue | undefined): Area {
  if (value === undefined || value === 'work') return 'work';
  if (value === 'artifacts') return value;
  throw new Error('area must be work or artifacts');
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * The path check each open here begins with. It names a link or a file in the
 * way plainly, but it only reads names: what the open after it reaches is
 * decided by that open. Held in an object so a test can change the tree
 * between this check and the open.
 */
export { noLinks, segmentsFor };
export const pathCheck = { noLinks };

/**
 * Where an open file or directory really is, read from its own descriptor in
 * one lookup. Null where the system offers no such view (anything but Linux,
 * or no /proc); callers then fall back to checking the path.
 */
export async function descriptorPath(file: FileHandle): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    return await readlink(`/proc/self/fd/${file.fd}`);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export type PathLookups = {
  descriptor: (file: FileHandle) => Promise<string | null>;
  realpath: (target: string) => Promise<string>;
  lstat: typeof lstat;
};
const pathLookups: PathLookups = { descriptor: descriptorPath, realpath, lstat };

/**
 * Confirm that a file opened for writing is the one ordinary file at `target`,
 * before a byte of it changes. `noLinks` checks each component before the
 * open; a directory swapped for a link between that check and the open still
 * lands the open elsewhere. Where the descriptor can say where the file is,
 * that one answer decides; looking the path up again could be raced back and
 * forth. A second name for a file elsewhere is refused the same way.
 */
export async function openedAt(
  file: FileHandle,
  target: string,
  lookups: PathLookups = pathLookups,
): Promise<void> {
  const opened = await file.stat();
  if (!opened.isFile()) throw new Error('write target is not a regular file');
  if (opened.nlink !== 1) throw new Error('write target has more than one name');
  const where = await lookups.descriptor(file);
  if (where !== null && where !== target)
    throw new Error('write target is not where it was opened');
  if ((await lookups.realpath(target)) !== target)
    throw new Error('symbolic links are not allowed');
  const named = await lookups.lstat(target);
  if (named.dev !== opened.dev || named.ino !== opened.ino)
    throw new Error('write target changed while it was opened');
}

/**
 * Hold a checked directory open, and name entries in it through its
 * descriptor, so a parent swapped for a link after the check changes nothing:
 * every later open, rename or create lands in the directory that was checked.
 * Where the system has no descriptor paths, entries are named by path.
 */
export async function pinDirectory(
  directory: string,
): Promise<{ at: (name: string) => string; close: () => Promise<void> }> {
  const byPath = (name: string) => path.join(directory, name);
  if (process.platform !== 'linux') return { at: byPath, close: async () => {} };
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const where = await descriptorPath(handle);
    if (where === null) return { at: byPath, close: () => handle.close() };
    if (where !== directory) throw new Error('symbolic links are not allowed');
    return { at: (name) => `/proc/self/fd/${handle.fd}/${name}`, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Opening never waits: a pipe planted at a name fails or is refused as not a regular file. */
export const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const codeOf = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error ? String(error.code) : undefined;

/** A refused open said in words: a link, or a file where a folder must be. */
async function refusedOpen(error: unknown, at: string): Promise<unknown> {
  const code = codeOf(error);
  if (code !== 'ELOOP' && code !== 'ENOTDIR') return error;
  const entry = await lstat(at).catch(() => null);
  if (code === 'ELOOP' || entry?.isSymbolicLink())
    return new Error('symbolic links are not allowed');
  return new Error('not a directory');
}

/** A directory held open by `holdBeneath` or `holdWithin`. */
export type HeldDirectory = {
  /** Its path, as built from the base and the names walked. */
  path: string;
  /** A name for the held directory itself, for listing it. */
  self: string;
  /** A name for an entry in the held directory, wherever that directory is now. */
  at: (name: string) => string;
  /**
   * True when the directory is held by an open descriptor. False where the
   * system has no descriptor paths, and entries are named by path.
   */
  pinned: boolean;
  close: () => Promise<void>;
};

/**
 * One name inside a directory: never empty, `.` or `..`, and never more than
 * one name. The walk enforces this itself, whatever its caller checked.
 */
function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw new Error('path traversal or device path is not allowed');
}

function heldBy(handle: FileHandle, at: string): HeldDirectory {
  const self = `/proc/self/fd/${handle.fd}`;
  return {
    path: at,
    self,
    at: (name) => `${self}/${name}`,
    pinned: true,
    close: () => handle.close(),
  };
}

function heldByPath(at: string): HeldDirectory {
  return {
    path: at,
    self: at,
    at: (name) => path.join(at, name),
    pinned: false,
    close: async () => {},
  };
}

/** Hold a trusted directory, by descriptor where the system can name one. */
async function holdRoot(base: string): Promise<HeldDirectory> {
  if (process.platform === 'linux') {
    const handle = await open(base, DIRECTORY_FLAGS);
    try {
      if ((await descriptorPath(handle)) !== null) return heldBy(handle, base);
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
  }
  if (!(await lstat(base)).isDirectory()) throw new Error('not a directory');
  return heldByPath(base);
}

/**
 * Hold the directory `name` inside a held one: opened inside it, never
 * through a link, and made there first when missing and `create` is set.
 * The parent stays held; close both.
 */
export async function holdWithin(
  parent: HeldDirectory,
  name: string,
  create = false,
): Promise<HeldDirectory> {
  checkName(name);
  const at = parent.at(name);
  const where = path.join(parent.path, name);
  if (parent.pinned) {
    try {
      return heldBy(await open(at, DIRECTORY_FLAGS), where);
    } catch (error) {
      if (!create || !missing(error)) throw await refusedOpen(error, at);
      // Made inside the held parent; a link already at the name is never followed.
      await mkdir(at).catch((made: unknown) => {
        if (codeOf(made) !== 'EEXIST') throw made;
      });
      return holdWithin(parent, name, false);
    }
  }
  let stat = await lstat(at).catch((error: unknown) => {
    if (create && missing(error)) return null;
    throw error;
  });
  if (!stat) {
    await mkdir(at).catch((error: unknown) => {
      if (codeOf(error) !== 'EEXIST') throw error;
    });
    stat = await lstat(at);
  }
  if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed');
  if (!stat.isDirectory()) throw new Error('not a directory');
  return heldByPath(where);
}

/**
 * Walk from a trusted `base` one name at a time, each opened inside the
 * directory before it and never through a link, and hold the last one open.
 * Nothing done to the tree after a name is walked changes where the walk
 * goes, so this, not a check of the path beforehand, is what decides where
 * an open lands. Missing folders are made on the way when `create` is set,
 * each inside the held directory before it.
 *
 * Where the system has no descriptor paths (anything but Linux), the walk is
 * by path and each name is checked as it is reached; `openIn` then checks the
 * open against the path again.
 */
export async function holdBeneath(
  base: string,
  segments: string[],
  create = false,
): Promise<HeldDirectory> {
  for (const segment of segments) checkName(segment);
  let held = await holdRoot(base);
  try {
    for (const segment of segments) {
      const next = await holdWithin(held, segment, create);
      await held.close();
      held = next;
    }
    return held;
  } catch (error) {
    await held.close();
    throw error;
  }
}

/**
 * Open the entry `name` in a held directory without following a link. Where
 * the directory is named by path, the open must still be the file now at that
 * path. A file that is missing fails with ENOENT, as a plain open would.
 */
export async function openIn(
  directory: HeldDirectory,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  checkName(name);
  const at = directory.at(name);
  const file = await open(at, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode).catch(
    async (error: unknown) => {
      throw await refusedOpen(error, at);
    },
  );
  if (!directory.pinned) {
    try {
      const [opened, named, real] = await Promise.all([file.stat(), lstat(at), realpath(at)]);
      if (real !== at || named.dev !== opened.dev || named.ino !== opened.ino)
        throw new Error('symbolic links are not allowed');
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  return file;
}

/** Open the file at `base/...segments` the way `holdBeneath` walks and `openIn` opens. */
export async function openBeneath(
  base: string,
  segments: string[],
  flags: number,
  options: { mode?: number; create?: boolean } = {},
): Promise<FileHandle> {
  const name = segments.at(-1);
  if (!name) throw new Error('path names no file');
  const directory = await holdBeneath(base, segments.slice(0, -1), options.create ?? false);
  try {
    return await openIn(directory, name, flags, options.mode);
  } finally {
    await directory.close();
  }
}

/**
 * Directories under a trusted `base`, each held once while entries in it are
 * opened, for going through many files in path order: only the folders on the
 * way to the current one stay open, and each is walked as `holdBeneath` walks.
 */
export function heldDirectories(base: string, create = false) {
  const chain: { name: string; held: HeldDirectory }[] = [];
  let root: HeldDirectory | null = null;
  const closeFrom = async (depth: number) => {
    while (chain.length > depth) await chain.pop()?.held.close();
  };
  return {
    /** The held directory at `base/...segments`. Valid until the next call or `close`. */
    async at(segments: string[]): Promise<HeldDirectory> {
      root ??= await holdRoot(base);
      let depth = 0;
      while (depth < chain.length && chain[depth]?.name === segments[depth]) depth += 1;
      await closeFrom(depth);
      for (const name of segments.slice(depth)) {
        const parent = chain.at(-1)?.held ?? root;
        chain.push({ name, held: await holdWithin(parent, name, create) });
      }
      return chain.at(-1)?.held ?? root;
    },
    async close() {
      await closeFrom(0);
      await root?.close();
      root = null;
    },
  };
}

const pathSchema = { type: 'string', minLength: 1 };
const areaSchema = { type: 'string', enum: ['work', 'artifacts'] };
/**
 * What a write says the file is meant to be. Declaring nothing is the normal
 * case and writes a scratch file; declaring something makes the file an
 * artifact, and the checks below are run over the bytes before the receipt is
 * returned. The shape is deliberately loose at the schema layer and strict at
 * the parse: `artifactExpectation` is the authority and a payload it refuses
 * fails the write rather than being recorded half-understood.
 */
const expectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: ['markdown', 'csv', 'json', 'text', 'html', 'image', 'pdf', 'docx', 'xlsx', 'binary'],
    },
    checks: { type: 'array', maxItems: 25, items: { type: 'object', additionalProperties: true } },
    render: { type: 'boolean' },
    critique: { type: ['string', 'null'], maxLength: 2000 },
    template: { type: ['string', 'null'], maxLength: 200 },
  },
};
const evidenceSchema = {
  type: 'array',
  maxItems: 50,
  items: { type: 'string', minLength: 1, maxLength: 200 },
};
const inputSchema = (properties: Record<string, JsonValue>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const filesManifest: ConnectorManifest = {
  name: 'files',
  version: '0.1.0',
  provider: 'files',
  description: 'Files confined to the current job workspace and space artifacts.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'files.list',
      description:
        'List one directory; use path . for its root. In area artifacts, from-chats holds files saved in your other conversations; read one with files.read at the path listed.',
      input_schema: inputSchema({ path: pathSchema, area: areaSchema }, ['path']),
      effect_class: 'read',
      required_scopes: ['files.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'files.read',
      description:
        'Read a text file and its content hash; for a PDF, Word document or spreadsheet, the words in it (PDF pages are marked). Other binary files give a note instead of content.',
      input_schema: inputSchema({ path: pathSchema, area: areaSchema }, ['path']),
      effect_class: 'read',
      required_scopes: ['files.read'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'files.write',
      description:
        'Write a UTF-8 file, only when the person asks for a file or the work is a document to keep. Answers, drafts, tables and plans go in the reply instead. Declare expect to make it a checked deliverable.',
      input_schema: inputSchema(
        {
          path: pathSchema,
          area: areaSchema,
          content: { type: 'string' },
          expect: expectSchema,
          evidence: evidenceSchema,
        },
        ['path', 'content'],
      ),
      effect_class: 'write_reversible',
      required_scopes: ['files.write'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'files.move',
      description:
        'Move a file to an unused path. Include content_hash to verify a lost acknowledgement.',
      input_schema: inputSchema(
        {
          from: pathSchema,
          to: pathSchema,
          area: areaSchema,
          to_area: areaSchema,
          content_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
        ['from', 'to'],
      ),
      effect_class: 'write_reversible',
      required_scopes: ['files.move'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'files.delete',
      description:
        "Delete a file or folder into the trash, restorable for days with files.restore. What you made in this conversation goes at once; the person's own files (in their Files, or ones they gave you) ask them first.",
      input_schema: inputSchema(
        {
          path: pathSchema,
          area: areaSchema,
          checked: {
            type: 'object',
            additionalProperties: true,
            description: 'Filled in by Melete; leave it out.',
          },
        },
        ['path'],
      ),
      effect_class: 'write_reversible',
      required_scopes: ['files.delete'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'files.restore',
      description:
        "Restore what a delete put in the trash: give the trash_id from its receipt, or a path to restore the latest delete that took it; with neither, this conversation's latest delete comes back. Files go back to their own paths, never over a file that took the path since.",
      input_schema: inputSchema(
        {
          trash_id: { type: 'string', pattern: '^del_[0-9]{13}_[0-9a-f]{12}$' },
          path: pathSchema,
        },
        [],
      ),
      effect_class: 'write_reversible',
      required_scopes: ['files.restore'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'files.save_attachment',
      description:
        'Save a file the person attached in this chat into your workspace, to work on it with code. attachment_id is its file_ id; path must be unused.',
      input_schema: inputSchema(
        {
          attachment_id: { type: 'string', pattern: '^file_[A-Za-z0-9]{1,64}$' },
          path: pathSchema,
        },
        ['attachment_id', 'path'],
      ),
      effect_class: 'write_reversible',
      required_scopes: ['files.write'],
      verify: true,
      requires_approval: false,
    },
  ],
};

/**
 * Move a file to a name that must be unused. A second name is made first, so
 * a file that appeared at the destination meanwhile is never replaced; where
 * the system will not make one (another owner's file, another filesystem),
 * the name is checked and the file renamed.
 */
export async function moveWithoutReplacing(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'EEXIST') throw new Error('move destination already exists');
    if (code !== 'EPERM' && code !== 'EXDEV' && code !== 'ENOTSUP' && code !== 'EMLINK')
      throw error;
    try {
      await lstat(to);
      throw new Error('move destination already exists');
    } catch (absent) {
      if (!missing(absent)) throw absent;
    }
    await rename(from, to);
    return;
  }
  await unlink(from).catch(async (error: unknown) => {
    if (missing(error)) return;
    await unlink(to).catch(() => {});
    throw error;
  });
}

/** Give a file the agent's computer must read the modes a synchronised file has (0644 or 0755). */
async function readableToAgent(directory: HeldDirectory, name: string): Promise<void> {
  const file = await openIn(directory, name, constants.O_RDONLY);
  try {
    const stat = await file.stat();
    // Only the service's own files need it, and only those it may change.
    if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o044) !== 0o044)
      await file.chmod((stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
  } finally {
    await file.close();
  }
}

/** A file of a job: the trusted root, the names under it, and the path they make. */
type Located = { base: string; segments: string[]; target: string };

/** How many names a delete's card and receipt list; the count says the rest. */
const NAMED = 20;
/** The most entries one `files.delete` takes: a bigger folder is deleted in parts. */
export const DELETE_ENTRIES = 2000;
/** Files up to this size are named by their content in a delete's check; larger ones by size and time. */
const HASHED_BYTES = 16 * 1024 * 1024;

/** What a delete would take, as it stands: bound before anyone is asked, compared before it goes. */
export type DeleteTarget = {
  what: 'file' | 'folder';
  files: number;
  bytes: number;
  /** One hash of everything it would take, so any change since it was decided shows. */
  state: string;
  /** For a file, its content hash (null when it is too large to read for this). */
  content_hash: string | null;
  /** Each entry it takes, relative to it ('' for a file itself), with its content hash where read. */
  items: { path: string; hash: string | null }[];
  /** Each folder inside it, relative to it, deepest last. */
  folders: string[];
};

/** One file's part of a delete's state, read through a held directory without following a link. */
async function fileState(directory: HeldDirectory, name: string) {
  const file = await openIn(directory, name, READ_FLAGS);
  try {
    const stat = await file.stat();
    const hash = stat.isFile() && stat.size <= HASHED_BYTES ? digest(await file.readFile()) : null;
    return { size: stat.size, hash, line: hash ?? `${stat.size}:${stat.mtimeMs}` };
  } finally {
    await file.close();
  }
}

/**
 * What deleting `name` in a held directory would take. A link is never
 * followed: deleting one removes the link. A folder is walked through held
 * directories, as every other walk here is.
 */
async function inspectEntry(directory: HeldDirectory, name: string): Promise<DeleteTarget> {
  const at = directory.at(name);
  const stat = await lstat(at);
  if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed');
  if (stat.isFile()) {
    const state = await fileState(directory, name);
    return {
      what: 'file',
      files: 1,
      bytes: state.size,
      state: digest(`file\0${state.size}\0${state.line}`),
      content_hash: state.hash,
      items: [{ path: '', hash: state.hash }],
      folders: [],
    };
  }
  if (!stat.isDirectory()) throw new Error('only a file or a folder can be deleted');
  const lines: string[] = [];
  const items: DeleteTarget['items'] = [];
  const folders: string[] = [];
  let files = 0;
  let bytes = 0;
  const visit = async (held: HeldDirectory, prefix: string) => {
    const entries = await readdir(held.self);
    entries.sort();
    for (const entry of entries) {
      if (lines.length >= DELETE_ENTRIES)
        throw new Error(
          `that folder holds more than ${DELETE_ENTRIES} entries; delete the folders inside it one at a time`,
        );
      const relative = `${prefix}${entry}`;
      const found = await lstat(held.at(entry));
      if (found.isDirectory() && !found.isSymbolicLink()) {
        lines.push(`${relative}/`);
        folders.push(relative);
        const inner = await holdWithin(held, entry);
        try {
          await visit(inner, `${relative}/`);
        } finally {
          await inner.close();
        }
      } else if (found.isFile()) {
        const state = await fileState(held, entry);
        files += 1;
        bytes += state.size;
        lines.push(`${relative}\0${state.size}\0${state.line}`);
        items.push({ path: relative, hash: state.hash });
      } else {
        lines.push(`${relative}\0other`);
        items.push({ path: relative, hash: null });
      }
    }
  };
  const folder = await holdWithin(directory, name);
  try {
    await visit(folder, '');
  } finally {
    await folder.close();
  }
  return {
    what: 'folder',
    files,
    bytes,
    state: digest(`folder\0${lines.join('\n')}`),
    content_hash: null,
    items,
    folders,
  };
}

/**
 * Remove `name` from a held directory: a file or link unlinked, a folder
 * emptied through held directories and then removed. Nothing is followed
 * through a link, so nothing outside the directory is touched.
 */
export async function removeIn(directory: HeldDirectory, name: string): Promise<void> {
  checkName(name);
  const at = directory.at(name);
  const stat = await lstat(at);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await unlink(at);
    return;
  }
  const inner = await holdWithin(directory, name);
  try {
    for (const entry of await readdir(inner.self)) await removeIn(inner, entry);
  } finally {
    await inner.close();
  }
  await rmdir(at);
}

export function createFilesConnector(options: FilesOptions): Connector {
  const limit = options.maxBytes ?? 2 * 1024 * 1024;
  const workspace = new LocalWorkspaceFs(options.workRoot);
  /**
   * Where a file of the job is: the trusted root and the names under it. The
   * path check here only names a problem early; every open walks the names
   * itself (`openBeneath`), so a change made after this check lands nowhere.
   */
  const resolveFile = async (ctx: ConnectorContext, area: Area, relative: string) => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id) || !/^sp_[A-Za-z0-9]+$/.test(ctx.space_id)) {
      throw new Error('invalid trusted file scope');
    }
    const segments = segmentsFor(relative);
    // A paired computer's screenshot an earlier version left here is not the
    // agent's to open, whatever that computer allows (devices/screen-paths.ts).
    if (area === 'work' && LEGACY_SCREEN_PATH.test(segments.join('/')))
      throw new Error("that is a paired computer's screenshot, which is not a file you can open");
    const { base, segments: names } =
      area === 'work'
        ? await workspace.location(ctx.job_id, segments, true)
        : {
            base: await realpath(options.spacesRoot),
            segments: [ctx.space_id, 'artifacts', ...segments],
          };
    return { base, segments: names, target: await pathCheck.noLinks(base, names, false) };
  };
  const readHandle = async (file: FileHandle): Promise<Buffer> => {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new Error('file is not regular or exceeds the read limit');
      const content = await file.readFile();
      if (content.byteLength > limit) throw new Error('file exceeds the read limit');
      return content;
    } finally {
      await file.close();
    }
  };
  const read = async (located: Located): Promise<Buffer> =>
    readHandle(await openBeneath(located.base, located.segments, READ_FLAGS));
  /** A file in a held directory, which the open does not follow if it is a link. */
  const readOpened = async (directory: HeldDirectory, name: string): Promise<Buffer> =>
    readHandle(await openIn(directory, name, READ_FLAGS));
  /** One folder's entries, listed through the folder the walk holds open. */
  const listFolder = async (located: Located) => {
    const folder = await holdBeneath(located.base, located.segments);
    try {
      return await readdir(folder.self, { withFileTypes: true });
    } finally {
      await folder.close();
    }
  };
  /**
   * A new file in a held directory (`HeldDirectory.at`) holding exactly
   * `content`. Nothing else has a name or a handle for it. A name already
   * taken refuses the write and is left alone.
   */
  const createWith = async (at: string, target: string, content: Buffer) => {
    const file = await open(
      at,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    ).catch((error: unknown) => {
      if (codeOf(error) === 'EEXIST') throw new Error('move destination already exists');
      throw error;
    });
    try {
      await openedAt(file, target);
      await file.writeFile(content);
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(at).catch(() => {});
      throw error;
    }
    await file.close();
  };
  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    hash: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: hash,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });
  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key
    )
      throw new Error('connector action identity mismatch');
  };

  /** A file sent in this job's chat, by its id; refused plainly when there is none. */
  const sentFile = async (ctx: ConnectorContext, id: string) => {
    if (!/^file_[A-Za-z0-9]{1,64}$/.test(id))
      throw new Error('attachment_id must be the file_ id of a file attached in this chat');
    const sent = await options.attachments?.forJob(ctx.job_id, id);
    if (!sent) throw new Error(`there is no attached file ${id} in this chat`);
    return sent;
  };
  /**
   * A file in a held directory, read only when it is the size the attachment
   * is (at most the upload limit): anything else at the path is some other
   * file, answered as `different` without reading a byte of it.
   */
  const readIfSized = async (
    directory: HeldDirectory,
    name: string,
    size: number,
  ): Promise<Buffer | 'different'> => {
    const file = await openIn(directory, name, READ_FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== size) return 'different';
      return await file.readFile();
    } finally {
      await file.close();
    }
  };
  /** Whether a save whose answer was lost left the attachment at its path. */
  const verifySaved = async (action: Action, ctx: ConnectorContext): Promise<VerifyResult> => {
    const payload = action.canonical_payload;
    let sent: { bytes: Uint8Array };
    try {
      sent = await sentFile(ctx, requiredString(payload, 'attachment_id'));
    } catch {
      return { decision: 'undecided', reason: 'the attachment is no longer there' };
    }
    try {
      const located = await resolveFile(ctx, 'work', requiredString(payload, 'path'));
      const directory = await holdBeneath(located.base, located.segments.slice(0, -1));
      try {
        const read = await readIfSized(directory, path.basename(located.target), sent.bytes.length);
        const there = read === 'different' ? '' : digest(read);
        if (there !== digest(Buffer.from(sent.bytes)))
          return { decision: 'undecided', reason: 'the file at the path is not the attachment' };
        const evidence = {
          path: requiredString(payload, 'path'),
          area: 'work',
          content_hash: there,
        };
        return { decision: 'succeeded', evidence, receipt: receiptFor(action, evidence, there) };
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (missing(error)) return { decision: 'undecided', reason: 'no file was saved there' };
      return { decision: 'undecided', reason: 'the saved file could not be checked' };
    }
  };

  /** Whether a delete whose answer was lost left nothing at its path. */
  const verifyDeleted = async (action: Action, ctx: ConnectorContext): Promise<VerifyResult> => {
    const payload = action.canonical_payload;
    const relative = requiredString(payload, 'path');
    const area = areaFor(payload.area);
    try {
      const located = await resolveFile(ctx, area, relative);
      const folder = await holdBeneath(located.base, located.segments.slice(0, -1));
      try {
        await lstat(folder.at(path.basename(located.target)));
      } finally {
        await folder.close();
      }
      return { decision: 'undecided', reason: 'it is still there' };
    } catch (error) {
      if (!missing(error)) return { decision: 'undecided', reason: 'it could not be checked' };
    }
    const evidence = { path: relative, area, deleted: true };
    const state = action.canonical_payload.checked;
    const bound =
      state && typeof state === 'object' && !Array.isArray(state) ? state.state : undefined;
    return {
      decision: 'succeeded',
      evidence,
      receipt: receiptFor(action, evidence, typeof bound === 'string' ? bound : null),
    };
  };

  /**
   * Files saved in the person's other conversations in this space: declared
   * artifacts and plain file writes. A job's files follow the job, so only
   * conversations of the same person are listed, as the artifacts route
   * allows; a file recorded without a job belongs to the space.
   */
  const savedElsewhere = async (ctx: ConnectorContext): Promise<SavedElsewhere[]> => {
    const sql = options.sql;
    if (!sql) return [];
    // A fresh fragment for each query: one fragment is not shared between two.
    const mine = () => sql`coalesce(j.principal_id, (select id from owner limit 1)) =
      (select coalesce(c.principal_id, (select id from owner limit 1)) from job c where c.id = ${ctx.job_id})`;
    const artifacts = await sql`select a.id, a.area, a.path, a.job_id, a.source_job_id,
        a.created_at, j.title
      from artifact a left join job j on j.id = a.job_id
      where a.space_id = ${ctx.space_id} and a.job_id is distinct from ${ctx.job_id}
        and (a.job_id is null or (j.space_id = ${ctx.space_id} and ${mine()}))
        and a.area in ('work', 'artifacts')
      order by a.created_at desc limit ${FROM_CHATS_LIMIT}`;
    const writes = await sql`select x.id, x.job_id, x.canonical_payload, x.resolved_at, j.title
      from action x join job j on j.id = x.job_id
      join connection n on n.id = x.connection_id
      where n.space_id = ${ctx.space_id} and j.space_id = ${ctx.space_id}
        and x.job_id <> ${ctx.job_id} and x.kind = 'files.write' and x.status = 'succeeded'
        and ${mine()}
      order by x.resolved_at desc nulls last limit ${FROM_CHATS_LIMIT}`;
    const found: SavedElsewhere[] = [];
    const seen = new Set<string>();
    const add = (entry: SavedElsewhere) => {
      // One file saved twice, or recorded both as a write and as an artifact, is listed once.
      const key = `${entry.jobId ?? ''}:${entry.area}:${entry.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(entry);
    };
    for (const row of artifacts) {
      const jobId = (row.job_id as string | null) ?? null;
      const path = String(row.path);
      // A recorded file with no job lives in the space's folder, some naming it.
      const relative = jobId === null ? path.replace(/^artifacts\//, '') : path;
      const area: Area = jobId === null || row.area === 'artifacts' ? 'artifacts' : 'work';
      // A job's work file is that job's own, never another job's workspace.
      if (area === 'work' && row.source_job_id !== jobId) continue;
      add({
        id: String(row.id),
        name: relative.split('/').pop() ?? relative,
        chat: String(row.title ?? 'This space'),
        savedAt: new Date(row.created_at as string).toISOString(),
        jobId,
        area,
        path: relative,
      });
    }
    for (const row of writes) {
      const payload = (row.canonical_payload ?? {}) as Record<string, unknown>;
      if (typeof payload.path !== 'string') continue;
      let area: Area;
      try {
        area = areaFor(payload.area as JsonValue | undefined);
      } catch {
        continue;
      }
      add({
        id: String(row.id),
        name: payload.path.split('/').pop() ?? payload.path,
        chat: String(row.title ?? 'Conversation'),
        savedAt: new Date((row.resolved_at as string | null) ?? Date.now()).toISOString(),
        jobId: String(row.job_id),
        area,
        path: payload.path,
      });
    }
    return withoutPrivate(ctx, found);
  };

  /**
   * What was said in a private space or agent, or in a sensitive conversation,
   * stays there: its files are offered to another conversation only when that
   * one is private as well, so they never reach a model the private one would
   * not use. A check that cannot answer counts as private.
   */
  const withoutPrivate = async (
    ctx: ConnectorContext,
    found: SavedElsewhere[],
  ): Promise<SavedElsewhere[]> => {
    const sql = options.sql;
    const privateContext = options.privateContext;
    if (!sql || !privateContext) return [];
    const ids = [...new Set([ctx.job_id, ...found.flatMap((entry) => entry.jobId ?? [])])];
    const rows = await sql`select j.id, j.space_id, coalesce(j.agent_id, p.agent_id) as agent_id,
        coalesce(c.sensitive <> 'none', false) as sensitive
      from job j
      left join job p on p.id = j.experience_parent_id
      left join privacy_conversation c on c.conversation_id = coalesce(j.experience_parent_id, j.id)
      where j.id in ${sql(ids)}`;
    const facts = new Map(rows.map((row) => [String(row.id), row]));
    const isPrivate = async (jobId: string): Promise<boolean> => {
      const row = facts.get(jobId);
      if (!row) return true;
      if (row.sensitive === true) return true;
      return privateContext({
        spaceId: String(row.space_id),
        agentId: row.agent_id ? String(row.agent_id) : null,
        jobId,
      }).catch(() => true);
    };
    if (await isPrivate(ctx.job_id)) return found;
    const kept: SavedElsewhere[] = [];
    for (const entry of found)
      if (entry.jobId === null || !(await isPrivate(entry.jobId))) kept.push(entry);
    return kept;
  };

  /** The bytes of a file saved in another conversation, through the same path rules. */
  const readElsewhere = async (ctx: ConnectorContext, relative: string) => {
    const [, id] = segmentsFor(relative);
    if (!id || !RECORD_ID.test(id))
      throw new Error(`there is no file ${JSON.stringify(relative)} in artifacts`);
    const entry = (await savedElsewhere(ctx)).find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`there is no file ${JSON.stringify(relative)} in artifacts`);
    if (entry.area === 'work' && !/^job_[A-Za-z0-9]+$/.test(entry.jobId ?? ''))
      throw new Error('invalid trusted file scope');
    const { base, segments: names } =
      entry.area === 'work'
        ? await workspace.location(entry.jobId as string, segmentsFor(entry.path))
        : {
            base: await realpath(options.spacesRoot),
            segments: [ctx.space_id, 'artifacts', ...segmentsFor(entry.path)],
          };
    const target = await pathCheck.noLinks(base, names, false);
    const content = await read({ base, segments: names, target }).catch((error: unknown) => {
      if (!missing(error)) throw error;
      throw new Error(`the file ${JSON.stringify(entry.name)} is no longer there`);
    });
    return { entry, content };
  };

  /**
   * A new file in the person's own Files: something they can open and delete,
   * like a new file saved to the space (`artifact.publish`), so it is not asked
   * about. Saving over one of theirs, taking a file out of their Files or
   * renaming one there, and a path that is not a plain name inside them, are.
   */
  const newInPersonFiles = (
    action: Pick<Action, 'kind' | 'canonical_payload'>,
    spaceId: string,
  ) => {
    const payload = action.canonical_payload;
    const into =
      action.kind === 'files.write'
        ? payload.area === 'artifacts'
        : action.kind === 'files.move' &&
          payload.area !== 'artifacts' &&
          (payload.to_area ?? payload.area) === 'artifacts';
    const target = action.kind === 'files.write' ? payload.path : payload.to;
    if (!into || typeof target !== 'string' || !/^sp_[A-Za-z0-9]+$/.test(spaceId)) return false;
    try {
      // A link counts as something already there, wherever it points.
      return (
        lstatSync(path.join(options.spacesRoot, spaceId, 'artifacts', ...segmentsFor(target)), {
          throwIfNoEntry: false,
        }) === undefined
      );
    } catch {
      return false;
    }
  };

  const trashDays = options.trashDays ?? DEFAULT_TRASH_DAYS;
  /** Where an area's trash is, for one job. */
  const trashPlace = async (area: Area, ctx: ConnectorContext, jobId = ctx.job_id) =>
    area === 'work'
      ? workspace.trash(jobId)
      : filesTrash(await realpath(options.spacesRoot), ctx.space_id, jobId);
  /**
   * The trash a restore reaches: this job's own, and, for an undo the person
   * asked for from a receipt, the conversation the receipt came from.
   */
  const restorePlaces = async (ctx: ConnectorContext): Promise<TrashPlace[]> => {
    // Job ids to look in, not a path: each place comes from `trashPlace`.
    const jobs: string[] = [];
    jobs.push(ctx.job_id);
    if (options.sql) {
      const [row] =
        await options.sql`select experience_parent_id from job where id = ${ctx.job_id}`;
      if (row?.experience_parent_id) jobs.push(String(row.experience_parent_id));
    }
    const places: TrashPlace[] = [];
    for (const job of jobs)
      for (const area of ['work', 'artifacts'] as const)
        places.push(await trashPlace(area, ctx, job));
    return places;
  };

  /**
   * What a delete would take and whose it is, checked before anyone is asked
   * and bound into the payload: the card shows it, `asksFirst` reads it, and
   * the delete goes only while what is there is still what was decided.
   */
  const deleteCheck = async (
    ctx: ConnectorContext,
    tx: Query | null,
    payload: Record<string, JsonValue>,
  ): Promise<Record<string, JsonValue>> => {
    const area = areaFor(payload.area);
    const relative = requiredString(payload, 'path');
    const segments = segmentsFor(relative);
    if (segments.length === 0)
      throw new Error(`a whole area cannot be deleted; name a file or folder in ${area}`);
    if (area === 'artifacts' && segments[0] === FROM_CHATS) {
      // A file whose chat is gone is in the person's Files, and is deleted there.
      const entry = RECORD_ID.test(segments[1] ?? '')
        ? (await savedElsewhere(ctx)).find((candidate) => candidate.id === segments[1])
        : undefined;
      if (entry && entry.jobId === null && entry.area === 'artifacts')
        throw new Error(
          `this file is in the person's Files: delete it with area artifacts and path ${JSON.stringify(entry.path)}`,
        );
      throw new Error('a file saved in another conversation is deleted from that conversation');
    }
    if (area === 'work' && segments[0] === '.melete')
      throw new Error(
        "Melete's own records (stored command output and screenshots) are not deleted this way",
      );
    const located = await resolveFile(ctx, area, relative);
    const name = path.basename(located.target);
    let target: DeleteTarget;
    try {
      const directory = await holdBeneath(located.base, located.segments.slice(0, -1));
      try {
        target = await inspectEntry(directory, name);
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (missing(error))
        throw new Error(`there is no file or folder ${JSON.stringify(relative)} in ${area}`);
      throw error;
    }
    const records = tx ? await loadFileRecords(tx, ctx.job_id) : null;
    const joined = segments.join('/');
    let owner: 'agent' | 'person';
    let reason: string;
    let givenCount = 0;
    if (area === 'work') {
      // Records that could not be read decide nothing: the person is asked.
      const given = records
        ? personGivenReason(records, joined)
        : `Melete could not check whose ${JSON.stringify(joined)} is`;
      givenCount = records ? beneath(records.personInWork, joined).length : 0;
      owner = given ? 'person' : 'agent';
      reason = given ? `${given}.` : "It is in this conversation's own workspace.";
    } else {
      const made =
        target.what === 'file' &&
        target.content_hash !== null &&
        records?.madeInFiles.get(joined) === target.content_hash;
      owner = made ? 'agent' : 'person';
      reason = made
        ? 'Melete saved it as a new file in this conversation, and it has not changed since.'
        : "It is in the person's Files.";
    }
    const shown = `“${segments.at(-1)}”`;
    const files = target.files === 1 ? 'its file' : `its ${target.files} files`;
    const what =
      area === 'work' && !records
        ? `${target.what === 'file' ? shown : `the folder ${shown} with ${files}`} from this conversation's workspace`
        : target.what === 'file'
          ? `${shown}${area === 'artifacts' ? ' from your Files' : ', which you gave Melete'}`
          : area === 'artifacts'
            ? `the folder ${shown} from your Files, with ${files}`
            : `the folder ${shown} with ${files}, ${givenCount === 1 ? 'one of which' : `${givenCount} of which`} you gave Melete`;
    const warning = `This deletes ${what}. It can be restored from the trash for ${trashDays} days.`;
    const names = target.items.map((item) => item.path).filter(Boolean);
    return {
      owner,
      what: target.what,
      files: target.files,
      bytes: target.bytes,
      state: target.state,
      ...(target.content_hash ? { content_hash: target.content_hash } : {}),
      ...(target.what === 'folder' ? { names: names.slice(0, NAMED) } : {}),
      reason,
      ...(owner === 'person' ? { warning } : {}),
    };
  };
  /** The delete check of an action, as bound. */
  const checkedOf = (action: Pick<Action, 'canonical_payload'>): Record<string, JsonValue> => {
    const checked = action.canonical_payload.checked;
    return checked && typeof checked === 'object' && !Array.isArray(checked)
      ? (checked as Record<string, JsonValue>)
      : {};
  };

  return {
    manifest: filesManifest,
    staysInSpace: newInPersonFiles,
    /** A delete asks unless its check found it Melete's own. */
    asksFirst: (action) => action.kind === 'files.delete' && checkedOf(action).owner !== 'agent',
    async validateBinding(action, ctx, tx) {
      if (action.kind !== 'files.delete') return;
      const bound = checkedOf(action);
      let now: Record<string, JsonValue>;
      try {
        now = await deleteCheck(ctx, tx, action.canonical_payload);
      } catch (error) {
        throw new BrokerFault('payload_invalid', (error as Error).message);
      }
      if (now.state !== bound.state || (bound.owner === 'agent' && now.owner !== 'agent'))
        throw new BrokerFault(
          'payload_invalid',
          `${JSON.stringify(action.canonical_payload.path)} changed after this delete was decided, so nothing was deleted; ask again to delete it as it is now.`,
        );
    },
    async prepare(payload, ctx, tx, kind) {
      // A restore names the delete it brings back before it runs, so its
      // receipt and any retry are about that one delete.
      if (kind === 'files.restore' && typeof payload.trash_id !== 'string') {
        const path = typeof payload.path === 'string' ? payload.path : undefined;
        let found: { id: string; made: number } | null = null;
        try {
          for (const place of await restorePlaces(ctx)) {
            const latest = await latestTrash(place, path);
            if (latest && (!found || latest.made > found.made)) found = latest;
          }
        } catch (error) {
          throw new BrokerFault('payload_invalid', (error as Error).message);
        }
        if (!found)
          throw new BrokerFault(
            'payload_invalid',
            path
              ? `nothing deleted in this conversation that took ${JSON.stringify(path)} is still in the trash`
              : 'nothing deleted in this conversation is still in the trash',
          );
        return { trash_id: found.id, ...(path ? { path } : {}) };
      }
      if (kind === 'files.delete') {
        try {
          return {
            path: payload.path ?? null,
            ...(payload.area !== undefined ? { area: payload.area } : {}),
            checked: await deleteCheck(ctx, tx, payload),
          };
        } catch (error) {
          throw new BrokerFault('payload_invalid', (error as Error).message);
        }
      }
      if (payload.expect !== undefined) {
        const declaration = artifactExpectation.safeParse(payload.expect);
        if (!declaration.success)
          throw new BrokerFault('payload_invalid', declaration.error.message);
      }
      return payload;
    },
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      const payload = action.canonical_payload;
      const area = areaFor(payload.area);
      // Parsed before anything is created or opened. A declaration this side
      // cannot read is a bad request, and a bad request must not leave a file
      // on disk and an action nobody can decide the disposition of.
      const expectation =
        payload.expect === undefined ? null : artifactExpectation.parse(payload.expect);
      let detail: Record<string, JsonValue>;
      let hash: string | null = null;
      if (action.kind === 'files.save_attachment') {
        const id = requiredString(payload, 'attachment_id');
        const relative = requiredString(payload, 'path');
        const sent = await sentFile(ctx, id);
        const located = await resolveFile(ctx, 'work', relative);
        const bytes = Buffer.from(sent.bytes);
        hash = digest(bytes);
        const directory = await holdBeneath(located.base, located.segments.slice(0, -1), true);
        try {
          const name = path.basename(located.target);
          const there = await readIfSized(directory, name, bytes.length).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          });
          // A retry of this same save finds its own bytes there and is done.
          if (there === null) {
            await createWith(directory.at(name), located.target, bytes).catch((error: unknown) => {
              if (error instanceof Error && error.message === 'move destination already exists')
                throw new Error(`there is already a file at ${JSON.stringify(relative)}`);
              throw error;
            });
            await readableToAgent(directory, name);
          } else if (there === 'different' || digest(there) !== hash)
            throw new Error(`there is already a file at ${JSON.stringify(relative)}`);
          const written = await readIfSized(directory, name, bytes.length);
          if (written === 'different' || digest(written) !== hash)
            throw new ConnectorFaultError({
              kind: 'bad_output',
              detail: 'the file on disk does not match the attachment that was saved',
            });
        } finally {
          await directory.close();
        }
        detail = {
          path: relative,
          area: 'work',
          attachment_id: id,
          name: sent.name,
          bytes: bytes.byteLength,
          content_hash: hash,
        };
      } else if (action.kind === 'files.delete') {
        const relative = requiredString(payload, 'path');
        const checked = checkedOf(action);
        if (typeof checked.state !== 'string')
          throw new Error('this delete was not checked before it was sent; ask for it again');
        const located = await resolveFile(ctx, area, relative);
        const name = path.basename(located.target);
        const absent = (error: unknown) => {
          if (missing(error))
            throw new Error(`there is no file or folder ${JSON.stringify(relative)} in ${area}`);
          throw error;
        };
        const directory = await holdBeneath(located.base, located.segments.slice(0, -1)).catch(
          absent,
        );
        let gone: DeleteTarget;
        try {
          gone = await inspectEntry(directory, name).catch(absent);
        } finally {
          await directory.close();
        }
        // What the person agreed to, or what was found to be Melete's own, is
        // what goes; anything else there now is asked about again.
        if (gone.state !== checked.state)
          throw new Error(
            `${JSON.stringify(relative)} changed after this delete was decided, so nothing was deleted; ask again to delete it as it is now`,
          );
        // Only the entries listed in that check go, each checked again in the
        // trash; one added since stays, with its folder.
        const top = segmentsFor(relative).join('/');
        const under = (inner: string) => (inner ? `${top}/${inner}` : top);
        const trashed = await moveToTrash(
          await trashPlace(area, ctx),
          gone.items.map((item) => ({ path: under(item.path), hash: item.hash })),
          {
            days: trashDays,
            ...(options.trashMaxBytes ? { maxBytes: options.trashMaxBytes } : {}),
            folders: gone.what === 'folder' ? [top, ...gone.folders.map(under)] : [],
          },
        );
        hash = trashed.trash_id ?? gone.state;
        detail = {
          path: relative,
          area,
          deleted: gone.what,
          deleted_count: trashed.moved.length,
          deleted_names: trashed.moved.slice(0, NAMED),
          bytes: gone.bytes,
          owner: checked.owner === 'agent' ? 'agent' : 'person',
          ...(gone.content_hash ? { content_hash: gone.content_hash } : {}),
          ...(trashed.kept.length ? { kept: trashed.kept.slice(0, NAMED) } : {}),
          ...(trashed.evicted.length
            ? {
                trash_evicted: trashed.evicted,
                trash_note: `To make room, ${trashed.evicted.length === 1 ? 'an earlier delete was' : `${trashed.evicted.length} earlier deletes were`} taken out of the trash and can no longer be restored.`,
              }
            : {}),
          ...(trashed.trash_id
            ? {
                trash_id: trashed.trash_id,
                restorable_until: trashed.restorable_until,
                note: `In the trash until ${trashed.restorable_until.slice(0, 10)}; files.restore with trash_id ${trashed.trash_id} puts it all back.`,
              }
            : {}),
        };
      } else if (action.kind === 'files.restore') {
        const id = requiredString(payload, 'trash_id');
        let place: TrashPlace | null = null;
        for (const candidate of await restorePlaces(ctx))
          if (await hasTrash(candidate, id)) {
            place = candidate;
            break;
          }
        if (!place) throw new Error(`there is nothing in the trash under ${JSON.stringify(id)}`);
        const back = await restoreFromTrash(place, id);
        hash = id;
        detail = {
          trash_id: id,
          area: place.area,
          restored_count: back.restored.length,
          restored_names: back.restored.slice(0, NAMED),
          ...(back.kept.length ? { kept: back.kept.slice(0, NAMED) } : {}),
        };
      } else if (action.kind === 'files.move') {
        const from = requiredString(payload, 'from');
        const to = requiredString(payload, 'to');
        const toArea = areaFor(payload.to_area ?? area);
        const source = await resolveFile(ctx, area, from);
        const target = await resolveFile(ctx, toArea, to);
        // Both directories are walked and held from here to the move, so
        // neither can be swapped for a link anywhere else meanwhile.
        const fromDirectory = await holdBeneath(source.base, source.segments.slice(0, -1));
        try {
          const toDirectory = await holdBeneath(target.base, target.segments.slice(0, -1), true);
          try {
            const sourceName = path.basename(source.target);
            const targetName = path.basename(target.target);
            const sourceAt = fromDirectory.at(sourceName);
            const targetAt = toDirectory.at(targetName);
            const content = await readOpened(fromDirectory, sourceName);
            hash = digest(content);
            if (payload.content_hash !== undefined && payload.content_hash !== hash) {
              // Nothing was moved. The file on disk is not the content this action
              // recorded, which is a question for a person, not a retry.
              throw new ConnectorFaultError({
                kind: 'bad_output',
                detail: 'the file to move is not the content the action recorded',
              });
            }
            if (area === 'work' && toArea === 'artifacts') {
              // Into the person's Files, the bytes checked here go into a new
              // file, never the workspace's own: a second name for it, or a
              // handle a command still holds open, would let the agent's
              // computer change the person's file after they agreed to it.
              await createWith(targetAt, target.target, content);
              await unlink(sourceAt).catch(async (error: unknown) => {
                if (missing(error)) return;
                await unlink(targetAt).catch(() => {});
                throw error;
              });
            } else {
              await moveWithoutReplacing(sourceAt, targetAt);
              // Out of the person's Files, the file is the agent's again: one
              // the service kept to itself (0600) is made readable to the
              // agent's computer, as a synchronised file would be.
              if (area === 'artifacts' && toArea === 'work')
                await readableToAgent(toDirectory, targetName);
            }
          } finally {
            await toDirectory.close();
          }
        } finally {
          await fromDirectory.close();
        }
        detail = { from, to, area, to_area: toArea, content_hash: hash };
      } else {
        const relative = requiredString(payload, 'path');
        const elsewhere =
          area === 'artifacts' &&
          action.kind !== 'files.write' &&
          segmentsFor(relative)[0] === FROM_CHATS &&
          Boolean(options.sql);
        const located = elsewhere ? null : await resolveFile(ctx, area, relative);
        if (elsewhere && action.kind === 'files.list') {
          if (segmentsFor(relative).length !== 1)
            throw new Error(`there is no folder ${JSON.stringify(relative)} in ${area}`);
          detail = {
            path: relative,
            area,
            entries: (await savedElsewhere(ctx)).map((entry) => ({
              name: `${entry.id}/${entry.name}`,
              kind: 'file',
              chat: entry.chat,
              saved_at: entry.savedAt,
            })),
          };
        } else if (elsewhere && action.kind === 'files.read') {
          const { entry, content } = await readElsewhere(ctx, relative);
          hash = digest(content);
          detail = {
            path: relative,
            area,
            ...(await readableContent(content, relative)),
            content_hash: hash,
            chat: entry.chat,
          };
        } else if (action.kind === 'files.list') {
          // An area is made on its first write, so a new job or space has none
          // yet: its root lists as empty. A folder that was never made is named.
          const entries = await listFolder(located as Located).catch((error: unknown) => {
            if (!missing(error)) throw error;
            if (segmentsFor(relative).length === 0) return [];
            throw new Error(`there is no folder ${JSON.stringify(relative)} in ${area}`);
          });
          const listed = entries
            .filter((entry) => !entry.isSymbolicLink())
            .map((entry) => ({
              name: entry.name,
              kind: entry.isDirectory() ? 'directory' : 'file',
            }));
          // The space's root also offers what was saved in other conversations.
          if (
            area === 'artifacts' &&
            segmentsFor(relative).length === 0 &&
            !listed.some((entry) => entry.name === FROM_CHATS) &&
            (await savedElsewhere(ctx)).length > 0
          )
            listed.push({ name: FROM_CHATS, kind: 'directory' });
          detail = {
            path: relative,
            area,
            entries: listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          };
        } else if (action.kind === 'files.read') {
          const content = await read(located as Located).catch((error: unknown) => {
            if (!missing(error)) throw error;
            throw new Error(`there is no file ${JSON.stringify(relative)} in ${area}`);
          });
          hash = digest(content);
          detail = {
            path: relative,
            area,
            ...(await readableContent(content, relative)),
            content_hash: hash,
          };
        } else if (action.kind === 'files.write') {
          const content = requiredString(payload, 'content');
          if (Buffer.byteLength(content) > limit)
            throw new Error('content exceeds the write limit');
          const { base, segments, target } = located as Located;
          hash = digest(content);
          // A write into the person's Files let through only because the name
          // was unused (`staysInSpace`, `only_new`) must still create it: one
          // that appeared since is theirs, and is not replaced unasked. An
          // approval or a standing permission to save files covers replacing.
          const onlyNew = area === 'artifacts' && ctx.only_new === true;
          let madeNow = false;
          const directory = await holdBeneath(base, segments.slice(0, -1), true);
          try {
            const name = path.basename(target);
            const at = directory.at(name);
            const file = await open(
              at,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK |
                (onlyNew ? constants.O_EXCL : 0),
              0o600,
            ).catch(async (error: unknown) => {
              if (!onlyNew || codeOf(error) !== 'EEXIST') throw error;
              // A retry of this same write finds its own bytes there and is done.
              const there = await readOpened(directory, name).catch(() => null);
              if (there && digest(there) === hash) return null;
              throw new Error(
                "the person's Files already have a file with that name; saving over it needs the person to approve",
              );
            });
            madeNow = file !== null && onlyNew;
            if (file)
              try {
                await openedAt(file, target);
                await file.truncate(0);
                await file.writeFile(content, 'utf8');
                await file.sync();
              } finally {
                await file.close();
              }
          } finally {
            await directory.close();
          }
          // A file existing is not a delivery. Read back what was written and
          // compare it, so a short write or a racing writer is a bad output
          // rather than a receipt for content nobody has.
          const written = digest(await read(located as Located));
          if (written !== hash) {
            throw new ConnectorFaultError({
              kind: 'bad_output',
              detail: 'the file on disk does not match the content that was written',
            });
          }
          detail = {
            path: relative,
            area,
            content_hash: hash,
            bytes: Buffer.byteLength(content),
            // Made new in the person's Files: Melete's own until it changes (files-ownership.ts).
            ...(madeNow ? { created: true } : {}),
          };
          // A declared write is an artifact, and an artifact is checked here,
          // by trusted service code over the bytes that were actually written,
          // before the runtime hears that the write succeeded. The broker turns
          // what this records into rows when it persists the receipt.
          if (expectation) {
            const bytes = Buffer.from(content, 'utf8');
            detail = {
              ...detail,
              artifact: {
                area,
                path: relative,
                kind: expectation.kind,
                mime: ARTIFACT_MIME[expectation.kind] ?? ARTIFACT_MIME.binary,
                size: bytes.byteLength,
                content_hash: hash,
                template: expectation.template,
                declared_kind_matches_extension: artifactKindForPath(relative) === expectation.kind,
                evidence: Array.isArray(payload.evidence)
                  ? payload.evidence.filter((item): item is string => typeof item === 'string')
                  : [],
              },
              expectation: expectation as unknown as JsonValue,
              validations: validateArtifact(expectation, bytes) as unknown as JsonValue,
            };
          }
        } else throw new Error('unknown files tool');
      }
      return { outcome: 'succeeded', receipt: receiptFor(action, detail, hash) };
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      const payload = action.canonical_payload;
      if (action.kind === 'files.save_attachment') return verifySaved(action, ctx);
      if (action.kind === 'files.delete') return verifyDeleted(action, ctx);
      if (action.kind === 'files.restore') {
        const id = requiredString(payload, 'trash_id');
        for (const place of await restorePlaces(ctx))
          if (await hasTrash(place, id))
            return { decision: 'undecided', reason: 'some of it is still in the trash' };
        const evidence = { trash_id: id, restored: true };
        return { decision: 'succeeded', evidence, receipt: receiptFor(action, evidence, id) };
      }
      if (action.kind !== 'files.write' && action.kind !== 'files.move') {
        return { decision: 'unsupported', reason: 'file reads have no effect to verify' };
      }
      const expected =
        action.kind === 'files.write'
          ? digest(requiredString(payload, 'content'))
          : payload.content_hash;
      if (typeof expected !== 'string') {
        return {
          decision: 'undecided',
          reason: 'the move did not record an expected content hash',
        };
      }
      try {
        const area = areaFor(
          action.kind === 'files.write' ? payload.area : (payload.to_area ?? payload.area),
        );
        const relative = requiredString(payload, action.kind === 'files.write' ? 'path' : 'to');
        const actual = digest(await read(await resolveFile(ctx, area, relative)));
        if (actual !== expected)
          return { decision: 'undecided', reason: 'current file content differs from the action' };
        if (action.kind === 'files.move') {
          const source = await resolveFile(
            ctx,
            areaFor(payload.area),
            requiredString(payload, 'from'),
          );
          try {
            // Looked up inside the walked folder, so a parent swapped for a
            // link cannot make a source that is still there look gone.
            const folder = await holdBeneath(source.base, source.segments.slice(0, -1));
            try {
              await lstat(folder.at(path.basename(source.target)));
            } finally {
              await folder.close();
            }
            return { decision: 'undecided', reason: 'the move source still exists' };
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        const evidence = { path: relative, area, content_hash: actual };
        return { decision: 'succeeded', evidence, receipt: receiptFor(action, evidence, actual) };
      } catch (error) {
        if (!missing(error)) throw error;
        return { decision: 'undecided', reason: 'the destination file is absent' };
      }
    },
    async health() {
      try {
        await Promise.all([realpath(options.workRoot), realpath(options.spacesRoot)]);
        return {
          status: 'ok',
          detail: 'file roots are available',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'a configured file root is missing',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
