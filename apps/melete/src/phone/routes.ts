/**
 * The routes ElevenLabs calls for a phone line, and the owner's view of a call.
 *
 * Three routes are reachable without a session, because ElevenLabs holds none:
 * the turn endpoint, the start of an inbound call, and the report at the end
 * of a call. Each is scoped to one line by its address. The first two accept
 * only the line's own key, compared digest to digest in constant time, so one
 * line's key opens nothing on another; the report is accepted only with a
 * valid signature from the line's webhook secret, over the bytes that arrived.
 */
import {
  ID_PREFIXES,
  phoneCallResponse,
  phoneEventRequest,
  phoneInboundRequest,
  phoneInboundResponse,
  phoneTurnRequest,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { connectorFactoryFor, connectorOptionsFromEnv } from '../connectors/configured.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import type { Env } from '../env.ts';
import type { JobService } from '../jobs/service.ts';
import { memoryScopeForSpace } from '../memory/broker-trust.ts';
import type { MemorySql } from '../memory/db.ts';
import { recall } from '../memory/recall.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { callForReport, callNotConnected, finishCall, startInbound } from './calls.ts';
import { conversationRecord, ElevenLabsClient, type Fetch } from './elevenlabs.ts';
import { lineKeyMatches, signatureValid } from './keys.ts';
import { type Line, readLine, withLineSecret } from './line.ts';
import { type CallModel, configuredCallModel } from './model.ts';
import { LINE_KEY_HEADER } from './provision.ts';
import { answerTurn, type CallRow, type Recall } from './turns.ts';

export type PhoneRouteDeps = {
  db: Database;
  sql: Sql;
  env: Env;
  registry: ConnectorRegistry;
  jobs?: JobService;
  /** The model a turn is answered by; left out, the gateway model this deployment configures. */
  model?: () => Promise<CallModel>;
  /** Memory recall for the line's person; left out, memory's own bounded read. */
  recall?: Recall;
};

const refused = (c: Context) =>
  c.json({ error: { code: 'unauthorized', message: 'This line does not accept that key.' } }, 401);

/** Memory's own bounded read for the line's space, or nothing when memory has no space for it. */
export function memoryRecall(sql: Sql): Recall {
  return async ({ spaceId, query, jobId }) => {
    if (!query.trim()) return [];
    const scope = await memoryScopeForSpace(sql, spaceId);
    if (!scope) return [];
    const result = await recall(
      sql as unknown as MemorySql,
      scope,
      { query, limit: 8, ...(jobId ? { job_id: jobId } : {}) },
      { deadlineMs: 400 },
    );
    return result.items.map((item) => item.content);
  };
}

const chunk = (id: string, delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'melete',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

export function mountPhone(app: Hono, deps: PhoneRouteDeps) {
  const factory = connectorFactoryFor(deps.registry, () =>
    connectorOptionsFromEnv(deps.sql, deps.env),
  );
  const phone = () => factory.options.phone;
  const model = deps.model ?? configuredCallModel(deps.env);
  const turnDeps = { sql: deps.sql, model, recall: deps.recall ?? memoryRecall(deps.sql) };
  const records = { sql: deps.sql, ...(deps.jobs ? { jobs: deps.jobs } : {}) };

  /** The line this request names, when it presents that line's key. */
  const keyedLine = async (c: Context): Promise<Line | null> => {
    const line = await readLine(deps.sql, c.req.param('id') ?? '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const header = c.req.header(LINE_KEY_HEADER);
    const digest = line?.stored.line_key_digest;
    // Both are compared whichever matches, so the answer takes the same time.
    const matched = [lineKeyMatches(bearer, digest), lineKeyMatches(header, digest)].some(Boolean);
    return line && line.status === 'active' && matched ? line : null;
  };

  const turn = async (c: Context) => {
    const line = await keyedLine(c);
    if (!line) return refused(c);
    const parsed = phoneTurnRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ServiceError('invalid_request', 'The turn is not a chat completions request.', 400);
    const request = parsed.data;
    const answer = await answerTurn(turnDeps, line, {
      messages: request.messages,
      extra: request.elevenlabs_extra_body,
    });
    // Hanging up is ElevenLabs' own tool; it is asked for only when the call offers it.
    const canEnd = (request.tools ?? []).some(
      (tool) =>
        tool &&
        typeof tool === 'object' &&
        'function' in tool &&
        (tool as { function?: { name?: unknown } }).function?.name === 'end_call',
    );
    const end = canEnd ? answer.endCall : null;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const toolCall = end
      ? {
          index: 0,
          id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
          type: 'function',
          function: { name: 'end_call', arguments: JSON.stringify(end) },
        }
      : null;
    if (request.stream === false)
      return c.json({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'melete',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: answer.text,
              ...(toolCall ? { tool_calls: [{ ...toolCall, index: undefined }] } : {}),
            },
            finish_reason: toolCall ? 'tool_calls' : 'stop',
          },
        ],
      });
    const body =
      chunk(id, { role: 'assistant', content: answer.text }, null) +
      (toolCall ? chunk(id, { tool_calls: [toolCall] }, null) : '') +
      chunk(id, {}, toolCall ? 'tool_calls' : 'stop') +
      'data: [DONE]\n\n';
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  };
  app.post('/phone/:id/llm/v1/chat/completions', turn);
  app.post('/phone/:id/llm/v1', turn);

  app.post('/phone/:id/inbound', async (c) => {
    const line = await keyedLine(c);
    if (!line) return refused(c);
    const parsed = phoneInboundRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new ServiceError('invalid_request', 'The call start could not be read.', 400);
    const started = await startInbound(records, line, {
      ...(parsed.data.caller_id ? { callerId: parsed.data.caller_id } : {}),
      ...(parsed.data.conversation_id ? { conversationId: parsed.data.conversation_id } : {}),
    });
    return c.json(
      phoneInboundResponse.parse({
        type: 'conversation_initiation_client_data',
        conversation_config_override: { agent: { first_message: started.opening } },
        custom_llm_extra_body: { call_id: started.callId },
      }),
    );
  });

  app.post('/phone/:id/events', async (c) => {
    const raw = await c.req.text();
    const line = await readLine(deps.sql, c.req.param('id'));
    if (line?.status !== 'active') return refused(c);
    const options = phone();
    const client = { apiBase: options?.apiBase, fetch: options?.fetch as Fetch | undefined };
    const signed = await withLineSecret(factory.secrets, line, async (credentials) => ({
      valid: signatureValid(raw, c.req.header('elevenlabs-signature'), credentials.webhook_secret),
      apiKey: credentials.api_key,
    })).catch(() => ({ valid: false, apiKey: '' }));
    if (!signed.valid)
      return c.json(
        { error: { code: 'unauthorized', message: 'The report is not signed by this line.' } },
        401,
      );
    let event: ReturnType<typeof phoneEventRequest.parse>;
    try {
      event = phoneEventRequest.parse(JSON.parse(raw));
    } catch {
      throw new ServiceError('invalid_request', 'The report could not be read.', 400);
    }
    const conversationId =
      typeof event.data.conversation_id === 'string' ? event.data.conversation_id : null;
    if (event.type === 'post_call_transcription') {
      let record = conversationRecord.safeParse(event.data).data ?? {};
      const call = await callForReport(deps.sql, line.id, record, conversationId);
      if (!call) return c.json({ received: true });
      // A report without its transcript is completed from the conversation itself.
      if (!record.transcript?.length && conversationId) {
        const fetched = await new ElevenLabsClient(signed.apiKey, {
          ...(client.apiBase ? { base: client.apiBase } : {}),
          ...(client.fetch ? { fetch: client.fetch } : {}),
        })
          .getConversation(conversationId)
          .catch(() => null);
        if (fetched) record = { ...fetched, ...record, transcript: fetched.transcript };
      }
      await finishCall(records, line, call, record);
    } else if (event.type === 'call_initiation_failure') {
      const call = await callForReport(deps.sql, line.id, {}, conversationId);
      if (call)
        await callNotConnected(
          records,
          call,
          typeof event.data.failure_reason === 'string' ? event.data.failure_reason : undefined,
        );
    }
    return c.json({ received: true });
  });

  app.get('/phone-calls/:id', async (c) => {
    const id = c.req.param('id');
    if (!new RegExp(`^${ID_PREFIXES.phone_call}_[0-9A-Z]{26}$`).test(id))
      throw new ServiceError('not_found', 'No call by that id.', 404);
    const [call] = await deps.sql<Array<CallRow & Record<string, unknown>>>`select * from phone_call
      where id = ${id}`;
    if (!call) throw new ServiceError('not_found', 'No call by that id.', 404);
    const access = await spaceAuthority(deps.db, call.space_id, c.get('owner').id).catch(
      () => null,
    );
    if (access?.role !== 'owner') throw new ServiceError('not_found', 'No call by that id.', 404);
    return c.json(
      phoneCallResponse.parse({
        call: {
          id: call.id,
          connection_id: call.connection_id,
          job_id: call.job_id,
          direction: call.direction,
          party: call.party,
          remote_number: call.remote_number,
          purpose: call.context?.purpose ?? null,
          status: call.status,
          outcome: call.outcome,
          follow_ups: call.follow_ups ?? [],
          transcript: call.transcript ?? [],
          duration_seconds: call.duration_seconds ?? null,
          failure: call.failure ?? null,
          created_at: new Date(call.created_at).toISOString(),
          ended_at: call.ended_at ? new Date(String(call.ended_at)).toISOString() : null,
        },
      }),
    );
  });
}
