import { randomUUID } from 'node:crypto';
import { TOOLS } from './destination.ts';
import type { Scenario } from './types.ts';

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
    if (last?.role === 'tool') {
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
