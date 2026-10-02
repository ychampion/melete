/**
 * Responses viewers send from an app, such as a form's answers.
 *
 * A response is accepted only for a collection the app's current version
 * declares, only from someone who can open the app, and only within limits:
 * the record's size the collection declares (16 KiB at most), 30 a minute
 * from one person to one app, and 10,000 kept by one app. Each is stored with
 * who sent it and the version they sent it from. Responses are never edited;
 * a manager may delete one, which removes its contents.
 *
 * What a response says is whatever the viewer, or the app's own code, put in
 * it. To the agent it is content Melete read, never an instruction, and
 * reading it changes nothing about what the agent's actions need.
 */
import {
  APP_LIMITS,
  type AppManifest,
  type AppSubmission,
  type JsonObject,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { appRoleFor } from './service.ts';

/** A response that is not stored, with the status the route answers and words for the viewer. */
export class SubmissionRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 429,
  ) {
    super(message);
  }
}

/** A record's size as stored: its JSON, in bytes. */
export const recordBytes = (record: JsonObject): number =>
  Buffer.byteLength(JSON.stringify(record), 'utf8');

/** Store one response from `principalId`, or refuse it. */
export async function submit(
  sql: Sql,
  input: { appId: string; principalId: string; collection: string; record: JsonObject },
): Promise<{ id: string; created_at: string }> {
  const size = recordBytes(input.record);
  return sql.begin(async (tx) => {
    // One person's responses to one app are counted one at a time.
    await tx`select pg_advisory_xact_lock(hashtextextended(
      ${`app-submission:${input.appId}:${input.principalId}`}, 0))`;
    if (!(await appRoleFor(tx, input.appId, input.principalId)))
      throw new SubmissionRefused('No such app.', 404);
    const [current] = await tx<{ version_id: string; manifest: AppManifest }[]>`select
        v.id as version_id, v.manifest from app a join app_version v on v.id = a.current_version_id
      where a.id = ${input.appId}`;
    if (!current) throw new SubmissionRefused('No such app.', 404);
    const declared = Object.hasOwn(current.manifest.collections, input.collection)
      ? current.manifest.collections[input.collection]
      : undefined;
    if (!declared)
      throw new SubmissionRefused('This app does not collect responses under that name.', 400);
    const limit = Math.min(declared.max_bytes, APP_LIMITS.max_collection_record_bytes);
    if (size > limit)
      throw new SubmissionRefused(`A response here is at most ${limit} bytes.`, 413);
    const [recent] = await tx<{ count: number }[]>`select count(*)::int as count
      from app_submission where app_id = ${input.appId} and principal_id = ${input.principalId}
        and created_at > now() - interval '1 minute'`;
    if ((recent?.count ?? 0) >= APP_LIMITS.submissions_per_minute)
      throw new SubmissionRefused('Too many responses in the last minute. Try again shortly.', 429);
    const [mine] = await tx<{ count: number }[]>`select count(*)::int as count
      from app_submission where app_id = ${input.appId} and principal_id = ${input.principalId}
        and deleted_at is null`;
    if ((mine?.count ?? 0) >= APP_LIMITS.max_submissions_per_person)
      throw new SubmissionRefused(
        'This app holds as many of your responses as it keeps from one person.',
        429,
      );
    const [kept] = await tx<{ count: number }[]>`select count(*)::int as count
      from app_submission where app_id = ${input.appId} and deleted_at is null`;
    if ((kept?.count ?? 0) >= APP_LIMITS.max_submissions_per_app)
      throw new SubmissionRefused(
        'This app holds as many responses as it can. Its managers can delete some.',
        429,
      );
    const id = recordId('asub');
    const [row] = await tx<{ created_at: Date }[]>`insert into app_submission
        (id, app_id, version_id, collection, principal_id, data, size)
      values (${id}, ${input.appId}, ${current.version_id}, ${input.collection},
        ${input.principalId}, ${JSON.stringify(input.record)}::jsonb, ${size})
      returning created_at`;
    return { id, created_at: new Date(row?.created_at ?? Date.now()).toISOString() };
  });
}

type SubmissionRow = {
  id: string;
  collection: string;
  version_id: string;
  principal_id: string | null;
  email: string | null;
  data: JsonObject;
  created_at: Date;
};

/** An app's responses, newest first, a page at a time. */
export async function listSubmissions(
  q: Sql | TransactionSql,
  appId: string,
  options: { collection?: string | null; before?: string | null; limit?: number } = {},
): Promise<{ submissions: AppSubmission[]; next_before: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, APP_LIMITS.max_submission_page));
  const rows = await q<SubmissionRow[]>`select s.id, s.collection, s.version_id,
      s.principal_id, p.email, s.data, s.created_at
    from app_submission s left join principal p on p.id = s.principal_id
    where s.app_id = ${appId} and s.deleted_at is null
      and (${options.collection ?? null}::text is null or s.collection = ${options.collection ?? null})
      and (${options.before ?? null}::text is null or s.id < ${options.before ?? null})
    order by s.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    submissions: page.map((row) => ({
      id: row.id,
      collection: row.collection,
      version_id: row.version_id,
      by: row.principal_id && row.email ? { id: row.principal_id, email: row.email } : null,
      data: row.data,
      created_at: new Date(row.created_at).toISOString(),
    })),
    next_before: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Remove one response's contents. False when the app has no such response. */
export async function deleteSubmission(
  sql: Sql,
  appId: string,
  submissionId: string,
  by: string,
): Promise<boolean> {
  const rows = await sql`update app_submission
    set data = '{}'::jsonb, size = 0, deleted_at = now(), deleted_by = ${by}
    where id = ${submissionId} and app_id = ${appId} and deleted_at is null
    returning id`;
  return rows.length > 0;
}

/** Remove the contents of every response one person sent an app. How many there were. */
export async function deleteSubmissionsFrom(
  sql: Sql,
  appId: string,
  principalId: string,
  by: string,
): Promise<number> {
  const rows = await sql`update app_submission
    set data = '{}'::jsonb, size = 0, deleted_at = now(), deleted_by = ${by}
    where app_id = ${appId} and principal_id = ${principalId} and deleted_at is null
    returning id`;
  return rows.length;
}
