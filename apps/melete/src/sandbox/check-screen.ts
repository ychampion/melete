/**
 * Whether a check that a person is there, on the computer's screen, belongs to
 * the work that met it. The chats of a space can share one computer, and a
 * page another chat left on it stays in front until something replaces it. A
 * check on that page is not this work's: handing it over would stop the work
 * at a site it never visited. So a check counts unless the screen shows
 * exactly the page another work's step last left on this computer and this
 * work has not been to that site itself. The work told so opens its own page,
 * and a check there is handed over as usual.
 *
 * Steps are matched to a computer by `computer_id` where a chat has a display
 * of its own, else by the sandbox the sessions of a workspace share.
 */
import type { JsonValue } from '@melete/contracts';
import type { Sql } from 'postgres';
import { serviceOfUrl } from '../paths/services.ts';

/** Said to the agent when the screen shows a check that another chat's work left there. */
export const CHECK_LEFT_BY_OTHER_WORK =
  'The page in front on the computer is one that other work left there, and it shows a check that a person is there. It is not this work’s page. Open the page this work needs with computer.open and go on from there.';

/** One step on the computer, as far as this decision reads it. */
export type ScreenStep = {
  kind: string;
  payload: Record<string, unknown>;
  /** The address the screen showed after the step, when its receipt says. */
  url: string | null;
};

/** The addresses a step opened: a `computer.open`'s, or each open in a batch. */
function opened(step: Pick<ScreenStep, 'kind' | 'payload'>): string[] {
  if (step.kind === 'computer.open')
    return typeof step.payload.url === 'string' ? [step.payload.url] : [];
  if (step.kind !== 'computer.batch' || !Array.isArray(step.payload.actions)) return [];
  return step.payload.actions.flatMap((each) => {
    const one = each as Record<string, unknown> | null;
    return one && one.action === 'open' && typeof one.url === 'string' ? [one.url] : [];
  });
}

/**
 * The decision, from what is known: the address on the screen, the step that
 * met the check, this work's earlier steps on this computer, and the address
 * another work's latest step there left on the screen (null when none did).
 */
export function checkIsThisWorks(input: {
  screenUrl: string | null;
  current: Pick<ScreenStep, 'kind' | 'payload'>;
  own: ScreenStep[];
  leftByOther: string | null;
}): boolean {
  const { screenUrl, leftByOther } = input;
  // Nothing to tell the page apart by, or nobody else left a page here: the check is this work's.
  if (!screenUrl || !leftByOther || screenUrl !== leftByOther) return true;
  const service = serviceOfUrl(screenUrl);
  if (!service) return true;
  const visited = [
    ...opened(input.current),
    ...input.own.flatMap((step) => [...opened(step), ...(step.url ? [step.url] : [])]),
  ];
  return visited.some((url) => serviceOfUrl(url) === service);
}

/**
 * The same, read from the job's steps: whether the check on `screen` is the
 * work's to hand over. A screen without an address counts as the work's.
 */
export async function screenCheckIsThisWorks(
  sql: Sql,
  input: {
    jobId: string;
    connectionId: string;
    /** The chat's display (`computer_id`) when it has one, else the shared sandbox. */
    computerId: string;
    current: Pick<ScreenStep, 'kind' | 'payload'>;
    screen: JsonValue;
  },
): Promise<boolean> {
  const screen = input.screen as Record<string, JsonValue> | null;
  const screenUrl = screen && typeof screen.url === 'string' ? screen.url : null;
  if (!screenUrl) return true;
  const [other] = await sql`select receipt->'detail'->'screen_text'->>'url' as url from action
    where connection_id = ${input.connectionId} and job_id <> ${input.jobId}
      and status = 'succeeded' and kind like 'computer.%'
      and coalesce(receipt->'detail'->>'computer_id', receipt->'detail'->>'sandbox_id')
        = ${input.computerId}
    order by created_at desc, id desc limit 1`;
  const leftByOther = typeof other?.url === 'string' ? other.url : null;
  if (leftByOther !== screenUrl) return true;
  const own = await sql`select kind, canonical_payload,
      receipt->'detail'->'screen_text'->>'url' as url from action
    where job_id = ${input.jobId} and status = 'succeeded' and kind like 'computer.%'
      and coalesce(receipt->'detail'->>'computer_id', receipt->'detail'->>'sandbox_id')
        = ${input.computerId}
    order by created_at desc, id desc limit 50`;
  return checkIsThisWorks({
    screenUrl,
    current: input.current,
    own: own.map((row) => ({
      kind: String(row.kind),
      payload: (row.canonical_payload ?? {}) as Record<string, unknown>,
      url: typeof row.url === 'string' ? row.url : null,
    })),
    leftByOther,
  });
}
