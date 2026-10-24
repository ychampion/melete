/**
 * An app connected through Composio (Slack, Notion, GitHub, ...): its tools,
 * reached the way the agent reaches any connection's.
 *
 * A toolkit can have hundreds of tools, so the connection offers three, and
 * the agent finds the one it needs instead of carrying every schema in its
 * prompt:
 *
 * - `find_tools` lists the app's tools that match what the agent wants to do,
 *   with each one's arguments. It reads Composio's catalog, which Composio
 *   does not count as a tool call.
 * - `read` runs one tool Composio marks as only reading.
 * - `act` runs any other tool, after the person's approval.
 *
 * Each run is one tool call in the account's own tool router session,
 * counted against the installation's limits before it is sent. Which account
 * a call acts for comes from the connection row alone.
 */
import type {
  Action,
  ConnectorHealth,
  ConnectorTool,
  DispatchResult,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import { CAP_WORDS, ComposioCapReached } from '../signals/managed-calls.ts';
import {
  type ComposioClient,
  ComposioFault,
  type ComposioToolInfo,
  TOOL_SLUG,
  TOOLKIT_SLUG,
} from './composio.ts';
import { namesManagedAuthority } from './composio-fetch.ts';
import type { ComposioRunner } from './composio-sessions.ts';
import { ConnectorFaultError } from './faults.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** The namespace an app's tools take: `app_slack.read`. */
export const appNamespace = (toolkit: string) => `app_${toolkit.replace(/[^a-z0-9_]/g, '_')}`;

/** The three tools an app connection offers, by their grant names. */
export function appToolNames(toolkit: string) {
  const ns = appNamespace(toolkit);
  return { find: `${ns}.find_tools`, read: `${ns}.read`, act: `${ns}.act` };
}

/** How much of an answer is kept for the agent. */
const MAX_DETAIL_BYTES = 48 * 1024;
/** How many tools one search lists. */
const FOUND_TOOLS = 8;
/** How long what Composio says about a tool is kept. */
const TOOL_INFO_MS = 60 * 60_000;

/** The tools an app's connection declares. */
export function appTools(toolkit: string, title: string): ConnectorTool[] {
  const names = appToolNames(toolkit);
  const call = {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: `The tool's slug, as ${names.find} lists it.`,
      },
      arguments: {
        type: 'object',
        description: 'The arguments the tool takes, as its schema from find_tools says.',
      },
    },
    required: ['tool'],
    additionalProperties: false,
  };
  return [
    {
      name: names.find,
      description:
        `Find ${title} tools for what you want to do there: each one's slug, what it does, whether it only reads, and its arguments.`.slice(
          0,
          400,
        ),
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, in a few words.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      effect_class: 'read',
      required_scopes: [names.find],
      verify: false,
      requires_approval: false,
    },
    {
      name: names.read,
      description: `Run one ${title} tool that only reads, found with ${names.find}.`.slice(0, 400),
      input_schema: call,
      effect_class: 'read',
      required_scopes: [names.read],
      verify: false,
      requires_approval: false,
    },
    {
      name: names.act,
      description:
        `Run one ${title} tool that changes something there, found with ${names.find}. The person approves it first.`.slice(
          0,
          400,
        ),
      input_schema: call,
      effect_class: 'write_external',
      required_scopes: [names.act],
      verify: false,
      requires_approval: true,
    },
  ];
}

/** An answer cut to what the agent is given. */
function bounded(data: unknown): JsonObject {
  const text = JSON.stringify(data ?? null);
  if (Buffer.byteLength(text) <= MAX_DETAIL_BYTES) return { data: JSON.parse(text) };
  return {
    data_excerpt: Buffer.from(text).subarray(0, MAX_DETAIL_BYTES).toString('utf8'),
    truncated: true,
  };
}

export type ComposioAppConfig = {
  id: string;
  spaceId: string;
  toolkit: string;
  title: string;
  connectedAccountId: string;
  client: ComposioClient;
  runner: ComposioRunner;
  now?: () => number;
};

export class ComposioAppConnector implements Connector {
  readonly manifest;
  readonly service: string;
  readonly catalog = { source: 'mcp' as const, audience: 'owner' as const };
  private readonly names;
  private readonly known = new Map<string, { info: ComposioToolInfo | null; until: number }>();

  constructor(private readonly config: ComposioAppConfig) {
    if (!TOOLKIT_SLUG.test(config.toolkit)) throw new Error('Invalid Composio toolkit');
    this.names = appToolNames(config.toolkit);
    this.service = `composio:${config.toolkit}`;
    this.manifest = {
      name: `${config.title} through Composio`,
      provider: 'composio' as const,
      version: '1.0.0',
      description: `${config.title}, connected through Composio`,
      credentials: [],
      health: true,
      tools: appTools(config.toolkit, config.title),
    };
  }

  /** Only the search and the read tool are declared as reading; `act` is asked about. */
  readOnlyDeclared(kind: string): boolean {
    return kind === this.names.find || kind === this.names.read;
  }

  private now() {
    return this.config.now?.() ?? Date.now();
  }

  /** What Composio says about one of this app's tools; null when it has no such tool. */
  private async tool(slug: string, signal?: AbortSignal): Promise<ComposioToolInfo | null> {
    const kept = this.known.get(slug);
    if (kept && kept.until > this.now()) return kept.info;
    const [info] = await this.config.client.tools({
      toolkit: this.config.toolkit,
      slugs: [slug],
      limit: 1,
      ...(signal ? { signal } : {}),
    });
    const found = info?.slug === slug ? info : null;
    this.known.set(slug, { info: found, until: this.now() + TOOL_INFO_MS });
    return found;
  }

  private receipt(action: Action, detail: JsonObject): DispatchResult {
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: `composio:${this.config.toolkit}:${action.id}`,
        detail: {
          ...detail,
          via: 'composio',
          origin_trust: 'external_content',
          evidence_handle: `composio:${this.config.toolkit}:${action.id}`,
        },
        received_at: new Date().toISOString(),
        late: false,
      },
    };
  }

  private failed(reason: string, retryable = false): DispatchResult {
    return { outcome: 'failed', reason, retryable };
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    if (action.connection_id !== this.config.id || ctx.space_id !== this.config.spaceId)
      return this.failed('Composio app authority mismatch');
    ctx.signal?.throwIfAborted();
    const payload = action.canonical_payload as Record<string, unknown>;
    if (namesManagedAuthority(payload))
      throw new ConnectorFaultError({
        kind: 'unsupported_route',
        detail: 'A tool call cannot name the account it acts for; the connection decides that.',
      });
    try {
      if (action.kind === this.names.find) {
        const query = typeof payload.query === 'string' ? payload.query.slice(0, 200) : '';
        const found = await this.config.client.tools({
          toolkit: this.config.toolkit,
          query,
          limit: FOUND_TOOLS,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        for (const info of found)
          this.known.set(info.slug, { info, until: this.now() + TOOL_INFO_MS });
        return this.receipt(action, {
          tools: found.map((info) => ({
            tool: info.slug,
            name: info.name,
            description: info.description,
            run_with: info.readOnly ? this.names.read : this.names.act,
            arguments: info.inputSchema as JsonObject,
          })),
        } as JsonObject);
      }
      if (action.kind !== this.names.read && action.kind !== this.names.act)
        return this.failed('Unknown tool for this app.');
      const slug = payload.tool;
      const args = payload.arguments ?? {};
      if (
        typeof slug !== 'string' ||
        !TOOL_SLUG.test(slug) ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args)
      )
        return this.failed('Name a tool by its slug, with its arguments as an object.');
      const info = await this.tool(slug, ctx.signal);
      if (!info)
        return this.failed(`${slug} is not a tool of this app. Find one with ${this.names.find}.`);
      if (action.kind === this.names.read && !info.readOnly)
        return this.failed(`${slug} changes something; run it with ${this.names.act}.`);
      const result = await this.config.runner.run({
        connectedAccountId: this.config.connectedAccountId,
        toolkit: this.config.toolkit,
        tool: slug,
        args: args as Record<string, unknown>,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!result.ok)
        return this.failed(`${slug} failed: ${(result.error ?? 'no reason given').slice(0, 300)}`);
      return this.receipt(action, { tool: slug, ...bounded(result.data) });
    } catch (error) {
      if (error instanceof ComposioCapReached) return this.failed(CAP_WORDS[error.dimension]);
      if (error instanceof ComposioFault) {
        if (error.kind === 'account_unavailable')
          throw new ConnectorFaultError({
            kind: 'expired_credential',
            detail: 'Composio no longer acts for this account; connect the app again.',
            may_have_committed: error.mayHaveRun && action.kind === this.names.act,
          });
        if (error.mayHaveRun && action.kind === this.names.act)
          return {
            outcome: 'unknown',
            reason: 'Composio did not confirm the tool ran; it was not run again.',
          };
        return this.failed('Composio could not be reached just now.', !error.mayHaveRun);
      }
      throw error;
    }
  }

  async verify(): Promise<VerifyResult> {
    return {
      decision: 'unsupported',
      reason: 'An app run through Composio has no general way to confirm what a tool did.',
    };
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const account = await this.config.client.account(this.config.connectedAccountId);
      if (account.status === 'ACTIVE' && !account.disabled)
        return {
          status: 'ok',
          detail: `${this.config.title} is connected.`,
          checked_at: checkedAt,
        };
      return {
        status: 'failing',
        detail: `${this.config.title} needs to be connected again.`,
        checked_at: checkedAt,
        reason: 'sign_in_required',
      };
    } catch (error) {
      return {
        status: 'failing',
        detail:
          error instanceof ComposioFault && error.kind === 'account_unavailable'
            ? `${this.config.title} needs to be connected again.`
            : 'Composio did not answer.',
        checked_at: checkedAt,
        ...(error instanceof ComposioFault && error.kind === 'account_unavailable'
          ? { reason: 'sign_in_required' as const }
          : {}),
      };
    }
  }
}
