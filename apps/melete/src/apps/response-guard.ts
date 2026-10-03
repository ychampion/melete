/**
 * The one rule responses add to what the agent may do without asking. Kept
 * apart so the broker reads it without the rest of the apps module.
 */
import type { JsonObject } from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';

/**
 * Tools that can change a conversation's files: the two that name a path, and
 * every command that runs where those files are (the code runner and the
 * agent's computer). A command on the person's own device runs elsewhere.
 */
const WORKSPACE_WRITES = new Set([
  'files.write',
  'files.move',
  'exec.run',
  'exec.python',
  'terminal.run',
]);

/**
 * Whether this action must ask the person because the conversation read
 * responses to an app and the action may change a file an app shows. A
 * response is a viewer's text; a write steered by it to a file other viewers
 * see would reach them without anyone deciding it. A named path asks only when
 * an app binds it; a command, which may write anything, asks whenever an app
 * reads any file of this conversation.
 */
export async function asksAfterResponses(
  tx: Sql | TransactionSql,
  jobId: string,
  action: { kind: string; canonical_payload: JsonObject },
): Promise<boolean> {
  if (!WORKSPACE_WRITES.has(action.kind)) return false;
  const payload = action.canonical_payload;
  let path: string | null = null;
  if (action.kind === 'files.write' || action.kind === 'files.move') {
    const area = action.kind === 'files.move' ? payload.to_area : payload.area;
    if (area !== undefined && area !== 'work') return false;
    const target = action.kind === 'files.move' ? payload.to_path : payload.path;
    if (typeof target !== 'string') return false;
    path = target
      .split(/[\\/]+/)
      .filter((part) => part && part !== '.')
      .join('/');
  }
  const [row] = await tx<{ asks: boolean }[]>`select
      exists (select 1 from action where job_id = ${jobId} and kind = 'apps.read_submissions'
        and status = 'succeeded')
      and exists (select 1 from app a join app_version v on v.id = a.current_version_id,
          jsonb_each(v.manifest -> 'data') d
        where a.status = 'active' and d.value ->> 'source_job_id' = ${jobId}
          and (${path}::text is null or d.value ->> 'path' = ${path})) as asks`;
  return row?.asks === true;
}
