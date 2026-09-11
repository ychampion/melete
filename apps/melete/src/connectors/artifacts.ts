/**
 * Publishing a finished artifact.
 *
 * A file in the job workspace is work in progress. Publishing is the step that
 * takes it somewhere the job does not own: the space's artifacts directory,
 * where the owner looks for finished things, or an email with the file
 * attached. That is an external effect, so it is `write_external`, it needs an
 * approval bound to the payload hash, and it produces a receipt.
 *
 * Two rules make the approval mean something.
 *
 * The bytes are never in the payload. The payload names a path; the service
 * looks up the artifact it recorded for that path and reads the file itself. A
 * file that changed since it was recorded fails the publish rather than being
 * sent, because the content hash the owner approved is the one on the record.
 *
 * Only a recorded artifact can be published. A write that declared nothing has
 * no record, no validations, and nothing to point at, so it is not something
 * this release will send anywhere.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type Action,
  type ConnectorManifest,
  type JsonObject,
  type JsonValue,
  publishDestination,
  type Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { noLinks, segmentsFor } from './files.ts';
import type { MailAttachment } from './mail-transport.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** What the email destination needs, and nothing more. */
export interface ArtifactMailer {
  connectionId: string;
  spaceId: string;
  send(
    message: {
      to: string[];
      subject: string;
      body: string;
      messageId: string;
      attachments: MailAttachment[];
    },
    context: { space_id: string; connection_id: string },
  ): Promise<{ messageId: string; accepted?: string[]; rejected?: string[] }>;
}

export type ArtifactsOptions = {
  sql: Sql;
  workRoot: string;
  spacesRoot: string;
  maxBytes?: number;
  /** Absent means the email destination is refused rather than faked. */
  mailer?: ArtifactMailer;
  mailers?: ReadonlyMap<string, ArtifactMailer>;
};

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const messageIdFor = (actionId: string) => `<${actionId}@melete.invalid>`;

const destinationSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', const: 'space_artifacts' },
        path: { type: ['string', 'null'], minLength: 1, maxLength: 1024 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'to', 'subject'],
      properties: {
        kind: { type: 'string', const: 'email' },
        // No `format: email` here. The validator this schema is handed does
        // not know the keyword, ignores it, and says so on every call, which
        // fills the test output with warnings about a check that was never
        // being made. `publishDestination` is what actually rejects an address.
        to: {
          oneOf: [
            { type: 'string', minLength: 3, maxLength: 320 },
            {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: { type: 'string', minLength: 3, maxLength: 320 },
            },
          ],
        },
        subject: { type: 'string', minLength: 1, maxLength: 500 },
        body: { type: 'string', maxLength: 20000 },
        filename: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      },
    },
  ],
};

export const artifactsManifest: ConnectorManifest = {
  name: 'artifacts',
  version: '0.1.0',
  provider: 'artifacts',
  description: 'Publish a recorded artifact to the space or to an email recipient.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'artifact.publish',
      description: 'Publish a checked artifact to the space artifacts directory or by email.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'destination'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          area: { type: 'string', enum: ['work', 'artifacts'] },
          destination: destinationSchema,
          mailbox_connection_id: { type: 'string', minLength: 1 },
          mailbox_generation: { type: 'integer', minimum: 0 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['artifact.publish'],
      verify: true,
      requires_approval: true,
    },
  ],
};

type ArtifactRow = {
  id: string;
  area: string;
  path: string;
  kind: string;
  mime: string;
  content_hash: string;
  size: number;
};

export function createArtifactsConnector(options: ArtifactsOptions): Connector {
  const limit = options.maxBytes ?? 8 * 1024 * 1024;
  const mailers =
    options.mailers ??
    new Map(options.mailer ? [[options.mailer.connectionId, options.mailer]] : []);

  const mailbox = async (
    payload: JsonObject,
    ctx: ConnectorContext,
    tx: Query,
    binding: boolean,
  ) => {
    const rows = await tx`select id, generation from connection where space_id = ${ctx.space_id}
      and provider = 'imap' and status = 'active' and scopes @> '["email.send"]'::jsonb order by id for share`;
    const selected = rows.find(
      (row) =>
        (!payload.mailbox_connection_id || row.id === payload.mailbox_connection_id) &&
        mailers.get(row.id)?.spaceId === ctx.space_id &&
        mailers.get(row.id)?.connectionId === row.id,
    );
    if (
      !selected ||
      (binding &&
        (payload.mailbox_connection_id !== selected.id ||
          payload.mailbox_generation !== selected.generation))
    )
      throw new BrokerFault(
        'scope_denied',
        'No authorized mailbox with the approved generation in this artifact space',
      );
    return selected;
  };

  const latest = async (
    jobId: string,
    area: string,
    relative: string,
  ): Promise<ArtifactRow | undefined> => {
    const [row] = await options.sql`select id, area, path, kind, mime, content_hash, size
      from artifact where job_id = ${jobId} and area = ${area} and path = ${relative}
      and expectation is not null order by created_at desc, id desc limit 1`;
    return row as ArtifactRow | undefined;
  };

  const read = async (target: string): Promise<Buffer> => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new Error('the artifact is not a regular file or exceeds the publish limit');
      return await file.readFile();
    } finally {
      await file.close();
    }
  };

  const source = async (ctx: ConnectorContext, area: string, relative: string) => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id) || !/^sp_[A-Za-z0-9]+$/.test(ctx.space_id))
      throw new Error('invalid trusted file scope');
    const base = await realpath(area === 'work' ? options.workRoot : options.spacesRoot);
    const scope = area === 'work' ? [ctx.job_id] : [ctx.space_id, 'artifacts'];
    return noLinks(base, [...scope, ...segmentsFor(relative)], false);
  };

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key
    )
      throw new Error('connector action identity mismatch');
  };

  /** Resolve the payload to a recorded artifact and its unchanged bytes. */
  const load = async (action: Action, ctx: ConnectorContext) => {
    const payload = action.canonical_payload;
    const relative = typeof payload.path === 'string' ? payload.path : '';
    const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
    if (!relative) throw new Error('path must be a string');
    const record = await latest(ctx.job_id, area, relative);
    if (!record)
      throw new Error(
        `${relative} has no artifact record; declare expect on the write before publishing it`,
      );
    const bytes = await read(await source(ctx, area, relative));
    const hash = digest(bytes);
    if (hash !== record.content_hash)
      throw new Error('the file has changed since it was recorded; write and check it again');
    return { record, bytes, hash, area, relative };
  };

  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  return {
    manifest: artifactsManifest,
    async prepare(payload, ctx, tx) {
      const destination = publishDestination.parse(payload.destination);
      if (destination.kind !== 'email') return payload;
      const selected = await mailbox(payload, ctx, tx, false);
      return {
        ...payload,
        mailbox_connection_id: selected.id,
        mailbox_generation: selected.generation,
      };
    },
    async validateBinding(action, ctx, tx) {
      if (publishDestination.parse(action.canonical_payload.destination).kind === 'email')
        await mailbox(action.canonical_payload, ctx, tx, true);
    },
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      if (action.kind !== 'artifact.publish') throw new Error('unknown artifacts tool');
      const destination = publishDestination.parse(action.canonical_payload.destination);
      const { record, bytes, hash, relative } = await load(action, ctx);
      const publishedAt = new Date().toISOString();
      let externalRef: string;
      let detail: Record<string, JsonValue>;
      if (destination.kind === 'space_artifacts') {
        const target = destination.path ?? path.posix.basename(relative);
        const base = await realpath(options.spacesRoot);
        const segments = [ctx.space_id, 'artifacts', ...segmentsFor(target)];
        await mkdir(path.join(base, ctx.space_id, 'artifacts'), { recursive: true });
        const resolved = await noLinks(base, segments, true);
        const file = await open(
          resolved,
          constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error('the publish target is not a regular file');
          await file.truncate(0);
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        externalRef = target;
        detail = { destination: 'space_artifacts', path: target, bytes: bytes.byteLength };
      } else {
        const selected = await mailbox(action.canonical_payload, ctx, options.sql, true);
        const mailer = mailers.get(selected.id);
        if (!mailer) throw new BrokerFault('scope_denied');
        const recipients = Array.isArray(destination.to) ? destination.to : [destination.to];
        const messageId = messageIdFor(action.id);
        const sent = await mailer.send(
          {
            to: recipients,
            subject: destination.subject,
            body: destination.body,
            messageId,
            attachments: [
              {
                filename: destination.filename ?? path.posix.basename(relative),
                content: bytes,
                contentType: record.mime,
              },
            ],
          },
          { space_id: ctx.space_id, connection_id: selected.id },
        );
        externalRef = sent.messageId;
        detail = {
          destination: 'email',
          message_id: sent.messageId,
          to: recipients,
          accepted: sent.accepted ?? null,
          rejected: sent.rejected ?? null,
          bytes: bytes.byteLength,
        };
      }
      return {
        outcome: 'succeeded',
        receipt: receiptFor(
          action,
          {
            ...detail,
            artifact_id: record.id,
            content_hash: hash,
            // The broker persists this alongside the receipt, which is what
            // links the artifact record to where its content ended up.
            publication: {
              destination: destination.kind,
              action_id: action.id,
              external_ref: externalRef,
              content_hash: hash,
              detail,
              published_at: publishedAt,
            },
          },
          externalRef,
        ),
      };
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      if (action.kind !== 'artifact.publish')
        return { decision: 'unsupported', reason: 'only a publish has anything to verify' };
      try {
        const destination = publishDestination.parse(action.canonical_payload.destination);
        if (destination.kind !== 'space_artifacts') {
          // A mail server's acceptance is the email connector's question, not
          // this one's; from here an unacknowledged send cannot be decided.
          return {
            decision: 'undecided',
            reason: 'a mailed artifact cannot be confirmed from the artifact store',
          };
        }
        const { record, hash, relative } = await load(action, ctx);
        const target = destination.path ?? path.posix.basename(relative);
        const base = await realpath(options.spacesRoot);
        const resolved = await noLinks(
          base,
          [ctx.space_id, 'artifacts', ...segmentsFor(target)],
          false,
        );
        const published = digest(await read(resolved));
        if (published !== hash)
          return { decision: 'undecided', reason: 'the published copy differs from the artifact' };
        const detail = {
          destination: 'space_artifacts',
          path: target,
          artifact_id: record.id,
          content_hash: published,
        };
        return {
          decision: 'succeeded',
          evidence: detail,
          receipt: receiptFor(action, detail, target),
        };
      } catch (error) {
        return { decision: 'undecided', reason: (error as Error).message };
      }
    },
    async health() {
      try {
        await Promise.all([realpath(options.workRoot), realpath(options.spacesRoot)]);
        return {
          status: 'ok',
          detail: 'the artifact roots are available',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'an artifact root is missing',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
