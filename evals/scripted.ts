import { randomUUID } from 'node:crypto';
import { TOOLS } from './destination.ts';
import type { Scenario, ScriptedStep } from './types.ts';

type Message = { role: string; content?: unknown };
const parsed = (content: unknown): unknown => {
  try {
    return JSON.parse(String(content));
  } catch {
    return undefined;
  }
};
const isLoad = (message: Message) =>
  message.role === 'tool' &&
  (parsed(message.content) as { status?: string } | undefined)?.status === 'tools_loaded';

/** A dotted path (array indices allowed) read from the first object, at any depth, that has it. */
export function lookup(value: unknown, path: string): unknown {
  const read = (node: unknown) =>
    path.split('.').reduce<unknown>((current, key) => {
      if (current === null || current === undefined || typeof current !== 'object')
        return undefined;
      return (current as Record<string, unknown>)[key];
    }, node);
  const queue: unknown[] = [value];
  while (queue.length) {
    const node = queue.shift();
    const found = read(node);
    if (found !== undefined) return found;
    if (node && typeof node === 'object') queue.push(...Object.values(node));
  }
  return undefined;
}

/**
 * Fill `{"$ref": "path"}` from the latest tool result that has the path, and
 * `{"$ref": "$approved"}` from the approval the attempt input names.
 */
export function resolveRefs(value: unknown, messages: readonly Message[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, messages));
  if (!value || typeof value !== 'object') return value;
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref === 'string' && Object.keys(value).length === 1) {
    if (ref === '$form_url') {
      for (const message of messages) {
        const match = /http:\/\/127\.0\.0\.1:\d+\/rsvp\?run=[0-9a-f]+/.exec(
          String(message.content),
        );
        if (match) return match[0];
      }
      return undefined;
    }
    if (ref === '$approved') {
      for (const message of [...messages].reverse())
        if (message.role === 'user') {
          const match = /resume_action with action_id "([^"]+)"/.exec(String(message.content));
          if (match) return match[1];
        }
      return undefined;
    }
    for (const message of [...messages].reverse()) {
      if (message.role !== 'tool') continue;
      const found = lookup(parsed(message.content), ref);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveRefs(item, messages)]),
  );
}

/** The objective of the separate check a piece of background work runs on its result. */
const CHECK_OBJECTIVE = 'Check whether a result is really done';

/**
 * Whose turn this request is: the scenario's own conversation (`main`), a
 * shift of background work it started (`run`), or that work's check of its
 * result (`check`). Each plays its own plan.
 */
export function roleOf(
  messages: readonly Message[],
  tools: readonly string[] = [],
): 'main' | 'run' | 'check' {
  const text = messages.map((message) => String(message.content ?? '')).join('\n');
  if (text.includes(CHECK_OBJECTIVE)) return 'check';
  if (tools.includes('run.checkpoint') || tools.includes('run.finish')) return 'run';
  const system = messages.find((message) => message.role === 'system');
  if (system && /\brun\.checkpoint\b/.test(String(system.content ?? ''))) return 'run';
  return 'main';
}

const resumingIn = (messages: readonly Message[]) =>
  messages.some(
    (message) =>
      message.role === 'user' && String(message.content).includes('resume_action with action_id'),
  );

/** Whether a scenario's plan is divided between the messages of its conversation. */
export const plannedByTurn = (scenario: Scenario) =>
  (scenario.steps ?? []).some((step) => step.turn !== undefined);

/**
 * Which message of the conversation this request answers: 0 for the
 * objective, then one per message of `history`, found by its words.
 */
export function turnOf(scenario: Scenario, messages: readonly Message[]): number {
  const said = [scenario.objective, ...(scenario.history ?? [])];
  let turn = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = String(message.content ?? '');
    said.forEach((text, index) => {
      if (index > turn && text.length && content.includes(text)) turn = index;
    });
  }
  return turn;
}

/**
 * The next planned call, counted by the tool results this attempt has already
 * had. An attempt that was told to resume an approval follows the plan after it.
 * A plan divided by turn is counted from the message that started this turn.
 */
export function plannedStep(
  scenario: Scenario,
  messages: readonly Message[],
  role: 'main' | 'run' | 'check' = 'main',
): ScriptedStep | undefined {
  const resuming = resumingIn(messages);
  const background = scenario.background ?? {};
  let plan: ScriptedStep[];
  let from = 0;
  if (role === 'check') plan = background.check ?? [];
  else if (role === 'run')
    plan = resuming
      ? [...RESUME_PLAN, ...(background.after_approval ?? [])]
      : (background.steps ?? []);
  else if (resuming) plan = scenario.approve ? RESUME_PLAN : [];
  else if (plannedByTurn(scenario)) {
    const turn = turnOf(scenario, messages);
    const last = scenario.history?.length ?? 0;
    plan = (scenario.steps ?? []).filter((step) => (step.turn ?? last) === turn);
    const said = [scenario.objective, ...(scenario.history ?? [])][turn] ?? '';
    for (const [index, message] of messages.entries())
      if (message.role === 'user' && String(message.content ?? '').includes(said)) from = index;
  } else plan = scenario.steps ?? [];
  // In a shift that resumes, the plan restarts at the message that told it to.
  if (role === 'run' && resuming)
    for (const [index, message] of messages.entries())
      if (
        message.role === 'user' &&
        String(message.content).includes('resume_action with action_id')
      )
        from = index;
  const done = messages
    .slice(from)
    .filter((message) => message.role === 'tool' && !isLoad(message)).length;
  const step = plan[done];
  if (!step) return undefined;
  return {
    tool: step.tool,
    arguments: resolveRefs(step.arguments, messages) as ScriptedStep['arguments'],
  };
}
const RESUME_PLAN: ScriptedStep[] = [
  { tool: 'resume_action', arguments: { action_id: { $ref: '$approved' } } },
];

/** A transport fixture, not an alternative runtime. Hermes still executes every tool call. */
export class ScriptedModel {
  scenario: Scenario | null = null;
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname !== 'scripted.evals.invalid')
      throw new Error('Scripted transport refused an external endpoint');
    const scenario = this.scenario;
    if (!scenario) throw new Error('No scenario selected');
    const body = (await request.json()) as {
      model: string;
      stream?: boolean;
      messages: { role: string; content?: unknown }[];
      tools?: { function: { name: string } }[];
    };
    let last = body.messages.at(-1);
    if (last?.role === 'tool') {
      try {
        if (JSON.parse(String(last.content)).status === 'tools_loaded') last = undefined;
      } catch {
        /* Invalid results remain visible below. */
      }
    }
    let content: string | null = null;
    let toolCalls:
      | { id: string; type: string; function: { name: string; arguments: string } }[]
      | undefined;
    const history = scenario.history ?? [];
    const finalTurn = history.at(-1);
    const role = roleOf(
      body.messages,
      (body.tools ?? []).map((tool) => tool.function.name),
    );
    if (role !== 'main') {
      const step = plannedStep(scenario, body.messages, role);
      if (step)
        toolCalls = [
          {
            id: `call_${randomUUID().replaceAll('-', '')}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.arguments) },
          },
        ];
      else content = role === 'check' ? 'Checked.' : 'Shift over.';
    } else if (plannedByTurn(scenario)) {
      const step = plannedStep(scenario, body.messages);
      const turn = turnOf(scenario, body.messages);
      if (step)
        toolCalls = [
          {
            id: `call_${randomUUID().replaceAll('-', '')}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.arguments) },
          },
        ];
      else
        content =
          turn < history.length
            ? (scenario.replies?.[turn] ?? 'Noted.')
            : (scenario.script.reply ?? 'Done.');
    } else if (
      finalTurn &&
      !body.messages.some((message) => String(message.content ?? '').includes(finalTurn))
    )
      // An earlier turn of a long conversation gets a short acknowledgement.
      content = 'Noted.';
    else if (scenario.steps) {
      const step = plannedStep(scenario, body.messages);
      if (step)
        toolCalls = [
          {
            id: `call_${randomUUID().replaceAll('-', '')}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.arguments) },
          },
        ];
      else content = scenario.script.reply ?? 'Done.';
    } else if (last?.role === 'tool') {
      let result: Record<string, unknown> = {};
      try {
        result = JSON.parse(String(last.content));
      } catch {
        /* Fail visibly below. */
      }
      if (result.status === 'waiting_for_event_or_time')
        content = 'Waiting for the registered event.';
      else if (result.status === 'needs_approval')
        content = 'Waiting for your approval. Nothing has been sent.';
      else if (result.status === 'unknown' || result.status === 'unresolved')
        content = 'The outcome is unconfirmed. I have not repeated it.';
      else if (result.status !== 'succeeded')
        content = 'The tool did not provide a confirmed result.';
      else {
        const detail = (result.receipt as { detail?: Record<string, unknown> } | undefined)?.detail;
        if (scenario.script.tool === 'memory' || (scenario.memory && detail?.items)) {
          const items = detail?.items as { content: string; handle: string }[] | undefined;
          content = items?.length
            ? items.map((item) => `${item.content} (${item.handle})`).join('\n')
            : 'No current memory was returned.';
          if (scenario.trigger) content = `${String(scenario.trigger.payload.answer)} ${content}`;
        } else if (scenario.script.tool === 'read') {
          const records = detail?.records as { answer?: string; trigger_id?: string } | undefined;
          if (scenario.trigger && records?.trigger_id) {
            toolCalls = [
              {
                id: `call_${randomUUID().replaceAll('-', '')}`,
                type: 'function',
                function: {
                  name: 'job.wait',
                  arguments: JSON.stringify({
                    kind: 'event',
                    trigger_id: records.trigger_id,
                    deadline_at: null,
                  }),
                },
              },
            ];
          } else if (scenario.memory && scenario.trigger) {
            toolCalls = [
              {
                id: `call_${randomUUID().replaceAll('-', '')}`,
                type: 'function',
                function: {
                  name: 'memory.recall',
                  arguments: JSON.stringify({ query: scenario.memory.key }),
                },
              },
            ];
          } else
            content =
              records?.answer ?? scenario.script.reply ?? 'No readable record was returned.';
        } else if (scenario.script.tool === 'draft')
          content = 'Draft saved locally. Nothing was sent.';
        else content = `Confirmed. Receipt ${String(result.action_id)}.`;
      }
    } else if (scenario.script.tool === 'none') content = scenario.script.reply ?? 'Acknowledged.';
    else {
      const name =
        scenario.script.tool === 'memory'
          ? 'memory.recall'
          : TOOLS[scenario.domain][scenario.script.tool];
      toolCalls = [
        {
          id: `call_${randomUUID().replaceAll('-', '')}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(scenario.script.arguments) },
        },
      ];
    }
    const desired = toolCalls?.[0]?.function.name;
    if (desired && body.tools && !body.tools.some((tool) => tool.function.name === desired)) {
      toolCalls = [
        {
          id: `call_${randomUUID().replaceAll('-', '')}`,
          type: 'function',
          function: { name: 'load_tool', arguments: JSON.stringify({ name: desired }) },
        },
      ];
    }
    const finish = toolCalls ? 'tool_calls' : 'stop';
    const usage = {
      prompt_tokens: Math.ceil(JSON.stringify(body).length / 4),
      completion_tokens: Math.ceil(JSON.stringify({ content, toolCalls }).length / 4),
      total_tokens: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const base = {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    if (!body.stream)
      return Response.json({
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      });
    const chunks = [
      {
        ...base,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              ...(content !== null ? { content } : {}),
              ...(toolCalls
                ? { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) }
                : {}),
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage,
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
}
