/**
 * The tools Melete offers another assistant, each one the person's own.
 *
 * Every tool is answered by the owner API route the person would call signed
 * in, in this process, as the person the access token names (see `actor.ts`).
 * So a tool can do exactly what that person can do and nothing more: another
 * person's job, item or memory reads as not being there, as it would in the
 * app. The one tool that reaches outside Melete, `safe_send`, only proposes:
 * the broker holds the message until the person approves its exact text in
 * Melete, and no standing permission is allowed to stand in for that.
 */
import type { JsonObject } from '@melete/contracts';
import { z } from 'zod';
import type { McpActor } from './actor.ts';

/** A route called as the actor, answered with its status and parsed body. */
export type RouteCall = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export type ToolDeps = {
  actor: McpActor;
  route: RouteCall;
  /** The space's mailbox that can send, if one is connected. */
  sendConnection(spaceId: string): Promise<string | null>;
  /** Propose a send as an owner command; see `ExperienceEffects.proposeSend`. */
  proposeSend?(input: {
    spaceId: string;
    principalId: string;
    connectionId: string;
    payload: JsonObject;
    assistant: string;
  }): Promise<{ id: string; job_id: string; status: string } | { reason: string }>;
};

/** What a tool answers: its own words for the model, and the same content as data. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const answer = (text: string, data?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: data ? `${text}\n${JSON.stringify(data)}` : text }],
  ...(data ? { structuredContent: data } : {}),
});
const refusal = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/** A route's refusal in the person's own words, never a stack or an internal code alone. */
function routeRefusal(status: number, body: unknown, fallback: string): ToolResult {
  const message = (body as { error?: { message?: unknown }; reason?: unknown } | null) ?? null;
  const said =
    typeof message?.error?.message === 'string'
      ? message.error.message
      : typeof message?.reason === 'string'
        ? message.reason
        : undefined;
  // Someone else's record reads as absent, whether the route says missing or not yours.
  if (status === 404 || status === 403) return refusal('Melete has nothing by that id for you.');
  return refusal(said ?? fallback);
}

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'lowercase words joined by hyphens');
/** An id Melete handed out: one path segment, never `.` or `..`. */
const recordRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'an id Melete gave you');
const address = z.email().max(320);
const addresses = z.union([address, z.array(address).min(1).max(20)]);

export const TOOL_INPUTS = {
  waiting_on: z.strictObject({}),
  handle: z.strictObject({ item_id: recordRef }),
  safe_send: z.strictObject({
    to: addresses,
    cc: addresses.optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(200_000),
  }),
  remember: z.strictObject({ topic: slug, name: slug, value: z.string().min(1).max(16_000) }),
  recall: z.strictObject({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  status: z.strictObject({ job_id: recordRef }),
} as const;
export type ToolName = keyof typeof TOOL_INPUTS;

/** `tools/list`: names, words for the model, JSON Schema, and honest hints. */
export const TOOL_DEFINITIONS = [
  {
    name: 'waiting_on',
    title: 'What companies owe me',
    description:
      'List what companies owe the person, read from their mailbox by Melete: refunds, credits, deposits and promises, each with its company, amount, due date, whether Melete is already handling it, and the item_id to pass to handle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'handle',
    title: 'Chase an owed item',
    description:
      'Ask Melete to chase one item from waiting_on. Melete starts a job that writes to the company; every message it would send waits for the person to approve it in Melete. Returns the job_id to pass to status. Asking again for the same item returns the same job.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string', description: 'An item_id from waiting_on.' } },
      required: ['item_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'safe_send',
    title: 'Send an email once the person approves it',
    description:
      "Propose an email from the person's connected mailbox. Nothing is sent now: Melete shows the person this exact text and sends only if they approve it there. Returns awaiting_approval and a job_id; call status later to see whether it was approved and sent.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          anyOf: [
            { type: 'string', format: 'email' },
            { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1 },
          ],
        },
        cc: {
          anyOf: [
            { type: 'string', format: 'email' },
            { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1 },
          ],
        },
        subject: { type: 'string', maxLength: 500 },
        body: { type: 'string', description: 'Plain text, sent exactly as written.' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'remember',
    title: 'Remember a detail',
    description:
      'Save a detail the person stated, such as a preference, to their Melete memory under pref.<topic>.<name>. Saving the same topic and name again replaces the value. Only save what the person said themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Lowercase words joined by hyphens, e.g. travel.' },
        name: { type: 'string', description: 'Lowercase words joined by hyphens, e.g. seat.' },
        value: { type: 'string' },
      },
      required: ['topic', 'name', 'value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'recall',
    title: 'Recall saved details',
    description:
      "Search the person's saved details in Melete for words in the query. Returns each match with its key and value.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'status',
    title: 'Where a job stands',
    description:
      'The state of a job started with handle or safe_send, and each action in it: what it was, whether it waits for approval, and whether it succeeded, with its receipt.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const satisfies ReadonlyArray<{ name: ToolName } & Record<string, unknown>>;

type LedgerRow = {
  id: string;
  company_id: string;
  kind: string;
  direction: string;
  amount_minor: number | null;
  currency: string | null;
  due_at: string | null;
  status: string;
  job_id: string | null;
  summary: string;
};

const OPEN = new Set(['found', 'handling', 'waiting']);

async function waitingOn(deps: ToolDeps): Promise<ToolResult> {
  const { status, body } = await deps.route(
    'GET',
    `/spaces/${encodeURIComponent(deps.actor.spaceId)}/companies`,
  );
  if (status !== 200) return routeRefusal(status, body, 'Melete could not read what is owed.');
  const map = body as { companies: Array<{ id: string; name: string }>; items: LedgerRow[] };
  const names = new Map(map.companies.map((company) => [company.id, company.name]));
  const items = map.items
    .filter(
      (item) =>
        OPEN.has(item.status) && (item.direction === 'owed_to_you' || item.kind === 'promise'),
    )
    .slice(0, 100)
    .map((item) => ({
      item_id: item.id,
      company: names.get(item.company_id) ?? 'A company',
      summary: item.summary,
      kind: item.kind,
      amount_minor: item.amount_minor,
      currency: item.currency,
      due_at: item.due_at,
      status: item.status,
      job_id: item.job_id,
    }));
  return answer(
    items.length
      ? `${items.length} thing${items.length === 1 ? '' : 's'} owed.`
      : 'Nothing is owed that Melete has found. The person can scan their mailbox in Melete.',
    { items },
  );
}

async function handle(deps: ToolDeps, input: z.infer<typeof TOOL_INPUTS.handle>) {
  const { status, body } = await deps.route(
    'POST',
    `/ledger/${encodeURIComponent(input.item_id)}/handle?space_id=${encodeURIComponent(deps.actor.spaceId)}`,
  );
  if (status !== 200 && status !== 201)
    return routeRefusal(status, body, 'Melete could not start handling this.');
  const jobId = (body as { job_id: string }).job_id;
  return answer(
    'Melete is handling it. The person approves the first message to the company in Melete, and Melete follows up within the limits they set.',
    { job_id: jobId, status: status === 201 ? 'started' : 'already_handling' },
  );
}

async function safeSend(deps: ToolDeps, input: z.infer<typeof TOOL_INPUTS.safe_send>) {
  if (!deps.proposeSend) return refusal('Sending is not connected on this Melete.');
  const connectionId = await deps.sendConnection(deps.actor.spaceId);
  if (!connectionId)
    return refusal(
      'The person has no mailbox connected in Melete that can send. Ask them to connect one.',
    );
  const list = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
  const payload: JsonObject = {
    to: list(input.to),
    ...(input.cc ? { cc: list(input.cc) } : {}),
    subject: input.subject,
    body: input.body,
  };
  const proposed = await deps.proposeSend({
    spaceId: deps.actor.spaceId,
    principalId: deps.actor.principalId,
    connectionId,
    payload,
    assistant: deps.actor.clientName,
  });
  if ('reason' in proposed) return refusal(proposed.reason);
  if (
    ['needs_approval', 'proposed', 'approved', 'admitted', 'dispatched'].includes(proposed.status)
  )
    return answer('Awaiting your approval in Melete. Nothing has been sent.', {
      status: 'awaiting_approval',
      job_id: proposed.job_id,
      action_id: proposed.id,
    });
  if (proposed.status === 'succeeded')
    return answer('The person already approved this exact message, and it was sent.', {
      status: 'sent',
      job_id: proposed.job_id,
      action_id: proposed.id,
    });
  return refusal('Melete did not accept this message. Nothing was sent.');
}

async function remember(deps: ToolDeps, input: z.infer<typeof TOOL_INPUTS.remember>) {
  const key = `pref.${input.topic}.${input.name}`;
  const { status, body } = await deps.route('POST', '/memory/items', { key, value: input.value });
  if (status !== 200 && status !== 201)
    return routeRefusal(status, body, 'Melete could not save that.');
  if ((body as { reason?: unknown }).reason)
    return routeRefusal(status, body, 'Melete could not save that.');
  const item = (body as { item: { key: string; value: string } }).item;
  return answer(`Saved ${item.key}.`, { key: item.key, value: item.value });
}

async function recall(deps: ToolDeps, input: z.infer<typeof TOOL_INPUTS.recall>) {
  const words = input.query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  const found: Array<{ key: string; value: string; source: string }> = [];
  let after: string | null = null;
  // The saved details are paged; five pages is every detail a person keeps by hand.
  for (let page = 0; page < 5; page++) {
    const { status, body } = await deps.route(
      'GET',
      `/memory/items${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    );
    if (status !== 200) return routeRefusal(status, body, 'Melete could not read saved details.');
    if ((body as { reason?: unknown }).reason)
      return routeRefusal(status, body, 'Melete could not read saved details.');
    const listed = body as {
      items: Array<{ key: string; value: string; source: string }>;
      next?: string | null;
    };
    for (const item of listed.items) {
      const text = `${item.key} ${item.value}`.toLowerCase();
      if (words.length === 0 || words.some((word) => text.includes(word)))
        found.push({ key: item.key, value: item.value, source: item.source });
    }
    after = listed.next ?? null;
    if (!after) break;
  }
  const matches = found.slice(0, input.limit ?? 10);
  return answer(
    matches.length
      ? `${matches.length} saved detail${matches.length === 1 ? '' : 's'}.`
      : 'No saved detail matches.',
    { matches },
  );
}

async function status(deps: ToolDeps, input: z.infer<typeof TOOL_INPUTS.status>) {
  const id = encodeURIComponent(input.job_id);
  const job = await deps.route('GET', `/jobs/${id}`);
  if (job.status !== 200)
    return routeRefusal(job.status, job.body, 'Melete could not read that job.');
  const actions = await deps.route('GET', `/actions?job_id=${id}&limit=50`);
  if (actions.status !== 200)
    return routeRefusal(actions.status, actions.body, 'Melete could not read that job.');
  const view = (job.body as { job: { id: string; title: string; state: string } }).job;
  const effects = (
    actions.body as {
      actions: Array<{
        id: string;
        kind: string;
        status: string;
        created_at: string;
        resolved_at: string | null;
        receipt: { external_ref?: string; received_at?: string } | null;
      }>;
    }
  ).actions.map((action) => ({
    action_id: action.id,
    kind: action.kind,
    status: action.status,
    awaiting_approval: action.status === 'needs_approval',
    created_at: action.created_at,
    resolved_at: action.resolved_at,
    receipt: action.receipt
      ? { reference: action.receipt.external_ref ?? null, at: action.receipt.received_at ?? null }
      : null,
  }));
  const waiting = effects.filter((effect) => effect.awaiting_approval).length;
  return answer(
    `${view.title}: ${view.state.replace(/_/g, ' ')}.${waiting ? ` ${waiting} waiting for the person's approval in Melete.` : ''}`,
    { job_id: view.id, title: view.title, state: view.state, actions: effects },
  );
}

/** One `tools/call`, validated against the tool's own input and run as the actor. */
export async function callTool(deps: ToolDeps, name: string, args: unknown): Promise<ToolResult> {
  if (!Object.hasOwn(TOOL_INPUTS, name)) throw new UnknownTool(name);
  const tool = name as ToolName;
  const parsed = TOOL_INPUTS[tool].safeParse(args ?? {});
  if (!parsed.success)
    return refusal(
      `The arguments do not fit ${tool}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
        .join('; ')}`,
    );
  switch (tool) {
    case 'waiting_on':
      return waitingOn(deps);
    case 'handle':
      return handle(deps, parsed.data as z.infer<typeof TOOL_INPUTS.handle>);
    case 'safe_send':
      return safeSend(deps, parsed.data as z.infer<typeof TOOL_INPUTS.safe_send>);
    case 'remember':
      return remember(deps, parsed.data as z.infer<typeof TOOL_INPUTS.remember>);
    case 'recall':
      return recall(deps, parsed.data as z.infer<typeof TOOL_INPUTS.recall>);
    case 'status':
      return status(deps, parsed.data as z.infer<typeof TOOL_INPUTS.status>);
  }
}

/** `tools/call` for a name this server does not offer: a protocol error, not a tool result. */
export class UnknownTool extends Error {
  constructor(readonly tool: string) {
    super(`Unknown tool: ${tool}`);
  }
}
