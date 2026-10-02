import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
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
 * Confirm that a file opened for writing is the one ordinary file at `target`,
 * before a byte of it changes. `noLinks` checks each component before the
 * open; a directory swapped for a link between that check and the open still
 * lands the open elsewhere, so the opened file must be the file the real path
 * names now. A second name for a file elsewhere is refused the same way.
 */
export async function openedAt(file: FileHandle, target: string): Promise<void> {
  const opened = await file.stat();
  if (!opened.isFile()) throw new Error('write target is not a regular file');
  if (opened.nlink !== 1) throw new Error('write target has more than one name');
  if ((await realpath(target)) !== target) throw new Error('symbolic links are not allowed');
  const named = await lstat(target);
  if (named.dev !== opened.dev || named.ino !== opened.ino)
    throw new Error('write target changed while it was opened');
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
      description: 'Read a UTF-8 file and its content hash.',
      input_schema: inputSchema({ path: pathSchema, area: areaSchema }, ['path']),
      effect_class: 'read',
      required_scopes: ['files.read'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'files.write',
      description:
        'Write a UTF-8 file, only when the owner asks for a file or the work is a document to keep. Answers, drafts, tables and plans go in the reply instead. Declare expect to make it a checked deliverable.',
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

export function createFilesConnector(options: FilesOptions): Connector {
  const limit = options.maxBytes ?? 2 * 1024 * 1024;
  const resolveFile = async (
    ctx: ConnectorContext,
    area: Area,
    relative: string,
    create = false,
  ) => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id) || !/^sp_[A-Za-z0-9]+$/.test(ctx.space_id)) {
      throw new Error('invalid trusted file scope');
    }
    const base = await realpath(area === 'work' ? options.workRoot : options.spacesRoot);
    const scope = area === 'work' ? [ctx.job_id] : [ctx.space_id, 'artifacts'];
    return noLinks(base, [...scope, ...segmentsFor(relative)], create);
  };
  const read = async (target: string): Promise<Buffer> => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
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
    const target = await noLinks(base, [...scope, ...segmentsFor(entry.path)], false);
    const content = await read(target).catch((error: unknown) => {
      if (!missing(error)) throw error;
      throw new Error(`the file ${JSON.stringify(entry.name)} is no longer there`);
    });
    return { entry, content };
  };

  return {
    manifest: filesManifest,
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
        const source = await resolveFile(ctx, area, from);
        const target = await resolveFile(ctx, areaFor(payload.to_area ?? area), to, true);
        hash = digest(await read(source));
        if (payload.content_hash !== undefined && payload.content_hash !== hash) {
          // Nothing was moved. The file on disk is not the content this action
          // recorded, which is a question for a person, not a retry.
          throw new ConnectorFaultError({
            kind: 'bad_output',
            detail: 'the file to move is not the content the action recorded',
          });
        }
        try {
          await lstat(target);
          throw new Error('move destination already exists');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await rename(source, target);
        detail = { from, to, area, to_area: areaFor(payload.to_area ?? area), content_hash: hash };
      } else {
        const relative = requiredString(payload, 'path');
        const elsewhere =
          area === 'artifacts' &&
          action.kind !== 'files.write' &&
          segmentsFor(relative)[0] === FROM_CHATS &&
          Boolean(options.sql);
        const target = elsewhere
          ? ''
          : await resolveFile(ctx, area, relative, action.kind === 'files.write');
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
            content: content.toString('utf8'),
            content_hash: hash,
            chat: entry.chat,
          };
        } else if (action.kind === 'files.list') {
          // An area is made on its first write, so a new job or space has none
          // yet: its root lists as empty. A folder that was never made is named.
          const entries = await readdir(target, { withFileTypes: true }).catch((error: unknown) => {
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
          const content = await read(target).catch((error: unknown) => {
            if (!missing(error)) throw error;
            throw new Error(`there is no file ${JSON.stringify(relative)} in ${area}`);
          });
          hash = digest(content);
          detail = { path: relative, area, content: content.toString('utf8'), content_hash: hash };
        } else if (action.kind === 'files.write') {
          const content = requiredString(payload, 'content');
          if (Buffer.byteLength(content) > limit)
            throw new Error('content exceeds the write limit');
          const file = await open(
            target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await openedAt(file, target);
            await file.truncate(0);
            await file.writeFile(content, 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          hash = digest(content);
          // A file existing is not a delivery. Read back what was written and
          // compare it, so a short write or a racing writer is a bad output
          // rather than a receipt for content nobody has.
          const written = digest(await read(target));
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
        const target = await resolveFile(ctx, area, relative);
        const actual = digest(await read(target));
        if (actual !== expected)
          return { decision: 'undecided', reason: 'current file content differs from the action' };
        if (action.kind === 'files.move') {
          const source = await resolveFile(
            ctx,
            areaFor(payload.area),
            requiredString(payload, 'from'),
          );
          try {
            await lstat(source);
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
