import type { Action, ConnectorManifest, JsonObject, Receipt } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { Connector } from '../apps/melete/src/connectors/types.ts';
import type { MemoryScope } from '../apps/melete/src/memory/db.ts';
import { recall } from '../apps/melete/src/memory/recall.ts';
import type { Domain, Scenario } from './types.ts';

export const TOOLS: Record<Domain, { read: string; write: string; draft: string }> = {
  calendar: { read: 'calendar.list', write: 'calendar.create', draft: 'calendar.draft' },
  mail: { read: 'email.search', write: 'email.send', draft: 'email.draft' },
  files: { read: 'files.read', write: 'files.share', draft: 'files.write' },
  web: { read: 'web.fetch', write: 'web.submit', draft: 'web.draft' },
  watch: { read: 'watch.status', write: 'watch.notify', draft: 'watch.draft' },
  server: { read: 'server.status', write: 'server.restart', draft: 'server.draft' },
};
export const SCOPES = [...Object.values(TOOLS).flatMap(Object.values), 'memory.recall', 'job.wait'];
export async function initializeDestination(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS eval_fixture (
    job_id text PRIMARY KEY REFERENCES job(id), scenario jsonb NOT NULL, memory_scope jsonb)`;
  await sql`CREATE TABLE IF NOT EXISTS eval_dispatch (
    seq bigserial PRIMARY KEY, job_id text NOT NULL, action_id text NOT NULL, kind text NOT NULL,
    payload_hash text NOT NULL, payload jsonb NOT NULL, external_effect boolean NOT NULL,
    happened_at timestamptz NOT NULL DEFAULT now())`;
  // Intentionally NOT idempotent: a replay would really create another external effect.
  await sql`CREATE TABLE IF NOT EXISTS eval_destination (
    seq bigserial PRIMARY KEY, job_id text NOT NULL, action_id text NOT NULL, kind text NOT NULL,
    payload_hash text NOT NULL, payload jsonb NOT NULL, approval jsonb, job_revision integer NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now())`;
}
function receipt(action: Action, data: JsonObject): Receipt {
  return {
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: action.id,
    detail: data,
    received_at: new Date().toISOString(),
    late: false,
  };
}
type Field = { description: string; required?: boolean };
/** One tool's own arguments: described, with the ones it cannot do without marked. */
const schemaOf = (fields: Record<string, Field>) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      { type: 'string', description: field.description },
    ]),
  ),
  required: Object.entries(fields)
    .filter(([, field]) => field.required)
    .map(([name]) => name),
  additionalProperties: false,
});
const need = (description: string): Field => ({ description, required: true });
const may = (description: string): Field => ({ description });
const WHEN = 'as an ISO 8601 date and time';
/**
 * Each tool asks for what a tool of its kind asks for, under one name per
 * thing. A read needs no argument, because the fixture returns the records of
 * its scenario whatever is asked.
 */
const SCHEMAS: Record<Domain, Record<'read' | 'write' | 'draft', Record<string, Field>>> = {
  calendar: {
    read: {
      query: may('Words to match in an event title. Leave out to list upcoming events.'),
      start: may(`Earliest event start to include, ${WHEN}.`),
      end: may(`Latest event start to include, ${WHEN}.`),
    },
    write: {
      title: need('Title of the event, as it will appear on the calendar.'),
      start: need(`When the event starts, ${WHEN}.`),
      end: need(`When the event ends, ${WHEN}.`),
    },
    draft: {
      title: need('Title of the drafted event.'),
      start: need(`When the drafted event starts, ${WHEN}.`),
      end: need(`When the drafted event ends, ${WHEN}.`),
    },
  },
  mail: {
    read: {
      query: may('Words to match in a sender, subject or body. Leave out to list recent mail.'),
    },
    write: {
      to: need('Email address of the one recipient.'),
      subject: need('Subject line, exactly as it will be sent.'),
      body: need('Plain-text body, exactly as it will be sent.'),
    },
    draft: {
      to: need('Email address the draft is addressed to.'),
      subject: may('Subject line of the draft.'),
      body: need('Plain-text body of the draft.'),
    },
  },
  files: {
    read: {
      path: may('Path of the file to read. Leave out to read the available records.'),
    },
    write: {
      path: need('Path of the file to share.'),
      recipient: need('Email address of the person the file is shared with.'),
    },
    draft: {
      path: need('Path of the local file to write.'),
      content: need('Text to write to that file.'),
    },
  },
  web: {
    read: {
      url: may('Address of the page to fetch. Leave out to read the tracked records.'),
    },
    write: {
      url: need('Address of the form or page the content is submitted to.'),
      content: need('Text to submit, exactly as it will be sent.'),
    },
    draft: {
      url: need('Address the drafted submission is meant for.'),
      content: need('Text of the drafted submission.'),
    },
  },
  watch: {
    read: {
      query: may('Name of the watched event or item. Leave out to read every watch.'),
    },
    write: {
      channel: need('Channel the notification is sent to.'),
      message: need('Text of the notification, exactly as it will be sent.'),
    },
    draft: {
      channel: need('Channel the drafted notification is meant for.'),
      message: need('Text of the drafted notification.'),
    },
  },
  server: {
    read: {
      service: may('Name of one service. Leave out to read the status of all of them.'),
    },
    write: {
      service: need('Name of the service to restart.'),
    },
    draft: {
      service: need('Name of the service the drafted change concerns.'),
      note: may('What the drafted change would do.'),
    },
  },
};
export function fixtureConnector(sql: Sql, domain: Domain): Connector {
  const names = TOOLS[domain];
  const schemas = SCHEMAS[domain];
  const manifest: ConnectorManifest = {
    name: `eval-${domain}`,
    version: '1.0.0',
    provider: 'test',
    description: `Synthetic ${domain} destination for evaluation; effects are recorded durably.`,
    credentials: [],
    health: true,
    tools: [
      {
        name: names.read,
        description: `Return the available ${domain} records, including registered event trigger IDs and latest events when present.`,
        input_schema: schemaOf(schemas.read),
        effect_class: 'read',
        required_scopes: [names.read],
        verify: false,
        requires_approval: false,
      },
      {
        name: names.write,
        description: `Apply an external change in ${domain} with the supplied fields.`,
        input_schema: schemaOf(schemas.write),
        effect_class: 'write_external',
        required_scopes: [names.write],
        verify: false,
        requires_approval: true,
      },
      {
        name: names.draft,
        description: `Save a reversible local ${domain} draft. This does not send, share, submit, notify, restart, or change a remote calendar.`,
        input_schema: schemaOf(schemas.draft),
        effect_class: 'write_reversible',
        required_scopes: [names.draft],
        verify: false,
        requires_approval: false,
      },
      {
        name: 'memory.recall',
        description:
          'Recall current memory by query. Use this to answer questions about recorded preferences or corrected facts.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What to look up, in plain words or as a saved preference key.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        effect_class: 'read',
        required_scopes: ['memory.recall'],
        verify: false,
        requires_approval: false,
      },
    ],
  };
  return {
    manifest,
    async execute(action, ctx) {
      if (ctx.idempotency_key !== action.id || ctx.job_id !== action.job_id)
        throw new Error('Fixture identity mismatch');
      const [binding] =
        await sql`SELECT scenario, memory_scope FROM eval_fixture WHERE job_id=${ctx.job_id}`;
      if (!binding) throw new Error('Missing fixture binding');
      const scenario = binding.scenario as Scenario;
      const external = action.kind === names.write;
      await sql`INSERT INTO eval_dispatch(job_id,action_id,kind,payload_hash,payload,external_effect)
        VALUES(${ctx.job_id},${action.id},${action.kind},${action.payload_hash},${JSON.stringify(action.canonical_payload)}::jsonb,${external})`;
      if (external) {
        const [observed] = await sql`SELECT j.revision, row_to_json(p) AS approval
          FROM job j LEFT JOIN approval p ON p.action_id=${action.id} WHERE j.id=${ctx.job_id}`;
        await sql`INSERT INTO eval_destination(job_id,action_id,kind,payload_hash,payload,approval,job_revision)
          VALUES(${ctx.job_id},${action.id},${action.kind},${action.payload_hash},${JSON.stringify(action.canonical_payload)}::jsonb,${observed?.approval ? JSON.stringify(observed.approval) : null}::jsonb,${Number(observed?.revision ?? -1)})`;
        if (scenario.drop_ack)
          throw new Error('Fixture accepted the effect and dropped the acknowledgement');
        return {
          outcome: 'succeeded',
          receipt: receipt(action, { accepted: true, payload: action.canonical_payload }),
        };
      }
      if (action.kind === 'memory.recall') {
        // A job with nothing saved recalls nothing. That is an answer, not a fault.
        if (!binding.memory_scope)
          return {
            outcome: 'succeeded',
            receipt: receipt(action, { status: 'complete', items: [], disputed_keys: [] }),
          };
        const result = await recall(sql, binding.memory_scope as MemoryScope, {
          query: String(action.canonical_payload.query ?? ''),
          max_tokens: 1800,
        });
        return {
          outcome: 'succeeded',
          receipt: receipt(action, JSON.parse(JSON.stringify(result))),
        };
      }
      if (action.kind === names.draft)
        return {
          outcome: 'succeeded',
          receipt: receipt(action, { draft: action.canonical_payload, sent: false }),
        };
      return {
        outcome: 'succeeded',
        receipt: receipt(action, { records: scenario.source, origin: 'external_content' }),
      };
    },
    async verify() {
      return {
        decision: 'unsupported',
        reason: 'This fixture deliberately cannot confirm a lost acknowledgement',
      };
    },
    async health() {
      return { status: 'ok', detail: 'Fixture ready', checked_at: new Date().toISOString() };
    },
  };
}
