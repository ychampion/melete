/**
 * Auto-review: the step between an agent's proposed action and the person.
 *
 * Every action that would ask the person is put in one of three tiers:
 *
 * - `sandbox`: work in the agent's own workspace (commands, files, its own
 *   browser, drafts). A fixed rule approves it when the person allows it.
 * - `reviewable`: a reversible or low-impact change outside the sandbox. An
 *   independent reviewer judges it, and it goes ahead only when the reviewer
 *   approves at low risk and the person has switched that class on.
 * - `apps`: publishing an app, a new version of one, or going back to an
 *   earlier version, through Melete's own Apps connection, when nobody new can
 *   open it, its code opens no direct connections and it shows no data its
 *   viewers do not see now. A fixed rule approves it when the person allows
 *   it; each is undone by going back to the version before. Any of those risks
 *   puts it in the person's tier, with the reason.
 * - `person`: anything that spends, sends or publishes beyond undo, deletes,
 *   carries credentials, or rests on a recipient, destination or amount the
 *   person never confirmed. It always asks. The reviewer is never consulted.
 *
 * The tier is a pure function of the tool, the payload and where its values
 * came from, so a test pins every boundary, and the broker recomputes it at
 * admission rather than trusting what the proposal decided.
 */
import {
  type ActionReview,
  type ApprovalSettings,
  type AutoReviewClass,
  approvalSettings,
  type ConnectorTool,
  DEFAULT_APPROVAL_SETTINGS,
  type JsonObject,
  type JsonValue,
  type OriginWarning,
} from '@melete/contracts';
import { isEgressTool } from '../egress/adapters/types.ts';
import { labelsIn, type RoomAuthority, roomAuthorityOf } from '../rooms/approvals.ts';
import { appendEvent, type Query, recordId } from './records.ts';
import type { Reviewer, ReviewInput, ReviewVerdict } from './reviewer.ts';
import { collectOriginFields, type TrustResolver } from './trust.ts';

export type ReviewTier = 'sandbox' | 'apps' | 'reviewable' | 'person';
export type TierDecision = {
  tier: ReviewTier;
  /** The switch that governs it; null for the person's tier. */
  actionClass: AutoReviewClass | null;
  /** Why, in the person's words. */
  reason: string;
};

export type AutoReviewOptions = {
  /** Null when the installation runs no reviewer: reviewable actions ask. */
  reviewer: Reviewer | null;
  /** How long one review may take. */
  timeoutMs?: number;
  /** Reviews one space may ask for in an hour. */
  hourlyLimit?: number;
  /** Reviewer escalations in a row that stop reviewing a job. */
  breakerRun?: number;
};
export const AUTO_REVIEW_DEFAULTS = { timeoutMs: 12_000, hourlyLimit: 60, breakerRun: 3 };

/** Providers whose writes land only in the agent's own workspace. */
const SANDBOX_PROVIDERS = new Set(['exec', 'sandbox', 'files']);

/**
 * A file saved into, moved into or moved out of the person's own Files (the
 * space's `artifacts` area). The files tools also reach the agent's own
 * workspace (`work`, the default), which is sandbox work; the person's Files
 * are not. A new file there stays in their space and is not asked about (the
 * files connector says so through `staysInSpace`); anything else that changes
 * them is theirs to agree to, like a change in a connected app.
 */
export function changesPersonFiles(name: string, payload: JsonObject): boolean {
  if (name === 'files.write') return payload.area === 'artifacts';
  if (name === 'files.move') return payload.area === 'artifacts' || payload.to_area === 'artifacts';
  return false;
}
/** The agent's own browser: filling, clicking and choosing. Submitting is `browser.submit`. */
const SANDBOX_BROWSER = new Set(['browser.fill', 'browser.click', 'browser.select']);
/** A draft in the person's own mailbox, and discarding one. */
const DRAFT_KINDS = new Set(['email.draft', 'email.discard']);
/** External writes that land on the person's own calendar and carry no guest. */
const OWN_CALENDAR = new Set(['calendar.create', 'calendar.update']);
/**
 * Writes that change an event which already exists. The event may have guests
 * the payload never names (a person can add them in the calendar itself), and
 * changing it notifies them, so it only counts as the person's own when the
 * calendar says it has none.
 */
export const CHANGES_EXISTING_EVENT = new Set(['calendar.update']);

/**
 * Publishing through Melete's own Apps connection. Its connector binds, before
 * anyone is asked, `risks`: why this one should be the person's to decide (new
 * people could open it, its code opens direct connections, it shows data its
 * viewers do not see now). The connector re-checks them at admission and at
 * dispatch, and refuses one that gained a risk since.
 */
const APPS_PROVIDER = 'apps';
const APP_PUBLISHING = new Set(['apps.publish', 'apps.rollback']);

/** Why an app publish or rollback asks, as bound into its payload; null when it was never checked. */
export function appRisks(payload: JsonObject): string[] | null {
  const risks = payload.risks;
  if (!Array.isArray(risks) || !risks.every((risk) => typeof risk === 'string')) return null;
  const found = risks as string[];
  // The connection warning is bound on its own as well; either one asks.
  const connecting = Array.isArray(payload.opens_connections) && payload.opens_connections.length;
  return connecting && !found.length
    ? ['Its code can open direct connections to other servers (WebRTC).']
    : found;
}

const DESTRUCTIVE =
  /(?:^|[._-])(?:delete|remove|destroy|drop|purge|erase|trash|wipe|revoke|unshare|uninstall)(?:$|[._-])/i;
const CREDENTIAL_KEY =
  /^(?:.*[_-])?(?:password|passphrase|passcode|secret|token|access_token|refresh_token|api_?key|credentials?|private_key|otp|cvv|cvc|card_?number|ssn)(?:[_-].*)?$/i;
const CREDENTIAL_LABEL =
  /\b(?:password|passcode|passphrase|secret|token|api key|card number|credit card|cvv|cvc|security code|one[- ]time|verification code|otp|pin|ssn|social security)\b/i;
const GUEST_FIELDS = /^(?:attendees?|guests?|invitees?|to|cc|bcc|recipients?|participants?)$/i;

/** A camel- or Pascal-case name with its words split, so `deleteIssue` reads as `delete_Issue`. */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');

function keys(value: JsonValue, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keys(item, found);
  else if (value && typeof value === 'object')
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      keys(nested, found);
    }
  return found;
}

function carriesCredentials(kind: string, payload: JsonObject): boolean {
  if (keys(payload).some((key) => CREDENTIAL_KEY.test(words(key)))) return true;
  // The browser names a field by its visible label, which is where a password shows.
  if (kind === 'browser.fill' && typeof payload.label === 'string')
    return CREDENTIAL_LABEL.test(payload.label);
  return false;
}

/**
 * Which tier an action is in. `doubts` are the recipient, destination and
 * amount values whose origin is not the person or a verified app.
 * `existingGuests` is how many guests the event a change rewrites has now, as
 * the calendar reported it; left out or null, nobody could say, and a change
 * to an existing event then stays with the person.
 */
export function reviewTier(input: {
  tool: Pick<ConnectorTool, 'name' | 'effect_class' | 'requires_approval' | 'execution'>;
  provider: string;
  payload: JsonObject;
  doubts: readonly OriginWarning[];
  existingGuests?: number | null;
}): TierDecision {
  const { tool, provider, payload, doubts } = input;
  const person = (reason: string): TierDecision => ({ tier: 'person', actionClass: null, reason });
  if (tool.effect_class === 'spend') return person('It spends money.');
  // A change a command in the agent's computer makes with a connected account
  // leaves Melete with the person's own identity, and always asks.
  if (isEgressTool(tool.name))
    return person(
      payload.destructive === true
        ? 'It deletes or overwrites something with your account, from a command in the agent’s computer.'
        : 'It changes something with your account, from a command in the agent’s computer.',
    );
  if (carriesCredentials(tool.name, payload))
    return person('It carries a password, key or payment detail.');
  if (DESTRUCTIVE.test(words(tool.name))) return person('It deletes or removes something.');
  if (doubts.length > 0)
    return person(
      'A recipient, destination or amount in it did not come from you or a connected app you verified.',
    );
  if (provider === APPS_PROVIDER && APP_PUBLISHING.has(tool.name)) {
    const risks = appRisks(payload);
    if (risks === null) return person('Melete could not check who this app would reach.');
    if (risks.length) return person(risks.join(' '));
    return {
      tier: 'apps',
      actionClass: 'apps',
      reason:
        tool.name === 'apps.rollback'
          ? 'It goes back to an earlier version for the same viewers, and shows them no new data.'
          : 'It publishes to the same people as now, opens no direct connections, and shows no new data.',
    };
  }
  if (tool.effect_class === 'read' && !tool.requires_approval)
    return { tier: 'sandbox', actionClass: 'sandbox', reason: 'It only reads.' };
  if (changesPersonFiles(tool.name, payload))
    return {
      tier: 'reviewable',
      actionClass: 'app_changes',
      reason: 'It changes your own Files, which can be put back.',
    };
  if (
    tool.effect_class === 'write_reversible' &&
    !tool.requires_approval &&
    (tool.execution === 'in_cell' ||
      SANDBOX_PROVIDERS.has(provider) ||
      SANDBOX_BROWSER.has(tool.name) ||
      DRAFT_KINDS.has(tool.name))
  )
    return {
      tier: 'sandbox',
      actionClass: 'sandbox',
      reason: "It runs inside the agent's own workspace.",
    };
  if (tool.effect_class === 'write_reversible')
    return {
      tier: 'reviewable',
      actionClass: 'app_changes',
      reason: 'It is a change in a connected app that can be reversed.',
    };
  if (
    tool.effect_class === 'write_external' &&
    OWN_CALENDAR.has(tool.name) &&
    !keys(payload).some((key) => GUEST_FIELDS.test(key))
  ) {
    if (CHANGES_EXISTING_EVENT.has(tool.name) && input.existingGuests !== 0)
      return person(
        typeof input.existingGuests === 'number'
          ? 'It changes a meeting that has guests, and they would be told.'
          : 'Melete could not check whether this event has guests.',
      );
    return {
      tier: 'reviewable',
      actionClass: 'calendar',
      reason: 'It changes an event on your own calendar, with no guests.',
    };
  }
  return person('It sends or publishes outside Melete and cannot be taken back.');
}

/** The fields whose origin decides the tier: who, where and how much. */
export const deciding = (payload: JsonObject, kind: string) =>
  collectOriginFields(payload, kind).filter((field) => field.category !== 'resource');

export async function loadApprovalSettings(tx: Query, spaceId: string): Promise<ApprovalSettings> {
  const [row] = await tx`select mode, classes from approval_review_policy
    where space_id = ${spaceId}`;
  if (!row) return DEFAULT_APPROVAL_SETTINGS;
  const stored = (row.classes ?? {}) as Record<string, unknown>;
  const parsed = approvalSettings.safeParse({
    mode: row.mode,
    classes: {
      ...DEFAULT_APPROVAL_SETTINGS.classes,
      // A row saved before publishing had its own switch follows the person's
      // sandbox switch: someone who chose to be asked more is not asked less.
      ...(typeof stored.sandbox === 'boolean' && !Object.hasOwn(stored, 'apps')
        ? { apps: stored.sandbox }
        : {}),
      ...Object.fromEntries(
        Object.entries(stored).filter(
          ([key, value]) => key in DEFAULT_APPROVAL_SETTINGS.classes && typeof value === 'boolean',
        ),
      ),
    },
  });
  // A row that no longer reads is the most cautious setting, never the default.
  return parsed.success
    ? parsed.data
    : {
        mode: 'ask',
        classes: { sandbox: false, calendar: false, app_changes: false, apps: false },
      };
}

export async function saveApprovalSettings(
  tx: Query,
  spaceId: string,
  input: unknown,
): Promise<ApprovalSettings> {
  // A switch the caller does not name keeps its stored value, so a client
  // written before a class existed cannot turn it back to its default.
  const value = input as { classes?: unknown } | null;
  const named =
    value && typeof value === 'object' && value.classes && typeof value.classes === 'object'
      ? (value.classes as Record<string, unknown>)
      : null;
  const stored = named ? await loadApprovalSettings(tx, spaceId) : null;
  const settings = approvalSettings.parse(
    named && stored
      ? {
          ...value,
          classes: { ...stored.classes, ...named },
        }
      : input,
  );
  await tx`insert into approval_review_policy (space_id, mode, classes, updated_at)
    values (${spaceId}, ${settings.mode}, ${JSON.stringify(settings.classes)}::jsonb, now())
    on conflict (space_id) do update set mode = excluded.mode, classes = excluded.classes,
      updated_at = now()`;
  return settings;
}

/**
 * Why this job's actions should not be reviewed right now, or null. A space
 * past its hourly reviews, or a job whose last few reviews all escalated,
 * goes to the person: a looping agent cannot grind the reviewer until it says yes.
 */
export async function reviewLimit(
  tx: Query,
  input: { space_id: string; job_id: string },
  options: Required<Omit<AutoReviewOptions, 'reviewer'>>,
): Promise<string | null> {
  // One space's count is taken under one lock, held until the proposal's
  // transaction commits. A review's own record is only written once the
  // reviewer answers, after that lock is gone, so the count also takes every
  // review already started and not yet recorded: the `auto_review_started`
  // notice is written under this lock, in the same transaction. Two proposals
  // therefore cannot both take the last review, however many run at once.
  await tx`select pg_advisory_xact_lock(hashtext(${`action-review:${input.space_id}`}))`;
  const [used] = await tx`select
      (select count(*) from action_review
        where space_id = ${input.space_id} and decided_by = 'reviewer'
          and created_at > clock_timestamp() - interval '1 hour')
      + (select count(*) from action a join job j on j.id = a.job_id
        where j.space_id = ${input.space_id} and a.status = 'proposed'
          and not exists (select 1 from action_review r where r.action_id = a.id)
          and exists (select 1 from event e
            where e.job_id = a.job_id and e.type = 'notice'
              and e.payload->>'kind' = 'auto_review_started' and e.payload->>'action_id' = a.id
              and e.created_at > clock_timestamp() - interval '1 hour'))
      as reviews`;
  if (Number(used?.reviews ?? 0) >= options.hourlyLimit)
    return 'Auto-review has reached its limit for this hour, so this one is yours to decide.';
  if (options.breakerRun > 0) {
    const recent = await tx`select outcome from action_review
      where job_id = ${input.job_id} and decided_by = 'reviewer'
      order by created_at desc, id desc limit ${options.breakerRun}`;
    if (recent.length >= options.breakerRun && recent.every((row) => row.outcome === 'escalated'))
      return 'Several recent actions in this task were sent to you, so auto-review stepped back.';
  }
  return null;
}

/** What the reviewer sees: the action, the person's words, and where the values came from. */
export async function reviewInput(
  tx: Query,
  input: {
    job: { id: string; space_id: string };
    action: {
      connection_id: string;
      kind: string;
      effect_class: string;
      canonical_payload: JsonObject;
    };
    tool: Pick<ConnectorTool, 'name' | 'description' | 'effect_class'>;
    app: string;
    resolver: TrustResolver;
  },
): Promise<ReviewInput> {
  const { job, action, tool } = input;
  const [row] = await tx`select objective, experience_parent_id from job where id = ${job.id}`;
  const jobs = [job.id, ...(row?.experience_parent_id ? [String(row.experience_parent_id)] : [])];
  const room = await roomAuthorityOf(tx, job.id);
  const { recent, instruction } = room
    ? await roomConversation(tx, room, jobs)
    : await ownConversation(tx, jobs);
  const fields = collectOriginFields(action.canonical_payload, action.kind);
  const resolved = fields.length
    ? await input.resolver.resolve(tx, {
        space_id: job.space_id,
        job_id: job.id,
        connection_id: action.connection_id,
        kind: action.kind,
        effect_class: action.effect_class,
        canonical_payload: action.canonical_payload,
        fields,
      })
    : [];
  const byPath = new Map(resolved.map((entry) => [entry.path, entry]));
  return {
    action: {
      tool: tool.name,
      description: tool.description,
      effect: tool.effect_class,
      app: input.app,
      payload: action.canonical_payload,
    },
    instruction: instruction ?? String(row?.objective ?? ''),
    recent,
    origins: fields.map((field) => {
      const known = byPath.get(field.path);
      return {
        field: field.path,
        value: field.value,
        trust: known?.origin_trust ?? 'unknown',
        note: known?.description ?? 'Melete cannot say where this value came from.',
      };
    }),
  };
}

type Conversation = { recent: ReviewInput['recent']; instruction: string | null };

/** A person's own conversation: every message in it is theirs. */
async function ownConversation(tx: Query, jobs: string[]): Promise<Conversation> {
  const messages = await tx`select payload from event
    where job_id = any(${jobs}) and type = 'notice'
      and payload->>'kind' in ('user_message', 'experience_say')
    order by seq desc limit 6`;
  const recent = messages
    .reverse()
    .map((message) => ({
      // An option the person picked was written by the assistant.
      from:
        message.payload.kind === 'user_message' && !message.payload.chosen
          ? ('person' as const)
          : ('assistant' as const),
      text: String(message.payload.text ?? ''),
    }))
    .filter((entry) => entry.text);
  const lastAsked = [...recent].reverse().find((entry) => entry.from === 'person');
  return { recent, instruction: lastAsked?.text ?? null };
}

/**
 * A room's request. The instruction is what the person who asked said in it,
 * every message of theirs, and only theirs. What other people said in the
 * thread is shown as theirs, by name, and never as the instruction.
 */
async function roomConversation(
  tx: Query,
  room: RoomAuthority,
  jobs: string[],
): Promise<Conversation> {
  const asker = room.requestedBy ?? '';
  const own = await tx`select payload->>'text' as text from event
    where job_id = ${room.requestJobId} and type = 'notice'
      and payload->>'kind' = 'user_message' and payload->>'principal_id' = ${asker}
    order by seq`;
  const said = own.map((entry) => String(entry.text ?? '')).filter(Boolean);
  const events = await tx`select payload, created_at from event
    where job_id = any(${[...new Set([...jobs, room.requestJobId])]}) and type = 'notice'
      and payload->>'kind' in ('user_message', 'experience_say')
    order by seq desc limit 6`;
  const others = room.threadId
    ? await tx`select author_principal_id, text, created_at from room_message
        where thread_id = ${room.threadId} and space_id = ${room.spaceId}
          and redacted_at is null and author_principal_id <> ${asker}
        order by created_at desc, id desc limit 6`
    : [];
  const speakers = [
    ...others.map((entry) => String(entry.author_principal_id)),
    ...events.flatMap((entry) =>
      entry.payload.kind === 'user_message' && entry.payload.principal_id !== asker
        ? [String(entry.payload.principal_id ?? '')]
        : [],
    ),
  ];
  const names = await labelsIn(tx, room.spaceId, speakers);
  const other = (id: string) => ({
    from: 'other_member' as const,
    name: names.get(id) ?? 'Someone else in the room',
  });
  const entries = [
    ...events.map((entry) => ({
      at: new Date(entry.created_at).getTime(),
      ...(entry.payload.kind !== 'user_message'
        ? { from: 'assistant' as const }
        : entry.payload.principal_id === asker
          ? { from: 'person' as const }
          : other(String(entry.payload.principal_id ?? ''))),
      text: String(entry.payload.text ?? ''),
    })),
    ...others.map((entry) => ({
      at: new Date(entry.created_at).getTime(),
      ...other(String(entry.author_principal_id)),
      text: String(entry.text ?? ''),
    })),
  ]
    .filter((entry) => entry.text)
    .sort((a, b) => a.at - b.at)
    .slice(-6);
  return {
    recent: entries.map(({ at: _at, ...entry }) => entry),
    instruction: said.length ? said.join('\n\n') : null,
  };
}

export type ReviewRecord = {
  action_id: string;
  job_id: string;
  space_id: string;
  attempt_id: string | null;
  tier: ReviewTier;
  action_class: AutoReviewClass | null;
  decided_by: 'policy' | 'reviewer';
  outcome: 'approved' | 'escalated';
  risk: 'low' | 'medium' | 'high' | null;
  reason: string;
  model?: string | null;
  latency_ms?: number | null;
};

/**
 * Write the decision and its event in the caller's transaction. One decision
 * per action: a second call for the same action changes nothing.
 */
export async function recordReview(tx: Query, record: ReviewRecord): Promise<void> {
  const id = recordId('rvw');
  const [row] = await tx`insert into action_review (id, action_id, job_id, space_id, tier,
      action_class, decided_by, outcome, risk, reason, model, latency_ms)
    values (${id}, ${record.action_id}, ${record.job_id}, ${record.space_id}, ${record.tier},
      ${record.action_class}, ${record.decided_by}, ${record.outcome}, ${record.risk},
      ${record.reason}, ${record.model ?? null}, ${record.latency_ms ?? null})
    on conflict (action_id) do nothing returning id`;
  if (!row) return;
  await appendEvent(
    tx,
    record.job_id,
    record.attempt_id,
    'notice',
    {
      kind: 'auto_review',
      action_id: record.action_id,
      review_id: id,
      tier: record.tier,
      action_class: record.action_class,
      decided_by: record.decided_by,
      outcome: record.outcome,
      risk: record.risk,
      reason: record.reason,
      model: record.model ?? null,
    },
    `auto_review:${record.action_id}`,
  );
}

/** A stored decision as the person reads it. */
export function reviewView(row: {
  decided_by: unknown;
  outcome: unknown;
  risk: unknown;
  reason: unknown;
  created_at: unknown;
}): ActionReview {
  return {
    outcome: row.outcome === 'approved' ? 'auto_approved' : 'escalated',
    by: row.decided_by === 'reviewer' ? 'reviewer' : 'policy',
    reason: String(row.reason),
    risk: row.risk === 'low' || row.risk === 'medium' || row.risk === 'high' ? row.risk : null,
    reviewed_at: new Date(row.created_at as string | Date).toISOString(),
  };
}

/** The decision recorded for an action, as the person reads it, or null. */
export async function actionReviewView(tx: Query, actionId: string): Promise<ActionReview | null> {
  const [row] = await tx`select decided_by, outcome, risk, reason, created_at from action_review
    where action_id = ${actionId}`;
  return row ? reviewView(row as Parameters<typeof reviewView>[0]) : null;
}

/** Whether a verdict lets the action go ahead: an explicit approval at low risk, nothing less. */
export const reviewerApproves = (verdict: ReviewVerdict) =>
  verdict.verdict === 'approve' && verdict.risk === 'low';

/** The reason an escalation carries, in the person's words. */
export function escalationReason(verdict: ReviewVerdict): string {
  if (verdict.verdict === 'none') return verdict.reason;
  if (verdict.verdict === 'approve')
    return `The reviewer rated it ${verdict.risk} risk: ${verdict.reason}`;
  return verdict.reason;
}
