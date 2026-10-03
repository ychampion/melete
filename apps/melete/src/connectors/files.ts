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
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { validateArtifact } from '../artifact/validate.ts';
import { BrokerFault } from '../broker/errors.ts';
import { LEGACY_SCREEN_PATH } from '../devices/screen-paths.ts';
import { ConnectorFaultError } from './faults.ts';
import type { Connector, ConnectorContext } from './types.ts';
import type { PrivateContext } from './web.ts';

type Area = 'work' | 'artifacts';
type FilesOptions = {
  workRoot: string;
  spacesRoot: string;
  maxBytes?: number;
  /** Where saved files are recorded, so other conversations' files can be found. */
  sql?: Sql;
  /**
   * Whether a space or agent is private. A file saved where the person spoke
   * privately is offered to no other conversation unless that one is private
   * too; without this check, no other conversation's file is offered.
   */
  privateContext?: PrivateContext;
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

/**
 * What a read hands back: the file as text. A file with a NUL byte or bytes
 * that are not UTF-8 is a picture or another binary file, which a read cannot
 * hand back as text and a record cannot hold. It fails plainly and at once,
 * so the agent hears why instead of waiting on a read that never settles.
 */
export function readableText(content: Buffer, relative: string): string {
  if (!content.includes(0)) {
    try {
      return UTF8.decode(content);
    } catch {
      // Not UTF-8: told below.
    }
  }
  const what = PICTURE.test(relative) ? 'a picture' : 'not a text file';
  throw new Error(`${JSON.stringify(relative)} is ${what}; files.read reads UTF-8 text only`);
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

/** Reject both host and portable path syntax, including Windows device/stream names. */
export function segmentsFor(value: string): string[] {
  if (
    !value ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('\\') ||
    value.includes(':')
  ) {
    throw new Error('path must be relative to its area');
  }
  if (value === '.') return [];
  const segments = value.split('/');
  if (
    segments.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error('path traversal or device path is not allowed');
  }
  return segments;
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Inspect every component: checking only the final realpath misses dangling links. */
export async function noLinks(
  base: string,
  segments: string[],
  createParents: boolean,
): Promise<string> {
  let current = base;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error('empty path component');
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed');
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error('path parent is not a directory');
      }
    } catch (error) {
      if (!missing(error)) throw error;
      if (createParents && index < segments.length - 1) {
        await mkdir(current);
        const created = await lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error('unsafe path parent');
        }
      }
    }
  }
  return current;
}

/**
 * The path check each open here begins with. It names a link or a file in the
 * way plainly, but it only reads names: what the open after it reaches is
 * decided by that open. Held in an object so a test can change the tree
 * between this check and the open.
 */
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
    checks: { type: 'array', maxItems: 25, items: { type: 'object' } },
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
        'Read a UTF-8 text file and its content hash. Pictures and other binary files cannot be read this way.',
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
  ],
};

/**
 * Move a file to a name that must be unused. A second name is made first, so
 * a file that appeared at the destination meanwhile is never replaced; where
 * the system will not make one (another owner's file, another filesystem),
 * the name is checked and the file renamed.
 */
async function moveWithoutReplacing(from: string, to: string): Promise<void> {
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

export function createFilesConnector(options: FilesOptions): Connector {
  const limit = options.maxBytes ?? 2 * 1024 * 1024;
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
    const base = await realpath(area === 'work' ? options.workRoot : options.spacesRoot);
    const scope = area === 'work' ? [ctx.job_id] : [ctx.space_id, 'artifacts'];
    const names = [...scope, ...segments];
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
    const base = await realpath(entry.area === 'work' ? options.workRoot : options.spacesRoot);
    const scope = entry.area === 'work' ? [entry.jobId as string] : [ctx.space_id, 'artifacts'];
    if (entry.area === 'work' && !/^job_[A-Za-z0-9]+$/.test(entry.jobId ?? ''))
      throw new Error('invalid trusted file scope');
    const names = [...scope, ...segmentsFor(entry.path)];
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

  return {
    manifest: filesManifest,
    staysInSpace: newInPersonFiles,
    async prepare(payload) {
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
      if (action.kind === 'files.move') {
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
            content: readableText(content, relative),
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
            content: readableText(content, relative),
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
          detail = { path: relative, area, content_hash: hash, bytes: Buffer.byteLength(content) };
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
