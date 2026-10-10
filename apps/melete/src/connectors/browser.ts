import type {
  Action,
  ConnectorManifest,
  HandOffReason,
  JsonObject,
  JsonValue,
  ReadBack,
} from '@melete/contracts';
import { jsonObject, jsonValue } from '@melete/contracts';
import { z } from 'zod';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { blockerOf, type PageSeen, readBack, type SentForm } from '../paths/read-back.ts';
import { serviceOfUrl } from '../paths/services.ts';
import type { BrowserArtifactSink } from '../workers/browser/artifacts.ts';
import type { BrowserWorkerClient } from '../workers/browser/client.ts';
import { planBrowserRecipe, recipePlanDetail } from '../workers/browser/planning.ts';
import type { BrowserRecipeStore } from '../workers/browser/recipes.ts';
import { REDACTED, redactSecretText } from '../workers/browser/redact.ts';
import { type BrowserSessionService, browserInputReasons } from '../workers/browser/routes.ts';
import { BrowserFault } from '../workers/browser/sessions.ts';
import { sensitiveName } from '../workers/browser/visible.ts';
import type { Connector, ConnectorContext } from './types.ts';
import type { PublicReadPolicy } from './web.ts';

const text = { type: 'string', minLength: 1, maxLength: 8000 };
/**
 * A job's browser tools act on that job's current browser session, opened on first use. The id
 * and epoch are optional: they come back in every result, for a caller that wants to name them.
 */
const sessionProperties = {
  session_id: {
    type: 'string',
    minLength: 1,
    description:
      "Optional. Leave it out to use this job's current browser session; pass one only as returned by an earlier browser result.",
  },
  control_epoch: {
    type: 'integer',
    minimum: 0,
    description: 'Optional. The control_epoch returned with session_id.',
  },
};
const observationProperty = {
  ...text,
  description:
    'Optional. The id of the latest observation; pass it to repeat an earlier identical step.',
};
const schema = (properties: Record<string, JsonValue>, required: string[]) => ({
  type: 'object',
  properties: { ...sessionProperties, ...properties },
  required,
  additionalProperties: false,
});
const fieldValues = { type: 'array', items: { type: 'string' } };
const intentSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri' },
    method: { type: 'string', enum: ['POST'] },
    role: text,
    name: text,
    form_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    body_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    fields: {
      type: 'object',
      // A name the form sends more than once, as a checkbox group does, has a list of values.
      additionalProperties: { anyOf: [{ type: 'string' }, fieldValues] },
    },
  },
  required: ['url', 'method', 'role', 'name', 'form_hash', 'body_sha256', 'fields'],
  additionalProperties: false,
};

const definitions: Array<{
  name: string;
  description: string;
  effect: 'read' | 'write_reversible' | 'write_external';
  properties: Record<string, JsonValue>;
  required: string[];
}> = [
  {
    name: 'open',
    description:
      "Open an allowed HTTP(S) URL in this job's browser, starting the browser if needed. Returns an observation of the page.",
    effect: 'read',
    properties: { url: { type: 'string', format: 'uri' }, after_observation: observationProperty },
    required: ['url'],
  },
  {
    name: 'observe',
    description:
      "Look at the current page in this job's browser; {} is enough. To look again after a change, pass after_observation equal to the previous observation id. Optional recipe_id and recipe_version check a stored recipe against the visible schema. Returns artifact handles and submit intents.",
    effect: 'read',
    properties: {
      after_observation: observationProperty,
      recipe_id: { type: 'string', minLength: 1, maxLength: 120 },
      recipe_version: { type: 'integer', minimum: 1 },
    },
    required: [],
  },
  {
    name: 'fill',
    description:
      'Fill one visible field by exact accessible label. To repeat an earlier edit, observe again and pass that observation id as after_observation. Authentication fields require human control. Returns an observation of the page after it, with its submit intents.',
    effect: 'write_reversible',
    properties: {
      label: text,
      value: { type: 'string', maxLength: 8000 },
      after_observation: observationProperty,
    },
    required: ['label', 'value'],
  },
  {
    name: 'click',
    description:
      'Click one reversible control by exact role and name. A link opens its address, with the same checks as browser.open. To repeat an earlier click, observe again and pass that observation id as after_observation. Consequential controls require browser.submit. Returns an observation of the page after it.',
    effect: 'write_reversible',
    properties: { role: text, name: text, after_observation: observationProperty },
    required: ['role', 'name'],
  },
  {
    name: 'select',
    description:
      'Choose an option in a visible dropdown. Name the dropdown by its label, accessible name, placeholder or the text just before it; leave label out when the option is offered by only one dropdown on the page. To repeat an earlier choice, observe again and pass that observation id as after_observation. Returns an observation of the page after it.',
    effect: 'write_reversible',
    properties: { label: text, value: text, after_observation: observationProperty },
    required: ['value'],
  },
  {
    name: 'read',
    description:
      'Read a visible element by selector or accessible role and name. Pass the latest observation id as after_observation to refresh an earlier read.',
    effect: 'read',
    properties: { selector: text, role: text, name: text, after_observation: observationProperty },
    required: [],
  },
  {
    name: 'submit',
    description:
      'Submit exactly one intent from the latest observation, copied whole, including its destination and complete field values. Approval is required unless a standing permission covers it. Where a connected app has a tool for the same action, use that tool instead. The page is read back afterwards, and the same form is not sent again while its outcome is unconfirmed.',
    effect: 'write_external',
    properties: { intent: intentSchema },
    required: ['intent'],
  },
];

export const browserManifest: ConnectorManifest = {
  name: 'browser',
  version: '0.1.0',
  provider: 'web',
  description:
    'Semantic Chromium actions in a separate worker, fenced by service-owned browser control.',
  credentials: [],
  health: true,
  tools: definitions.map((tool) => ({
    name: `browser.${tool.name}`,
    description: tool.description,
    input_schema: {
      ...schema(tool.properties, tool.required),
      ...(tool.name === 'observe'
        ? { dependencies: { recipe_id: ['recipe_version'], recipe_version: ['recipe_id'] } }
        : {}),
    },
    effect_class: tool.effect,
    required_scopes: [`browser.${tool.name}`],
    requires_approval: tool.effect === 'write_external',
    // A submit is checked by reading its page back; nothing else changes anything outside.
    verify: tool.name === 'submit',
  })),
};

const output = z.strictObject({
  session_id: z.string().min(1),
  control_epoch: z.number().int().nonnegative(),
  observation: z
    .strictObject({
      id: z.string().min(1),
      url: z.string(),
      title: z.string().max(1000).optional(),
      tree: z.string().max(4 * 1024 * 1024),
      screenshot: z.string().max(6 * 1024 * 1024),
      schema: jsonValue,
    })
    .optional(),
  result: jsonObject.optional(),
});

const LEAVE_OUT =
  "Leave session_id and control_epoch out to use this job's current browser session.";

/** What the agent is told when the browser moved on under a step and nobody holds it. */
const LOOK_AGAIN =
  'The browser changed since this step was planned, and nobody is holding it now. Look at the page again with browser.observe, then carry on from what it shows.';

/**
 * Whether a person holds the space's browser now, as the worker says. Unknown
 * reads as no: the controller refuses the agent's input while a person holds
 * it, and their takeover parks the job itself.
 */
async function personHolds(worker: BrowserWorkerClient | undefined): Promise<boolean> {
  try {
    return (await worker?.holder())?.control === 'human';
  } catch {
    return false;
  }
}

type Observed = z.infer<typeof output>;

/** What the browser saw, in the shape the read-back reads. */
function pageOf(observed: Observed | null): PageSeen | null {
  const seen = observed?.observation;
  if (!seen) return null;
  const forms = Array.isArray(observed.result?.submit_intents)
    ? (observed.result.submit_intents as JsonValue[]).flatMap((entry) => {
        const form = entry as Record<string, unknown> | null;
        return form && typeof form.form_hash === 'string'
          ? [
              {
                url: String(form.url ?? ''),
                name: String(form.name ?? ''),
                form_hash: form.form_hash,
              },
            ]
          : [];
      })
    : [];
  const status = observed.result?.commit_status;
  return {
    url: seen.url,
    title: seen.title ?? '',
    tree: seen.tree,
    schema: Array.isArray(seen.schema)
      ? (seen.schema as JsonValue[]).flatMap((entry) => {
          const control = entry as Record<string, unknown> | null;
          return control && typeof control.label === 'string'
            ? [
                {
                  label: control.label,
                  role: String(control.role ?? ''),
                  sensitive: control.sensitive === true,
                },
              ]
            : [];
        })
      : [],
    forms,
    status: typeof status === 'number' ? status : null,
    challenge: observed.result?.challenge === true,
  };
}

const sentForm = (payload: JsonObject): SentForm => {
  const intent = (payload.intent ?? {}) as Record<string, unknown>;
  const fields =
    intent.fields && typeof intent.fields === 'object' && !Array.isArray(intent.fields)
      ? Object.fromEntries(
          Object.entries(intent.fields as Record<string, unknown>).flatMap(([name, value]) =>
            typeof value === 'string' ? [[name, value]] : [],
          ),
        )
      : {};
  return {
    url: String(intent.url ?? ''),
    name: String(intent.name ?? ''),
    form_hash: String(intent.form_hash ?? ''),
    fields,
  };
};

/** Field names that carry a token or a secret rather than anything the person said. */
const SECRET_FIELD = /csrf|xsrf|token|nonce|secret|signature|session|captcha|key/i;

/**
 * The values a submit sent, for its receipt, so what is said about it can be
 * checked against what went: empty fields left out, a field that names a token
 * or secret blanked, and the shapes of codes and keys blanked in the rest.
 */
export function submittedFields(sent: SentForm): JsonObject {
  const shown: JsonObject = {};
  for (const [name, value] of Object.entries(sent.fields ?? {}).slice(0, 64)) {
    if (!value.trim()) continue;
    shown[name.slice(0, 120)] =
      SECRET_FIELD.test(name) || sensitiveName.test(name)
        ? REDACTED
        : redactSecretText(value).slice(0, 500);
  }
  return shown;
}

/** The page a sign-in, code or card field is on could not be read: only the person may go on. */
const SENSITIVE_PAGE: Omit<ReadBack, 'looks' | 'url'> = {
  verdict: 'unclear',
  blocker: null,
  evidence: 'The page asks for something only the person types.',
};

/** How long a page is given to settle before it is read a second time. */
export const SECOND_LOOK_MS = 1_500;

/** The sessions this job has held, newest first. Scoped to the job and its space, never wider. */
async function jobSessions(
  tx: Query,
  scope: { space_id: string; job_id: string },
): Promise<Array<{ id: string; control_epoch: number }>> {
  return (await tx`select id, control_epoch from browser_session_binding
    where space_id = ${scope.space_id} and job_id = ${scope.job_id}
    order by updated_at desc, id limit 5`) as unknown as Array<{
    id: string;
    control_epoch: number;
  }>;
}

export function createBrowserConnector(options: {
  sessions: Pick<BrowserSessionService, 'lease' | 'park'> &
    Partial<Pick<BrowserSessionService, 'handOff'>>;
  artifacts: BrowserArtifactSink;
  recipes?: BrowserRecipeStore;
  spaceId?: string;
  /** How long a page that said nothing is given before it is read again. */
  secondLookMs?: number;
  /**
   * The rule `web.fetch` follows for a page outside a job's own list. A job with no list opens
   * public pages when it says so; without one, a job opens only what its list allows.
   */
  publicReads?: PublicReadPolicy;
}): Connector {
  /**
   * Whether this job's browser may open any public page, and if not, why not in plain words.
   * Only a job with no list of its own and outside the public compartment is asked about.
   */
  const publicWeb = async (ctx: ConnectorContext) => {
    if (ctx.constraints.public_compartment || ctx.constraints.allowed_domains.length)
      return { open: false, refusal: null };
    const refusal = options.publicReads
      ? await options.publicReads(undefined, { jobId: ctx.job_id, spaceId: ctx.space_id })
      : 'Only the sites this work was given can be opened.';
    return { open: refusal === null, refusal };
  };
  const lease = async (ctx: ConnectorContext, sessionId?: string) => {
    const reach = await publicWeb(ctx);
    return {
      ...(await options.sessions.lease(ctx, sessionId, { publicWeb: reach.open })),
      refusal: reach.refusal,
    };
  };
  /**
   * Hand the work to the person with a card, or, where nothing can make a
   * card, park it for them as before.
   */
  const handOff = async (
    ctx: ConnectorContext,
    sessionId: string,
    reason: HandOffReason,
    url: string,
    action: Action,
  ) => {
    const service = serviceOfUrl(url) ?? 'this site';
    if (options.sessions.handOff)
      await options.sessions.handOff(
        ctx,
        sessionId,
        { reason, service, action_id: action.kind === 'browser.submit' ? action.id : null },
        action.attempt_id,
      );
    else await options.sessions.park(ctx, sessionId, reason, action.attempt_id);
  };

  /** Read the page again once it has had time to settle. Null when it cannot be read. */
  const lookAgain = async (
    ctx: ConnectorContext,
    sessionId?: string,
  ): Promise<{ page: PageSeen | null; sensitive: boolean; sessionId?: string }> => {
    try {
      const { session, worker } = await lease(ctx, sessionId);
      const looked = output.parse(
        await worker.request('/command', {
          session_id: session.id,
          job_id: ctx.job_id,
          control_epoch: session.control_epoch,
          operation: { kind: 'observe' },
        }),
      );
      if (looked.session_id !== session.id) return { page: null, sensitive: false };
      return { page: pageOf(looked), sensitive: false, sessionId: session.id };
    } catch (error) {
      return {
        page: null,
        sensitive:
          error instanceof BrowserFault && error.reason === 'sensitive_input_require_takeover',
      };
    }
  };

  /**
   * What a submit came to, from the page it ended on: done, not done, or
   * unclear after a second look. The receipt carries what was sent. An unclear
   * page with a check only the person can pass, or after a submit that does
   * one of the risks only the person lets through (it pays, carries
   * credentials, deletes, sends to someone outside or widens who can see
   * something), hands the work to them and leaves the outcome unknown until it
   * is checked, whoever let the submit through. Any other unclear submit is
   * recorded as sent and unconfirmed, and the work goes on.
   */
  const settleSubmit = async (
    action: Action,
    ctx: ConnectorContext,
    sessionId: string,
    first: PageSeen | null,
    detail: JsonObject,
  ) => {
    const sent = sentForm(action.canonical_payload);
    let seen = readBack(sent, first, 1);
    // Whether a page was read at all: a commit whose answer was lost, on a
    // page that cannot be read either, is not a page that said nothing.
    let read = first !== null;
    if (seen.verdict === 'unclear' && !seen.blocker) {
      await Bun.sleep(options.secondLookMs ?? SECOND_LOOK_MS);
      const again = await lookAgain(ctx, sessionId);
      read ||= again.page !== null;
      seen = again.sensitive
        ? { ...SENSITIVE_PAGE, looks: 2, url: seen.url }
        : again.page || !first
          ? readBack(sent, again.page, 2)
          : { ...seen, looks: 2 };
    }
    const evidence = {
      read_back: seen,
      submitted: submittedFields(sent),
    } as unknown as JsonObject;
    const sensitive = seen.evidence === SENSITIVE_PAGE.evidence;
    const unconfirmed =
      read && seen.verdict === 'unclear' && !seen.blocker && !sensitive && !ctx.risk;
    if (seen.verdict === 'done' || unconfirmed)
      return {
        outcome: 'succeeded' as const,
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: sessionId,
          received_at: new Date().toISOString(),
          late: false,
          detail: { ...detail, ...evidence, ...(unconfirmed ? { unconfirmed: true } : {}) },
        },
      };
    if (seen.verdict === 'not_done')
      return {
        outcome: 'failed' as const,
        reason: `The site did not take it: ${seen.evidence}`,
        retryable: false,
        evidence,
      };
    await handOff(
      ctx,
      sessionId,
      seen.blocker ?? (sensitive ? 'sign_in' : 'unclear'),
      seen.url ?? sent.url,
      action,
    ).catch(() => {});
    return {
      outcome: 'unknown' as const,
      reason: `The page after the submit does not say whether it went through: ${seen.evidence} It was handed to the person to check.`,
      evidence: { ...evidence, handed_to: 'person' } as JsonObject,
    };
  };

  return {
    manifest: browserManifest,
    /**
     * A named session must be one this job holds; anything else is refused with the job's own
     * sessions listed, never another job's. A submit with no session is bound here, at proposal,
     * to the job's current session and the epoch it was observed under, so an approval waits on
     * exactly what was seen.
     */
    async prepare(payload, ctx, tx) {
      const named = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      if (!named && payload.intent === undefined) return payload;
      const held = await jobSessions(tx, ctx);
      const bound = named ? held.find((session) => session.id === named) : held[0];
      if (!bound) {
        if (!named)
          throw new BrokerFault(
            'payload_invalid',
            'This job has no browser page to submit from yet. Open the page, fill it, then submit an intent from the latest observation.',
          );
        throw new BrokerFault(
          'payload_invalid',
          `There is no browser session ${named} in this job. ${LEAVE_OUT}${
            held.length
              ? ` This job's sessions: ${held.map((session) => session.id).join(', ')}.`
              : ''
          }`,
        );
      }
      if (payload.intent === undefined || Number.isSafeInteger(payload.control_epoch))
        return { ...payload, session_id: bound.id };
      return { ...payload, session_id: bound.id, control_epoch: bound.control_epoch };
    },
    async execute(action, ctx) {
      if (
        action.job_id !== ctx.job_id ||
        action.id !== ctx.idempotency_key ||
        action.id !== action.idempotency_key ||
        (options.spaceId && ctx.space_id !== options.spaceId)
      )
        throw new Error('connector action identity mismatch');
      const kind = action.kind.replace(/^browser\./, '');
      if (!browserManifest.tools.some((tool) => tool.name === action.kind))
        throw new Error('unknown browser tool');
      const payload = action.canonical_payload;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      let activeSessionId = sessionId;
      let activeWorker: BrowserWorkerClient | undefined;
      // Why a page outside this job's reach is refused, said as web.fetch says it.
      let refusal: string | null = null;
      // A commit is bound at proposal to the session and epoch it was planned under (see prepare).
      if (kind === 'submit' && (!sessionId || !Number.isSafeInteger(payload.control_epoch)))
        throw new Error('A planned browser session and control epoch are required');
      try {
        ctx.signal?.throwIfAborted();
        const leased = await lease(ctx, sessionId);
        const { session, worker, opened } = leased;
        refusal = leased.refusal;
        activeSessionId = session.id;
        activeWorker = worker;
        // A browser this call just started shows a blank page. Looking at it once lets the first
        // step act; every later epoch still needs an observation the model asked for.
        if (opened && kind !== 'observe') {
          const first = output.parse(
            await worker.request('/command', {
              session_id: session.id,
              job_id: ctx.job_id,
              control_epoch: session.control_epoch,
              operation: { kind: 'observe' },
            }),
          );
          if (first.session_id !== session.id) throw new Error('worker session identity mismatch');
        }
        const operation: JsonObject = { kind };
        for (const [key, value] of Object.entries(payload))
          if (
            key !== 'session_id' &&
            key !== 'control_epoch' &&
            key !== 'after_observation' &&
            key !== 'recipe_id' &&
            key !== 'recipe_version'
          )
            operation[key] = value;
        const plannedEpoch = payload.control_epoch ?? session.control_epoch;
        const result = output.parse(
          await worker.request('/command', {
            session_id: session.id,
            job_id: ctx.job_id,
            control_epoch: plannedEpoch,
            operation,
          }),
        );
        if (result.session_id !== session.id) throw new Error('worker session identity mismatch');
        const detail: JsonObject = {
          session_id: result.session_id,
          control_epoch: result.control_epoch,
          ...(result.result ? { result: result.result } : {}),
        };
        const page = pageOf(result);
        // Durable receipts contain handles and schema, never screenshot bytes or full page captures.
        if (result.observation)
          detail.observation = await options.artifacts(ctx, result.observation);
        // A form sent is not an effect done: the page it ended on says whether it took.
        if (kind === 'submit') return await settleSubmit(action, ctx, session.id, page, detail);
        // A check only the person can pass ends the agent's turn here, with a card for them.
        const blocker = page ? blockerOf(page) : null;
        if (blocker) {
          await handOff(ctx, session.id, blocker, page?.url ?? '', action);
          detail.handed_to = 'person';
        }
        if (
          kind === 'observe' &&
          (payload.recipe_id !== undefined || payload.recipe_version !== undefined)
        ) {
          if (
            !options.recipes ||
            !result.observation ||
            typeof payload.recipe_id !== 'string' ||
            typeof payload.recipe_version !== 'number'
          )
            throw new BrowserFault('recipe_unavailable');
          const plan = await planBrowserRecipe(
            options.recipes,
            ctx.space_id,
            payload.recipe_id,
            payload.recipe_version,
            result.observation.schema,
          );
          detail.result = { ...result.result, recipe: recipePlanDetail(plan) };
          if (plan.disposition === 'stop')
            await options.sessions.park(ctx, session.id, plan.reason, action.attempt_id);
        }
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: session.id,
            received_at: new Date().toISOString(),
            late: false,
            detail,
          },
        };
      } catch (error) {
        if (error instanceof BrowserFault) {
          let reason = error.reason;
          const sensitive = error.reason === 'sensitive_input_require_takeover';
          // The job waits for the person only while they hold the browser: their
          // hand-back is what wakes it. A step that went stale while nobody holds
          // it (handed back already, or moved on under another job) is the
          // agent's to retry from a fresh look; parked, it would wait for ever.
          const theirs =
            activeSessionId && browserInputReasons.has(error.reason) && !sensitive
              ? await personHolds(activeWorker)
              : false;
          if (activeSessionId && (sensitive || theirs)) {
            try {
              // A sign-in, code or card field is the person's to fill: they are handed it.
              if (sensitive && options.sessions.handOff)
                await handOff(
                  ctx,
                  activeSessionId,
                  'sign_in',
                  String((payload.url as string | undefined) ?? ''),
                  action,
                );
              else
                await options.sessions.park(ctx, activeSessionId, error.reason, action.attempt_id);
            } catch {
              // The durable failure records both outcomes without exposing a database error's contents.
              reason += '; browser_park_failed';
            }
          } else if (activeSessionId && browserInputReasons.has(error.reason))
            reason = `${error.reason}: ${LOOK_AGAIN}`;
          // A named session that has closed since: the job's current one is a call away.
          if (sessionId && error.reason === 'session_not_found')
            reason = `session_not_found: browser session ${sessionId} is no longer open. ${LEAVE_OUT}`;
          if (error.reason === 'domain_not_allowed')
            reason = `domain_not_allowed: ${
              refusal ??
              'This work may open only the sites it was given, and this page is not one of them.'
            }`;
          return { outcome: 'failed', reason, retryable: false };
        }
        // A transport loss after an approved commit has an unknown effect and must never be
        // retried. The page is read once more to settle it; what it cannot settle goes to the person.
        if (kind === 'submit') {
          if (!activeSessionId)
            return {
              outcome: 'unknown',
              reason: 'Browser commit ended without a confirmed receipt.',
            };
          return await settleSubmit(action, ctx, activeSessionId, null, {
            session_id: activeSessionId,
          });
        }
        return {
          outcome: 'failed',
          reason: 'Browser operation could not be completed.',
          retryable: false,
        };
      }
    },
    /**
     * Whether a submit took, read from the page the browser is on now. A page
     * that confirms it settles it, one that refuses it settles it the other
     * way, and anything else is the person's to check. A page handed back by
     * the person shows only its controls, so it rarely decides.
     */
    async verify(action, ctx) {
      const unsupported = {
        decision: 'unsupported' as const,
        reason: 'A site receipt must be checked by the person after an uncertain browser commit.',
      };
      const payload = action.canonical_payload;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      if (action.kind !== 'browser.submit' || !sessionId) return unsupported;
      const again = await lookAgain(ctx, sessionId);
      if (again.sessionId !== sessionId || !again.page) return unsupported;
      // The browser may have moved on since: only a page of the site the form
      // went to, or of the one the submit landed on, speaks about this form.
      const sent = sentForm(payload);
      const landed = (
        (action.reconciliation?.evidence as { read_back?: { url?: unknown } } | undefined)
          ?.read_back as { url?: unknown } | undefined
      )?.url;
      const sites = new Set(
        [sent.url, typeof landed === 'string' ? landed : null].flatMap((url) => {
          const site = url ? serviceOfUrl(url) : null;
          return site ? [site] : [];
        }),
      );
      const here = serviceOfUrl(again.page.url);
      if (!here || !sites.has(here)) return unsupported;
      const seen = readBack(sent, again.page, 2);
      const evidence = { read_back: seen } as unknown as JsonObject;
      if (seen.verdict === 'done')
        return {
          decision: 'succeeded',
          evidence,
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: sessionId,
            received_at: new Date().toISOString(),
            late: false,
            detail: { session_id: sessionId, ...evidence },
          },
        };
      if (seen.verdict === 'not_done') return { decision: 'failed', evidence };
      return unsupported;
    },
    async health() {
      return {
        status: 'ok',
        detail: 'Broker transport and browser control fencing configured.',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
