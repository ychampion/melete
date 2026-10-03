/**
 * The broker's side of a command-line account: one write tool per adapter,
 * carried out by the egress relay and by nothing else.
 *
 * The bytes of a write live in the computer, inside the request the relay is
 * holding open, so only that request can send them. The relay runs the
 * broker's ordinary proposal and admission inside `relaying`, which hands
 * the connector the one function that forwards that request; the connector
 * calls it at most once. A proposal made any other way (a model naming the
 * tool, a resume, a recovery sweep) finds no request to send: it is refused
 * before anything is recorded, or fails without sending.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
} from '@melete/contracts';
import { BrokerFault } from '../broker/errors.ts';
import type { Connector } from '../connectors/types.ts';
import {
  type CredentialAdapterId,
  egressWriteTool,
  type UpstreamResponse,
} from './adapters/types.ts';

/** What happened to one forwarded request. */
export type ForwardResult =
  | {
      outcome: 'answered';
      response: UpstreamResponse;
      detail: JsonObject;
      /** Why the change did not take effect although the service answered below 400. */
      rejected?: string | null;
      /** Why it cannot be told whether the change took effect, although the service answered. */
      uncertain?: string | null;
    }
  /** The request left and its answer was lost: it may have landed. */
  | { outcome: 'lost'; reason: string }
  /** Nothing left: the upstream could not be reached. */
  | { outcome: 'not_sent'; reason: string };

type Relay = {
  /** The canonical payload the relay classified; a different action is never sent. */
  payloadHash: string;
  forward: () => Promise<ForwardResult>;
  sent: boolean;
  result?: ForwardResult;
};

const relay = new AsyncLocalStorage<Relay>();

/**
 * Runs `work` (a proposal, an admission, a dispatch) with the one request it
 * may send. Answers what `work` returned and what the forward did, if it ran.
 */
export async function relaying<T>(
  payloadHash: string,
  forward: () => Promise<ForwardResult>,
  work: () => Promise<T>,
): Promise<{ value: T; forwarded: ForwardResult | undefined }> {
  const context: Relay = { payloadHash, forward, sent: false };
  const value = await relay.run(context, work);
  return { value, forwarded: context.result };
}

export const COMMAND_LINE_RELAY_ONLY =
  'Commands in the agent’s computer make these requests themselves. Run the command; it asks for approval when it needs one.';

export function createCommandLineConnector(
  adapter: CredentialAdapterId,
  options: {
    /** Asks the service whether the account still answers; left out, nothing is asked. */
    health?: () => Promise<ConnectorHealth>;
  } = {},
): Connector {
  const name = egressWriteTool(adapter);
  const manifest: ConnectorManifest = {
    name: `command_line_${adapter}`,
    version: '0.1.0',
    provider: 'command_line',
    description: `Changes a command in the agent's computer makes with a connected ${adapter} account.`,
    credentials: [],
    health: false,
    tools: [
      {
        name,
        description:
          'A change a command in the agent’s computer asked to make with a connected account. Made by the command itself; never proposed directly.',
        input_schema: { type: 'object' },
        effect_class: 'write_external',
        required_scopes: [name],
        verify: false,
        requires_approval: true,
      },
    ],
  };
  return {
    manifest,
    // Only the relay proposes these: anyone else is refused before an action exists.
    async prepare(payload) {
      if (!relay.getStore()) throw new BrokerFault('unknown_tool', COMMAND_LINE_RELAY_ONLY);
      return payload;
    },
    // A slow upload stays inside its command's own time, which is shorter than this.
    dispatchBudgetMs: () => 10 * 60_000,
    async execute(action): Promise<DispatchResult> {
      const context = relay.getStore();
      if (!context || context.payloadHash !== action.payload_hash)
        return {
          outcome: 'failed',
          reason:
            'Only the command that makes this request can send it. Nothing was sent; run the command again.',
          retryable: false,
        };
      if (context.sent)
        return { outcome: 'unknown', reason: 'This request was already sent once.' };
      context.sent = true;
      const result = await context.forward().catch(
        (error: unknown): ForwardResult => ({
          outcome: 'lost',
          reason: String((error as Error)?.message ?? error),
        }),
      );
      context.result = result;
      if (result.outcome === 'lost') return { outcome: 'unknown', reason: result.reason };
      // Nothing left, but only the command holds these bytes, and this request
      // is settled for this turn: the person asks again for it to be run again.
      if (result.outcome === 'not_sent')
        return {
          outcome: 'failed',
          reason: `${result.reason}; nothing was sent. Ask again in a new message to run the command again.`,
          retryable: false,
        };
      const { status } = result.response;
      // A server error can follow a change that already landed: it is never recorded as nothing.
      if (status >= 500)
        return {
          outcome: 'unknown',
          reason: `The service answered ${status} after this change was sent, so it may have taken effect. Check before asking for it again.`,
        };
      if (result.uncertain) return { outcome: 'unknown', reason: result.uncertain };
      if (status >= 400)
        return {
          outcome: 'failed',
          reason: `The service answered ${status}; nothing was changed by this request.`,
          retryable: false,
        };
      if (result.rejected) return { outcome: 'failed', reason: result.rejected, retryable: false };
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: null,
          detail: result.detail,
          received_at: new Date().toISOString(),
          late: false,
        },
      };
    },
    async verify() {
      return {
        decision: 'unsupported',
        reason: 'A request from the computer is checked at its destination, not here.',
      };
    },
    async health() {
      if (options.health) return options.health();
      return {
        status: 'ok',
        detail: 'Used by commands in the agent’s computer.',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
