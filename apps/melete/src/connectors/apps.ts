/**
 * Publishing apps, and choosing which version of one people see.
 *
 * An app is a folder of web files the agent wrote in its workspace. Publishing
 * it makes it something other people can open, so it is `write_external` and
 * asks every time, a new version of an existing app included. The question
 * names the app, how many files it has and how large they are, who will be
 * able to open it, and which data it shows.
 *
 * Nothing is stored before the approval. `prepare` reads the folder, applies
 * the bundle rules and binds the hash of the manifest it would publish. The
 * dispatch reads the folder again, and publishes only if it still makes the
 * same manifest: a file changed after the approval is a different version,
 * which has to be asked for again. Only then are the files stored and the
 * version, the app's pointer and its grants written, in one transaction.
 *
 * Rolling back to an earlier version is the agent's request too, so it asks.
 * The person does both from the Apps screen without asking: those are their
 * own actions on their own app.
 */
import { realpath } from 'node:fs/promises';
import {
  type Action,
  APP_LIMITS,
  type AppManifest,
  type ConnectorManifest,
  type JsonObject,
  type JsonValue,
  type Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import {
  AppUnavailable,
  appRoleFor,
  BundleRefused,
  type DesiredGrant,
  manifestFor,
  manifestHash,
  publishVersion,
  readBundle,
  setCurrentVersion,
  versionIdFor,
} from '../apps/service.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { newId } from '../ids.ts';
import type { BlobStore } from '../storage/blob.ts';
import type { Connector, ConnectorContext } from './types.ts';

export type AppsOptions = {
  sql: Sql;
  workRoot: string;
  /** Where published files are kept. */
  blobs: BlobStore;
};

const APP_ID = '^app_[0-9A-Za-z]{1,64}$';
const SHA256 = '^[0-9a-f]{64}$';
const NAME = '^[a-z0-9][a-z0-9_-]{0,39}$';

const audienceSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { type: 'string', const: 'only_me' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'emails'],
      properties: {
        kind: { type: 'string', const: 'people' },
        emails: {
          type: 'array',
          minItems: 1,
          maxItems: APP_LIMITS.max_people,
          items: { type: 'string', minLength: 3, maxLength: 320 },
        },
        // Bound by the service: the accounts those addresses belong to.
        principal_ids: {
          type: 'array',
          maxItems: APP_LIMITS.max_people,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { type: 'string', const: 'everyone' } },
    },
    {
      // Bound by the service when a new version leaves the viewers as they are.
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'now'],
      properties: {
        kind: { type: 'string', const: 'unchanged' },
        now: { type: 'string', maxLength: 4000 },
      },
    },
  ],
};

export const appsManifest: ConnectorManifest = {
  name: 'apps',
  version: '0.1.0',
  provider: 'apps',
  description: 'Publish a folder of web files as an app people can open, and choose its version.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'apps.publish',
      description:
        'Publish a folder from the workspace as an app, or as a new version of one. The folder needs index.html at its top and only html, js, mjs, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff2, txt, map or wasm files (200 files, 25 MiB, 8 MiB per file at most). Bundle everything: no external scripts, fonts or images. The person is asked first.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dir', 'name'],
        properties: {
          dir: { type: 'string', minLength: 1, maxLength: 1024 },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
          /** An app to publish a new version of. Left out, a new app is made. */
          app_id: { type: 'string', pattern: APP_ID },
          data: {
            type: 'object',
            maxProperties: APP_LIMITS.max_data_bindings,
            propertyNames: { pattern: NAME },
            additionalProperties: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['artifact'],
                  properties: {
                    /** A file in the workspace, whose newest version the app shows. */
                    artifact: { type: 'string', minLength: 1, maxLength: 1024 },
                    /** `this_job` (the default) or another conversation in this space. */
                    source: { type: 'string', minLength: 1, maxLength: 200 },
                  },
                },
                {
                  // Bound by the service: the conversation the file is read from.
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'path', 'source_job_id'],
                  properties: {
                    kind: { type: 'string', const: 'artifact' },
                    path: { type: 'string', minLength: 1, maxLength: 1024 },
                    source_job_id: { type: 'string', minLength: 1, maxLength: 200 },
                  },
                },
              ],
            },
          },
          collections: {
            type: 'object',
            maxProperties: APP_LIMITS.max_collections,
            propertyNames: { pattern: NAME },
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: {
                max_bytes: {
                  type: 'integer',
                  minimum: 1,
                  maximum: APP_LIMITS.max_collection_record_bytes,
                },
              },
            },
          },
          audience: audienceSchema,
          // Bound by the service before the person is asked.
          create: { type: 'boolean' },
          manifest_hash: { type: 'string', pattern: SHA256 },
          file_count: { type: 'integer', minimum: 1 },
          total_bytes: { type: 'integer', minimum: 0 },
          data_shown: {
            type: 'array',
            maxItems: APP_LIMITS.max_data_bindings,
            items: { type: 'string', maxLength: 2000 },
          },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['apps.publish'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'apps.rollback',
      description:
        'Make an earlier version of an app the one people see. The person is asked first.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['app_id', 'version_id'],
        properties: {
          app_id: { type: 'string', pattern: APP_ID },
          version_id: { type: 'string', pattern: SHA256 },
          // Bound by the service before the person is asked.
          name: { type: 'string', maxLength: 200 },
          version_published_at: { type: 'string', maxLength: 64 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['apps.rollback'],
      verify: true,
      requires_approval: true,
    },
  ],
};

const refused = (message: string) => new BrokerFault('payload_invalid', message);

type BindingInput = {
  artifact?: unknown;
  source?: unknown;
  path?: unknown;
  source_job_id?: unknown;
};

/** The person a conversation acts for, who publishes as themselves. */
async function publisherOf(tx: Query, ctx: ConnectorContext): Promise<string> {
  const [row] = await tx`select coalesce(j.principal_id, s.owner_principal_id) as principal_id
    from job j join space s on s.id = j.space_id
    where j.id = ${ctx.job_id} and j.space_id = ${ctx.space_id}`;
  const id = row?.principal_id;
  if (typeof id !== 'string' || !id)
    throw refused('This conversation has no person to publish as, so nothing was published.');
  return id;
}

/** Each binding's source resolved to a conversation in this space, and a line for the card. */
async function resolveData(
  tx: Query,
  ctx: ConnectorContext,
  data: unknown,
): Promise<{ bindings: AppManifest['data']; shown: string[] }> {
  const bindings: AppManifest['data'] = {};
  const shown: string[] = [];
  const entries = Object.entries((data ?? {}) as Record<string, BindingInput>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  for (const [name, binding] of entries) {
    // The agent's shape, or the bound one when a payload is offered again.
    const path = binding.artifact ?? binding.path;
    const artifact = typeof path === 'string' ? path : '';
    if (!artifact) throw refused(`Data "${name}" needs the file it shows.`);
    const named = binding.source ?? binding.source_job_id;
    const source = named === undefined || named === 'this_job' ? ctx.job_id : String(named);
    if (source !== ctx.job_id) {
      const [job] = await tx`select 1 from job where id = ${source} and space_id = ${ctx.space_id}`;
      if (!job) throw refused(`Data "${name}" names a conversation that is not in this space.`);
    }
    bindings[name] = { kind: 'artifact', path: artifact, source_job_id: source };
    shown.push(
      `${name}: ${artifact} from ${source === ctx.job_id ? 'this conversation' : 'another conversation in this space'}, newest version each time`,
    );
  }
  return { bindings, shown };
}

function collectionsOf(collections: unknown): AppManifest['collections'] {
  return Object.fromEntries(
    Object.entries((collections ?? {}) as Record<string, { max_bytes?: number }>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => [
        name,
        { max_bytes: value.max_bytes ?? APP_LIMITS.max_collection_record_bytes },
      ]),
  );
}

/** The live grants of an app, as a card line. */
async function viewersNow(tx: Query, appId: string): Promise<string> {
  const rows = await tx`select g.grantee_kind, p.email from app_grant g
    left join principal p on g.grantee_kind = 'principal' and p.id = g.grantee_id
    where g.app_id = ${appId} and g.revoked_at is null order by p.email nulls first`;
  if (rows.some((row) => row.grantee_kind === 'installation'))
    return 'everyone with an account here';
  const emails = rows.flatMap((row) => (typeof row.email === 'string' ? [row.email] : []));
  return emails.length ? `you and ${emails.join(', ')}` : 'only you';
}

/** The audience as bound into the payload, resolving addresses to accounts. */
async function resolveAudience(
  tx: Query,
  audience: unknown,
  publisher: string,
  existing: string | null,
): Promise<JsonObject> {
  const value = (audience ?? null) as { kind?: string; emails?: unknown } | null;
  if (!value) {
    if (existing) return { kind: 'unchanged', now: await viewersNow(tx, existing) };
    return { kind: 'only_me' };
  }
  if (value.kind === 'only_me' || value.kind === 'everyone') return { kind: value.kind };
  if (value.kind !== 'people' || !Array.isArray(value.emails))
    throw refused('Say who may open the app: only_me, people with their emails, or everyone.');
  const emails = [
    ...new Set(value.emails.map((email) => String(email).trim().toLowerCase())),
  ].sort();
  const rows = await tx`select id, lower(email) as email from principal
    where lower(email) = any(${emails})`;
  const found = new Map(rows.map((row) => [String(row.email), String(row.id)]));
  const missing = emails.filter((email) => !found.has(email));
  if (missing.length)
    throw refused(
      `No account here for ${missing.join(', ')}. Apps open only for people with an account on this installation.`,
    );
  const others = emails.filter((email) => found.get(email) !== publisher);
  return {
    kind: 'people',
    emails: others,
    principal_ids: others.map((email) => found.get(email) as string),
  };
}

function grantsFor(audience: JsonObject): DesiredGrant[] | null {
  if (audience.kind === 'unchanged') return null;
  if (audience.kind === 'everyone') return [{ kind: 'installation', role: 'view' }];
  if (audience.kind === 'people' && Array.isArray(audience.principal_ids))
    return audience.principal_ids.map((id) => ({
      kind: 'principal',
      id: String(id),
      role: 'view',
    }));
  return [];
}

const receiptFor = (
  action: Action,
  detail: Record<string, JsonValue>,
  externalRef: string,
): Receipt => ({
  action_id: action.id,
  connection_id: action.connection_id,
  external_ref: externalRef,
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

const linkFor = (appId: string) => `#/apps/${appId}`;

export function createAppsConnector(options: AppsOptions): Connector {
  /** The bundle as it is on disk now, with the bindings the payload carries. */
  const bundle = async (ctx: ConnectorContext, payload: JsonObject) => {
    const dir = typeof payload.dir === 'string' ? payload.dir : '';
    let files: Awaited<ReturnType<typeof readBundle>>;
    try {
      files = await readBundle(options.workRoot, ctx.job_id, dir);
    } catch (error) {
      if (error instanceof BundleRefused) throw refused(error.message);
      throw error;
    }
    const manifest = manifestFor(
      files,
      (payload.data ?? {}) as AppManifest['data'],
      collectionsOf(payload.collections),
    );
    return { files, manifest, hash: manifestHash(manifest) };
  };

  /** An app in this space that the conversation's person manages. */
  const managedApp = async (tx: Query, ctx: ConnectorContext, appId: string, publisher: string) => {
    const [row] = await tx`select name, status from app
      where id = ${appId} and space_id = ${ctx.space_id}`;
    if (row?.status !== 'active') throw refused('There is no such app in this space.');
    if ((await appRoleFor(tx, appId, publisher)) !== 'manage')
      throw refused('Only someone who manages this app can change it.');
    return { name: String(row.name) };
  };

  return {
    manifest: appsManifest,
    async prepare(payload, ctx, tx): Promise<JsonObject> {
      const publisher = await publisherOf(tx, ctx);
      if (typeof payload.version_id === 'string') {
        // apps.rollback
        const appId = String(payload.app_id);
        const app = await managedApp(tx, ctx, appId, publisher);
        const [version] = await tx`select created_at from app_version
          where id = ${payload.version_id} and app_id = ${appId}`;
        if (!version) throw refused('That version is not one of this app.');
        return {
          app_id: appId,
          version_id: payload.version_id,
          name: app.name,
          version_published_at: new Date(version.created_at as string).toISOString(),
        };
      }
      const existing = typeof payload.app_id === 'string' ? payload.app_id : null;
      if (existing) await managedApp(tx, ctx, existing, publisher);
      const { bindings, shown } = await resolveData(tx, ctx, payload.data);
      const audience = await resolveAudience(tx, payload.audience, publisher, existing);
      const bound: JsonObject = {
        dir: payload.dir as string,
        name: String(payload.name).trim() || 'App',
        ...(typeof payload.description === 'string' && payload.description.trim()
          ? { description: payload.description.trim() }
          : {}),
        app_id: existing ?? newId('app'),
        create: !existing,
        data: bindings as unknown as JsonObject,
        ...(payload.collections ? { collections: collectionsOf(payload.collections) } : {}),
        audience,
        data_shown: shown,
      };
      // Read and checked before the person is asked: a bundle that breaks a
      // rule is refused here, and nothing about it is stored.
      const { files, manifest, hash } = await bundle(ctx, bound);
      return {
        ...bound,
        manifest_hash: hash,
        file_count: files.length,
        total_bytes: Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0),
      };
    },
    async validateBinding(action, ctx, tx) {
      const payload = action.canonical_payload;
      const publisher = await publisherOf(tx, ctx);
      if (action.kind === 'apps.rollback' || payload.create !== true)
        await managedApp(tx, ctx, String(payload.app_id), publisher);
    },
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      const payload = action.canonical_payload;
      const publisher = await publisherOf(options.sql, ctx);
      if (action.kind === 'apps.rollback') {
        const appId = String(payload.app_id);
        const versionId = String(payload.version_id);
        try {
          await options.sql.begin(async (tx) => {
            if ((await appRoleFor(tx, appId, publisher)) !== 'manage')
              throw new AppUnavailable('no longer managed by this person');
            const [row] =
              await tx`select 1 from app where id = ${appId} and space_id = ${ctx.space_id}`;
            if (!row) throw new AppUnavailable('no such app in this space');
            await setCurrentVersion(tx, appId, versionId);
          });
        } catch (error) {
          if (error instanceof AppUnavailable)
            throw refused('The app or that version is no longer available, so nothing changed.');
          throw error;
        }
        const detail = { app_id: appId, version_id: versionId, link: linkFor(appId) };
        return { outcome: 'succeeded', receipt: receiptFor(action, detail, versionId) };
      }
      if (action.kind !== 'apps.publish') throw new Error('unknown apps tool');
      const { files, manifest, hash } = await bundle(ctx, payload);
      if (hash !== payload.manifest_hash)
        throw refused(
          'The files changed after the person approved them, so nothing was published. Publish again to ask with the files as they are now.',
        );
      const appId = String(payload.app_id);
      let published: Awaited<ReturnType<typeof publishVersion>>;
      try {
        published = await publishVersion(options.sql, options.blobs, {
          appId,
          create: payload.create === true,
          spaceId: ctx.space_id,
          name: String(payload.name),
          description: typeof payload.description === 'string' ? payload.description : null,
          publisherId: publisher,
          files,
          manifest,
          manifestHash: hash,
          jobId: ctx.job_id,
          actionId: action.id,
          grants: grantsFor((payload.audience ?? { kind: 'only_me' }) as JsonObject),
        });
      } catch (error) {
        if (error instanceof AppUnavailable)
          throw refused(
            'The app is no longer there, or no longer managed by this person, so nothing was published.',
          );
        throw error;
      }
      const detail = {
        app_id: published.appId,
        version_id: published.versionId,
        created: published.created,
        files: files.length,
        bytes: Number(payload.total_bytes ?? 0),
        link: linkFor(published.appId),
      };
      return { outcome: 'succeeded', receipt: receiptFor(action, detail, published.versionId) };
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      const payload = action.canonical_payload;
      const appId = String(payload.app_id);
      const versionId =
        action.kind === 'apps.rollback'
          ? String(payload.version_id)
          : typeof payload.manifest_hash === 'string'
            ? versionIdFor(appId, payload.manifest_hash)
            : null;
      if (!versionId) return { decision: 'unsupported', reason: 'nothing to compare' };
      const [row] = await options.sql`select current_version_id from app
        where id = ${appId} and space_id = ${ctx.space_id}`;
      if (row?.current_version_id !== versionId)
        return { decision: 'undecided', reason: 'the app does not show that version now' };
      const detail = { app_id: appId, version_id: versionId, link: linkFor(appId) };
      return {
        decision: 'succeeded',
        evidence: detail,
        receipt: receiptFor(action, detail, versionId),
      };
    },
    async health() {
      try {
        await realpath(options.workRoot);
        return {
          status: 'ok',
          detail: 'the workspace root is available',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'the workspace root is missing',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
