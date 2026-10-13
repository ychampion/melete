/**
 * `browser.sign_in`: the agent signs in to a site in its browser with one of
 * the person's saved sign-ins, without ever holding the password or code.
 *
 * At proposal the site is resolved, on the service side, to one saved sign-in
 * of the job's own person in the job's own space, and what may be shown of it
 * is bound into the payload: its site, its label, a masked username, and
 * whether the person asked to be asked first. At dispatch the sign-in is read
 * again, opened for that one step, and handed to the browser worker, which
 * types it into the exact saved site and answers only with what came of it.
 * The model is told "Signed in as j***@… on example.com", or why not, and
 * nothing else: no tool result, receipt, event, log line or error built here
 * carries what was typed.
 */
import type {
  Action,
  DispatchResult,
  HandOffReason,
  JsonObject,
  JsonValue,
  SignInOutcome,
} from '@melete/contracts';
import { z } from 'zod';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import type { BrowserWorkerClient } from '../workers/browser/client.ts';
import { BrowserFault } from '../workers/browser/sessions.ts';
import { originOf, type SignInStepOutcome } from '../workers/browser/sign-in-page.ts';
import {
  maskUsername,
  type SignInVault,
  siteOf,
  VaultFault,
  type VaultRecord,
} from './sign-in-vault.ts';
import { currentCode } from './totp.ts';
import type { ConnectorContext } from './types.ts';

/** The part of the vault the browser uses; a test may stand in for it. */
export type SignInVaultPort = Pick<
  SignInVault,
  'origin' | 'forOrigin' | 'sites' | 'get' | 'principalOf' | 'withCredential' | 'recordUse'
>;

export const SIGN_IN_TOOL = {
  name: 'sign_in',
  description:
    "Sign in to a site in this job's browser with the person's saved sign-in. Name the site, like example.com; Melete types the saved username, password and any one-time code itself, and you never see them. Use it when a page asks you to sign in, instead of asking for a password. Optional url: the sign-in page, on that site. Pass sign_in_id only when told there are several. Then observe the page.",
  effect: 'write_reversible' as const,
  properties: {
    site: { type: 'string', minLength: 1, maxLength: 300 },
    url: { type: 'string', format: 'uri', maxLength: 4000 },
    sign_in_id: { type: 'string', pattern: '^ssi_[0-9A-Z]{26}$' },
    saved: {
      type: 'object',
      additionalProperties: true,
      description: 'Filled in by Melete; leave it out.',
    },
  } satisfies Record<string, JsonValue>,
  required: ['site'],
};

/** What prepare bound about the saved sign-in: shown on any approval card, read by `asksFirst`. */
const bound = z.object({
  origin: z.string(),
  label: z.string(),
  account: z.string(),
  ask_first: z.boolean(),
  has_code: z.boolean(),
});
type Bound = z.infer<typeof bound>;

export function savedOf(action: Pick<Action, 'canonical_payload'>): Bound | null {
  const parsed = bound.safeParse(action.canonical_payload.saved);
  return parsed.success ? parsed.data : null;
}

const refuse = (message: string): never => {
  throw new BrokerFault('payload_invalid', message);
};

const ADD_ONE = 'The person can add one in Settings → Saved sign-ins.';

/** Said when the job is not a person's own work in a space they can still reach. */
export const OWN_WORK_ONLY = 'Saved sign-ins can only be used in your own chats and routines.';

/**
 * Resolves the site the agent named to one saved sign-in of the job's person,
 * and binds what may be shown of it. The agent's own `saved` is never kept.
 */
export async function prepareSignIn(
  vault: SignInVaultPort | undefined,
  payload: JsonObject,
  ctx: ConnectorContext,
  tx: Query,
): Promise<JsonObject> {
  if (!vault) return refuse('Saved sign-ins are not available on this installation.');
  const principal = await vault.principalOf(ctx.space_id, ctx.job_id, tx);
  if (!principal) return refuse(OWN_WORK_ONLY);
  let origin: string;
  try {
    origin = vault.origin(String(payload.site ?? ''));
  } catch (error) {
    return refuse(error instanceof VaultFault ? error.message : 'Name the site, like example.com.');
  }
  const url = typeof payload.url === 'string' ? payload.url : undefined;
  if (url !== undefined && originOf(url) !== origin)
    refuse(
      `The sign-in page must be on ${origin} itself. Leave url out to use the site's home page.`,
    );
  const records = await vault.forOrigin(ctx.space_id, principal, origin, tx);
  const named = typeof payload.sign_in_id === 'string' ? payload.sign_in_id : undefined;
  let record: VaultRecord | undefined;
  if (named) record = records.find((entry) => entry.id === named);
  else if (records.length === 1) record = records[0];
  if (!record) {
    if (records.length > 1 && !named)
      refuse(
        `There are ${records.length} saved sign-ins for ${siteOf(origin)}: ${records
          .map((entry) => `${entry.id} (${entry.label}, ${maskUsername(entry.username)})`)
          .join('; ')}. Pass sign_in_id for the one the person meant, or ask them which.`,
      );
    const others = (await vault.sites(ctx.space_id, principal, tx))
      .map((entry) => siteOf(entry.origin))
      .filter((site, index, all) => all.indexOf(site) === index);
    refuse(
      `There is no saved sign-in for ${siteOf(origin)}${named ? ` with id ${named}` : ''}.${
        others.length ? ` Saved sign-ins are for: ${others.join(', ')}.` : ''
      } ${ADD_ONE}`,
    );
  }
  const found = record as VaultRecord;
  return {
    site: siteOf(origin),
    ...(url !== undefined ? { url } : {}),
    sign_in_id: found.id,
    ...(typeof payload.session_id === 'string' ? { session_id: payload.session_id } : {}),
    ...(payload.after_observation !== undefined
      ? { after_observation: payload.after_observation }
      : {}),
    saved: {
      origin,
      label: found.label,
      account: maskUsername(found.username),
      ask_first: found.policy === 'ask_first',
      has_code: found.hasCode,
    },
  };
}

/** A person who said "ask me first" for this sign-in is asked, whatever else would let it through. */
export const signInAsksFirst = (action: Pick<Action, 'kind' | 'canonical_payload'>) =>
  action.kind === 'browser.sign_in' && savedOf(action)?.ask_first !== false;

/**
 * At admission and dispatch: the sign-in is still there, for the same site, and
 * not since switched to ask first after this action was let through without asking.
 */
export async function validateSignIn(
  vault: SignInVaultPort | undefined,
  action: Action,
  ctx: ConnectorContext,
  tx: Query,
): Promise<void> {
  const saved = savedOf(action);
  const id = action.canonical_payload.sign_in_id;
  if (!vault || !saved || typeof id !== 'string')
    refuse('This sign-in was not resolved to a saved sign-in. Propose it again.');
  const principal = await (vault as SignInVaultPort).principalOf(ctx.space_id, ctx.job_id, tx);
  if (!principal) refuse(OWN_WORK_ONLY);
  const record = await (vault as SignInVaultPort)
    .get(ctx.space_id, principal as string, id as string, tx)
    .catch(() => null);
  if (!record || record.origin !== saved?.origin)
    refuse('That saved sign-in has been deleted or changed since. Propose it again.');
  if (record?.policy === 'ask_first' && saved?.ask_first === false)
    refuse('The person now wants to be asked before this sign-in is used. Propose it again.');
}

type Lease = (
  ctx: ConnectorContext,
  sessionId?: string,
) => Promise<{
  session: { id: string; control_epoch: number };
  worker: BrowserWorkerClient;
  opened: boolean;
}>;

type HandOff = (
  ctx: ConnectorContext,
  sessionId: string,
  reason: HandOffReason,
  url: string,
  action: Action,
) => Promise<void>;

const stepResult = z.object({
  session_id: z.string().min(1),
  control_epoch: z.number().int().nonnegative(),
  result: z.object({
    sign_in: z.enum([
      'signed_in',
      'code_asked',
      'form_not_found',
      'not_accepted',
      'wrong_site',
      'insecure_site',
      'captcha',
    ]),
    at: z.string().max(300).optional(),
  }),
});

/** Browser refusals whose words are safe to pass on: none of them names what was typed. */
const SAID = new Map<string, string>([
  ['human_control', 'A person holds the browser right now; nothing was typed.'],
  [
    'stale_control_epoch',
    'The browser changed hands meanwhile; nothing was typed. Observe the page, then try again.',
  ],
  ['fresh_observation_required', 'Look at the page with browser.observe first, then try again.'],
  ['session_not_found', 'The browser session has closed. Try again to open a new one.'],
  ['session_busy', 'The browser is busy with other work. Try again in a moment.'],
  ['domain_not_allowed', 'This work may not open that site.'],
  ['page_timeout', 'The sign-in page did not finish loading.'],
  ['sign_in_budget', 'The site sent more than a sign-in needs, so the browser stopped it.'],
  [
    'ambiguous_control',
    'The sign-in form changed while it was being filled. Observe the page, then try again.',
  ],
  [
    'control_not_found',
    'The sign-in form changed while it was being filled. Observe the page, then try again.',
  ],
  ['control_not_available', 'The sign-in button could not be pressed.'],
]);

function browserWords(error: unknown): string {
  if (error instanceof BrowserFault) {
    const code = error.reason.split(':')[0]?.trim() ?? '';
    if (SAID.has(code)) return SAID.get(code) as string;
  }
  if (error instanceof Error && SAID.has(error.message)) return SAID.get(error.message) as string;
  return 'The browser could not finish signing in.';
}

/** What one use came to: the receipt's outcome, the words for the agent, and any hand-off. */
type Settled = {
  outcome: SignInOutcome;
  words: string;
  handOff?: HandOffReason;
  done: boolean;
};

function settle(
  step: SignInStepOutcome | 'code_refused',
  host: string,
  account: string,
  at: string | undefined,
  hasCode: boolean,
): Settled {
  switch (step) {
    case 'signed_in':
      return { outcome: 'signed_in', words: `Signed in as ${account} on ${host}.`, done: true };
    case 'code_asked':
      return hasCode
        ? {
            outcome: 'not_accepted',
            words: `${host} asked for a one-time code again after the saved code was entered.`,
            done: false,
          }
        : {
            outcome: 'needs_code',
            words: `${host} asked for a code the saved sign-in doesn't have, so it's the person's turn: they enter it and hand the browser back.`,
            handOff: 'two_factor',
            done: true,
          };
    case 'code_refused':
      return {
        outcome: 'not_accepted',
        words: `${host} didn't take the one-time code.`,
        done: false,
      };
    case 'captcha':
      return {
        outcome: 'needs_person',
        words: `${host} wants to check a person is there, so it's the person's turn: they pass the check and hand the browser back.`,
        handOff: 'captcha',
        done: true,
      };
    case 'form_not_found':
      return {
        outcome: 'form_not_found',
        words: `Couldn't find the sign-in form on ${host}. Open its sign-in page with browser.open, then try again with that page's url.`,
        done: false,
      };
    case 'not_accepted':
      return {
        outcome: 'not_accepted',
        words: `${host} didn't accept the saved sign-in. The person may need to update it in Settings → Saved sign-ins.`,
        done: false,
      };
    case 'wrong_site':
      return {
        outcome: 'wrong_site',
        words: `The page isn't on ${host}${at ? ` (it is on ${siteOf(at)})` : ''}, so nothing was typed. A saved sign-in is only used on its own site.`,
        done: false,
      };
    case 'insecure_site':
      return {
        outcome: 'wrong_site',
        words: `${host} isn't a secure (https) site, so nothing was typed.`,
        done: false,
      };
  }
}

/**
 * One use of a saved sign-in. Every path ends in a result made only of the
 * site, the label, the masked username and plain words, and in a receipt row.
 */
export async function runSignIn(options: {
  vault: SignInVaultPort | undefined;
  action: Action;
  ctx: ConnectorContext;
  lease: Lease;
  handOff: HandOff;
  now?: () => number;
}): Promise<DispatchResult> {
  const { vault, action, ctx } = options;
  const payload = action.canonical_payload;
  const saved = savedOf(action);
  const id = typeof payload.sign_in_id === 'string' ? payload.sign_in_id : undefined;
  const failed = (reason: string): DispatchResult => ({
    outcome: 'failed',
    reason,
    retryable: false,
  });
  if (!vault || !saved || !id) return failed('This sign-in was not resolved to a saved sign-in.');
  const host = siteOf(saved.origin);
  let record: VaultRecord;
  try {
    const principal = await vault.principalOf(ctx.space_id, ctx.job_id);
    if (!principal) return failed(OWN_WORK_ONLY);
    record = await vault.get(ctx.space_id, principal, id);
  } catch {
    return failed(`The saved sign-in for ${host} has been deleted.`);
  }
  if (record.origin !== saved.origin) return failed(`The saved sign-in for ${host} has changed.`);
  if (record.policy === 'ask_first' && !saved.ask_first)
    return failed(
      'The person now wants to be asked before this sign-in is used. Propose it again.',
    );
  const account = maskUsername(record.username);
  const receipt = async (outcome: SignInOutcome) => {
    await vault
      .recordUse(record, { jobId: ctx.job_id, actionId: action.id, outcome })
      .catch(() => {});
  };

  let sessionId: string | undefined =
    typeof payload.session_id === 'string' ? payload.session_id : undefined;
  let settled: Settled;
  let epoch = 0;
  try {
    ctx.signal?.throwIfAborted();
    const { session, worker, opened } = await options.lease(ctx, sessionId);
    sessionId = session.id;
    epoch = session.control_epoch;
    const send = async (operation: JsonObject) => {
      const request = () =>
        worker.request('/command', {
          session_id: session.id,
          job_id: ctx.job_id,
          control_epoch: session.control_epoch,
          operation,
        });
      try {
        return stepResult.parse(await request());
      } catch (error) {
        // A browser that has not been looked at since it changed hands is looked at once.
        if (!(error instanceof BrowserFault && error.reason === 'fresh_observation_required'))
          throw error;
        await worker.request('/command', {
          session_id: session.id,
          job_id: ctx.job_id,
          control_epoch: session.control_epoch,
          operation: { kind: 'observe' },
        });
        return stepResult.parse(await request());
      }
    };
    if (opened)
      await worker.request('/command', {
        session_id: session.id,
        job_id: ctx.job_id,
        control_epoch: session.control_epoch,
        operation: { kind: 'observe' },
      });
    const url = typeof payload.url === 'string' ? payload.url : undefined;
    // The password exists outside its sealed box only for this callback, and leaves it only
    // in the one request to the browser worker that types it.
    const step = await vault.withCredential(record, async (credential) => {
      const first = await send({
        kind: 'sign_in',
        origin: record.origin,
        ...(url ? { url } : {}),
        username: credential.username,
        password: credential.password,
      });
      if (first.result.sign_in !== 'code_asked' || !credential.totp) return first;
      // The code is made at the moment the page asks for it.
      const code = currentCode(credential.totp, options.now?.() ?? Date.now()).code;
      const second = await send({ kind: 'sign_in_code', origin: record.origin, code });
      return second.result.sign_in === 'code_asked'
        ? { ...second, result: { ...second.result, sign_in: 'code_refused' as const } }
        : second;
    });
    epoch = step.control_epoch;
    settled = settle(step.result.sign_in, host, account, step.result.at, record.hasCode);
    if (settled.handOff && sessionId)
      await options.handOff(ctx, sessionId, settled.handOff, record.origin, action).catch(() => {});
  } catch (error) {
    const words =
      error instanceof VaultFault
        ? error.message
        : `Couldn't sign in to ${host}: ${browserWords(error)}`;
    await receipt('failed');
    return failed(words);
  }
  await receipt(settled.outcome);
  if (!settled.done) return failed(settled.words);
  return {
    outcome: 'succeeded',
    receipt: {
      action_id: action.id,
      connection_id: action.connection_id,
      external_ref: sessionId ?? null,
      received_at: new Date(options.now?.() ?? Date.now()).toISOString(),
      late: false,
      detail: {
        session_id: sessionId ?? '',
        control_epoch: epoch,
        sign_in: { id: record.id, label: record.label, site: host },
        account,
        outcome: settled.outcome,
        note: settled.words,
        ...(settled.handOff ? { handed_to: 'person' } : {}),
      },
    },
  };
}
