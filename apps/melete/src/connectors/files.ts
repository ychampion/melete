import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
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
import { validateArtifact } from '../artifact/validate.ts';
import { BrokerFault } from '../broker/errors.ts';
import { ConnectorFaultError } from './faults.ts';
import type { Connector, ConnectorContext } from './types.ts';

type Area = 'work' | 'artifacts';
type FilesOptions = { workRoot: string; spacesRoot: string; maxBytes?: number };
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
    human: { type: 'boolean' },
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
      description: 'List one directory; use path . for its root.',
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
      description: 'Write a UTF-8 file. Declare expect to make it a checked deliverable.',
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
        const target = await resolveFile(ctx, area, relative, action.kind === 'files.write');
        if (action.kind === 'files.list') {
          const entries = await readdir(target, { withFileTypes: true });
          detail = {
            path: relative,
            area,
            entries: entries
              .filter((entry) => !entry.isSymbolicLink())
              .map((entry) => ({
                name: entry.name,
                kind: entry.isDirectory() ? 'directory' : 'file',
              }))
              .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          };
        } else if (action.kind === 'files.read') {
          const content = await read(target);
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
            const stat = await file.stat();
            if (!stat.isFile()) throw new Error('write target is not a regular file');
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
