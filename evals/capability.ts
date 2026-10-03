/**
 * Capability scenarios: what a person would ask Melete to do, measured on the
 * real broker and ledger.
 *
 * Each scenario declares its own fixture tools. A tool that mirrors one the
 * product ships carries the product's own name, description, schema and effect
 * class, so the model sees what it would see in a real space and only the
 * result comes from the fixture. A scenario that needs something the product
 * does not have on this commit (a tool, chat attachments, a local Chromium) is
 * skipped with the reason, never failed and never faked.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type Action,
  type ConnectorManifest,
  type JsonObject,
  type JsonValue,
  postMessageRequest,
  type Receipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { browserManifest, createBrowserConnector } from '../apps/melete/src/connectors/browser.ts';
import { emailManifest } from '../apps/melete/src/connectors/email.ts';
import { filesManifest } from '../apps/melete/src/connectors/files.ts';
import {
  sandboxDispatchBudgetMs,
  sandboxTerminalManifest,
} from '../apps/melete/src/connectors/sandbox-exec.ts';
import type { Connector } from '../apps/melete/src/connectors/types.ts';
import { webManifest } from '../apps/melete/src/connectors/web.ts';
import type { FixtureTool, Scenario } from './types.ts';

type ManifestTool = ConnectorManifest['tools'][number];

/** Product tools a fixture may mirror. Read at load time, so a tool that lands is picked up. */
const PRODUCT_TOOLS = new Map<string, ManifestTool>(
  [
    ...webManifest.tools,
    ...emailManifest.tools,
    ...filesManifest.tools,
    ...sandboxTerminalManifest.tools,
    ...browserManifest.tools,
  ].map((tool) => [tool.name, tool]),
);
/** Broker-owned tools every attempt can be offered. */
const NATIVE_TOOLS = new Set(['ask_person', 'react', 'job.wait', 'resume_action', 'say']);

export const productHasTool = (name: string) => PRODUCT_TOOLS.has(name) || NATIVE_TOOLS.has(name);

/** Whether the chat message contract accepts attachments on this commit. */
export function attachmentsInContract(): boolean {
  const shape = (postMessageRequest as unknown as { shape?: Record<string, unknown> }).shape;
  return !!shape && 'attachments' in shape;
}

async function chromium(): Promise<{ available: boolean; reason: string }> {
  const { chromiumAvailable, chromiumMissingReason } = await import(
    '../apps/melete/src/workers/browser/available.ts'
  );
  return { available: chromiumAvailable, reason: chromiumMissingReason };
}

/** Why this scenario cannot run on this commit and host, or null when it can. */
export async function unmetRequirement(scenario: Scenario): Promise<string | null> {
  for (const requirement of scenario.requires ?? []) {
    if ('tool' in requirement) {
      if (!productHasTool(requirement.tool))
        return `The product has no ${requirement.tool} tool on this commit.`;
    } else if (requirement.feature === 'attachments') {
      if (!attachmentsInContract()) return 'Chat attachments are not on this commit.';
    } else if (requirement.feature === 'browser') {
      const browser = await chromium();
      if (!browser.available) return `The agent's browser cannot start here: ${browser.reason}.`;
    }
  }
  for (const tool of scenario.tools ?? [])
    if (tool.mirror && !PRODUCT_TOOLS.has(tool.mirror))
      return `The product has no ${tool.mirror} tool to mirror on this commit.`;
  return null;
}

const schemaOf = (fields: NonNullable<FixtureTool['fields']>) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      { type: field.type ?? 'string', description: field.description },
    ]),
  ),
  required: Object.entries(fields)
    .filter(([, field]) => field.required)
    .map(([name]) => name),
  additionalProperties: false,
});

/** The manifest entry a fixture tool is offered under. */
export function manifestTool(tool: FixtureTool): ManifestTool {
  const base = tool.mirror ? PRODUCT_TOOLS.get(tool.mirror) : undefined;
  if (tool.mirror && !base) throw new Error(`No product tool ${tool.mirror} to mirror`);
  const effect = tool.effect_class ?? base?.effect_class ?? 'read';
  return {
    name: tool.name,
    description: tool.description ?? base?.description ?? `Fixture tool ${tool.name}.`,
    input_schema: tool.fields
      ? schemaOf(tool.fields)
      : (base?.input_schema ?? { type: 'object', properties: {}, additionalProperties: false }),
    effect_class: effect,
    required_scopes: [tool.name],
    verify: false,
    requires_approval: effect === 'write_external' || effect === 'spend',
  };
}

export const isExternal = (effect: string) => effect === 'write_external' || effect === 'spend';

const normalizedKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '');

/** What a call returns: the result chosen by an argument, or the tool's one result. */
export function fixtureResult(tool: FixtureTool, payload: JsonObject): JsonValue {
  if (tool.results_by) {
    const wanted = payload[tool.results_by.argument];
    const results = tool.results_by.results;
    if (typeof wanted === 'string') {
      if (wanted in results) return results[wanted] ?? null;
      const key = normalizedKey(wanted);
      for (const [candidate, result] of Object.entries(results))
        if (normalizedKey(candidate) === key) return result;
    }
    return { status: 404, text: 'Nothing was found at that address.' };
  }
  return tool.result ?? { saved: true };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done, reject) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

function receipt(action: Action, detail: JsonObject): Receipt {
  return {
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: action.id,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  };
}

/** The fixture connection of one capability scenario. External effects land in the destination table. */
export function capabilityConnector(sql: Sql, scenario: Scenario): Connector {
  const tools = scenario.tools ?? [];
  const manifest: ConnectorManifest = {
    name: `eval-${scenario.id}`,
    version: '1.0.0',
    provider: 'test',
    description: `Synthetic destination for the ${scenario.title} evaluation; effects are recorded durably.`,
    credentials: [],
    health: true,
    tools: tools.map(manifestTool),
  };
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    manifest,
    dispatchBudgetMs(action) {
      const tool = byName.get(action.kind);
      if (tool?.mirror === 'terminal.run') return sandboxDispatchBudgetMs(action);
      return tool?.delay_ms ? tool.delay_ms + 30_000 : 30_000;
    },
    async execute(action, ctx) {
      if (ctx.idempotency_key !== action.id || ctx.job_id !== action.job_id)
        throw new Error('Fixture identity mismatch');
      const tool = byName.get(action.kind);
      if (!tool) throw new Error(`Fixture has no ${action.kind}`);
      const entry = manifestTool(tool);
      const external = isExternal(entry.effect_class);
      const payload = action.canonical_payload;
      await sql`INSERT INTO eval_dispatch(job_id,action_id,kind,payload_hash,payload,external_effect)
        VALUES(${ctx.job_id},${action.id},${action.kind},${action.payload_hash},${JSON.stringify(payload)}::jsonb,${external})`;
      if (external) {
        const [observed] = await sql`SELECT j.revision, row_to_json(p) AS approval
          FROM job j LEFT JOIN approval p ON p.action_id=${action.id} WHERE j.id=${ctx.job_id}`;
        await sql`INSERT INTO eval_destination(job_id,action_id,kind,payload_hash,payload,approval,job_revision)
          VALUES(${ctx.job_id},${action.id},${action.kind},${action.payload_hash},${JSON.stringify(payload)}::jsonb,${observed?.approval ? JSON.stringify(observed.approval) : null}::jsonb,${Number(observed?.revision ?? -1)})`;
        return {
          outcome: 'succeeded',
          receipt: receipt(action, { accepted: true, payload }),
        };
      }
      const matched =
        !tool.when ||
        String(payload[tool.when.argument] ?? '')
          .toLowerCase()
          .includes(tool.when.contains.toLowerCase());
      if (!matched && tool.when) {
        const otherwise = tool.when.otherwise;
        return {
          outcome: 'succeeded',
          receipt: receipt(
            action,
            otherwise && typeof otherwise === 'object' && !Array.isArray(otherwise)
              ? (otherwise as JsonObject)
              : { result: otherwise },
          ),
        };
      }
      if (tool.delay_ms) {
        // A command ends at its own time limit, as it would on the agent's computer.
        const limit = typeof payload.timeout_ms === 'number' ? payload.timeout_ms : undefined;
        if (limit !== undefined && limit < tool.delay_ms) {
          await sleep(limit, ctx.signal);
          return {
            outcome: 'succeeded',
            receipt: receipt(action, {
              exit_code: 124,
              timed_out: true,
              duration_ms: limit,
              output: 'The command was still running when its time limit stopped it.',
            }),
          };
        }
        await sleep(tool.delay_ms, ctx.signal);
      }
      const result = fixtureResult(tool, payload);
      if (entry.effect_class === 'read')
        return {
          outcome: 'succeeded',
          receipt: receipt(action, { records: result, origin: 'external_content' }),
        };
      return {
        outcome: 'succeeded',
        receipt: receipt(
          action,
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as JsonObject)
            : { result },
        ),
      };
    },
    async verify() {
      return {
        decision: 'unsupported',
        reason: 'This fixture cannot confirm a lost acknowledgement',
      };
    },
    async health() {
      return { status: 'ok', detail: 'Fixture ready', checked_at: new Date().toISOString() };
    },
  };
}

/** Every scope a capability scenario's attempt needs. */
export const capabilityScopes = (scenarios: readonly Scenario[]) => [
  ...new Set(scenarios.flatMap((scenario) => (scenario.tools ?? []).map((tool) => tool.name))),
];

export const usesBrowser = (scenario: Scenario) =>
  (scenario.requires ?? []).some((entry) => 'feature' in entry && entry.feature === 'browser');

/**
 * A local page with one native form, and the agent's real browser worker
 * pointed at it. The page records each submission it receives, by run.
 */
export async function openBrowserFixture(sql: Sql, root: string) {
  const submissions: { run: string; fields: Record<string, string> }[] = [];
  const page = (run: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Garden party RSVP</title></head>
<body><main><h1>Garden party RSVP</h1>
<p>Saturday 14 November, 3 pm. Please answer by Friday.</p>
<form method="post" action="/rsvp/submit?run=${encodeURIComponent(run)}">
<label for="name">Your name</label><input id="name" name="name" required>
<label for="guests">Number of guests</label><input id="guests" name="guests" required>
<label for="diet">Dietary needs</label><input id="diet" name="diet">
<button type="submit">Send RSVP</button>
</form></main></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const run = url.searchParams.get('run') ?? '';
      if (url.pathname === '/rsvp' && request.method === 'GET')
        return new Response(page(run), { headers: { 'content-type': 'text/html' } });
      if (url.pathname === '/rsvp/submit' && request.method === 'POST') {
        const body = new URLSearchParams(await request.text());
        submissions.push({ run, fields: Object.fromEntries(body) });
        return new Response(
          '<!doctype html><html lang="en"><body><h1>Thank you</h1><p>Your RSVP was received.</p></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('Not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const { BrowserWorkerPool } = await import('../apps/melete/src/workers/browser/client.ts');
  const { BrowserSessionService } = await import('../apps/melete/src/workers/browser/routes.ts');
  const { browserArtifactSink } = await import('../apps/melete/src/workers/browser/artifacts.ts');
  await mkdir(root, { recursive: true });
  const pool = new BrowserWorkerPool({
    spacesRoot: root,
    allowLocalProcess: true,
    // The repository's fixture-only worker entry, which admits this loopback origin.
    workerEntry: new URL('../apps/melete/test/helpers/browser-child.ts', import.meta.url),
    workerArguments: [origin],
  });
  const sessions = new BrowserSessionService(sql, pool);
  const connector = (spaceId: string) =>
    createBrowserConnector({
      sessions,
      spaceId,
      artifacts: browserArtifactSink(sql, resolve(root)),
    });
  return {
    origin,
    connector,
    submissions: (run: string) => submissions.filter((entry) => entry.run === run),
    async close() {
      await pool.close();
      await server.stop(true);
    },
  };
}
export type BrowserFixture = Awaited<ReturnType<typeof openBrowserFixture>>;
