/**
 * What a long chat sends per turn, before and after context budgets follow the
 * model's window and per-turn material moved behind the cached prefix.
 *
 * "Before" reproduces the earlier assembly: the baseline budgets on every
 * model, and recalled knowledge in the system prompt. "After" is the current
 * assembly for a million-token model. Each turn's request is laid out the way
 * the engine sends it (tool definitions, then the system prompt, then the
 * input), and the part it shares with the previous turn's request is what a
 * provider can serve from its prompt cache. Run this file on its own to print
 * the per-turn table.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  BASELINE_CONTEXT_BUDGET,
  type CanonicalMessage,
  EMPTY_SINCE_LAST,
  type ToolSpec,
} from '@melete/contracts';
import {
  renderInput,
  renderInstructions,
  renderKnowledge,
  renderSoul,
} from '@melete/runtime-hermes';
import { estimateTokens } from '@melete/skills';
import { applyPromptCaching } from '../gateway/caching.ts';
import { boundTranscript, transcriptLimits } from './bundle.ts';
import { attemptContextBudget } from './context-budget.ts';

const LARGE_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
const TURNS = 60;
const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';

/** A chat turn as a person and an assistant might write it: a few hundred and a thousand-odd characters. */
function chat(turns: number): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, turn)).toISOString();
    messages.push({
      role: 'user',
      content: `Turn ${turn}: ${'Here is what I need next, with the details that matter. '.repeat(6)}`,
      at,
    });
    messages.push({
      role: 'assistant',
      content: `Answer ${turn}: ${'I checked the records and here is what they say, step by step. '.repeat(18)}`,
      at,
    });
  }
  return messages;
}

/** A granted catalog of ordinary connector verbs. */
const catalog: ToolSpec[] = Array.from({ length: 48 }, (_, index) => ({
  name: `service${index % 6}.verb_${index}`,
  description: `Do one ordinary thing in service ${index % 6}, such as reading or updating a record.`,
  effect_class: index % 3 === 0 ? 'write_external' : 'read',
  connection_id: `conn_${SUFFIX}`,
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id'],
  },
}));

/** The first tools that fit a budget, in a fixed order. */
function toolsWithin(tokens: number): ToolSpec[] {
  const chosen: ToolSpec[] = [];
  for (const tool of catalog) {
    if (estimateTokens(JSON.stringify([...chosen, tool])) > tokens) break;
    chosen.push(tool);
  }
  return chosen;
}

/** Knowledge recalled for the latest message: it differs from turn to turn. */
const recalled = (turn: number): AttemptBundle['knowledge'] => [
  {
    path: `knowledge/topic-${turn % 7}.md`,
    excerpt: `Fact recalled for turn ${turn}: the person prefers short answers about topic ${turn % 7}.`,
    key: null,
    origin_trust: 'owner',
    disputed: false,
    provenance: {
      id: `k_${turn}`,
      asserted_by: 'user',
      observed_at: '2026-10-01',
      status: 'active',
    },
  },
];

function bundleFor(turn: number, transcript: CanonicalMessage[], tools: ToolSpec[]): AttemptBundle {
  const latest = transcript.at(-1);
  if (!latest) throw new Error('empty chat');
  return {
    attempt: { id: `att_${SUFFIX}`, job_id: `job_${SUFFIX}`, epoch: turn, revision: 0, token: 't' },
    job: {
      title: 'Chat',
      objective: 'Help the person with what they ask in this conversation.',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    inputs: {
      new_user_messages: [latest],
      approval_results: [],
      trigger_events: [],
      repair_briefs: [],
    },
    since_last: EMPTY_SINCE_LAST,
    transcript,
    tools,
    skills: [{ name: 'answer-plainly', body: 'Answer in a few plain sentences.' }],
    knowledge: recalled(turn),
    workspace: { mount: '/work', files: [] },
    budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120000, max_actions: 3 },
    model: { provider: 'fireworks', model: LARGE_MODEL, fallback: null },
  };
}

type Layout = 'before' | 'after';

/** One turn's request as the engine lays it out: tools, system prompt, input. */
function request(layout: Layout, turn: number, messages: CanonicalMessage[]) {
  // Up to and including this turn's user message.
  const sofar = messages.slice(0, turn * 2 - 1);
  // Held to the default engine settings, as an attempt would be.
  const budget = attemptContextBudget(
    LARGE_MODEL,
    {},
    {
      maxTurns: 150,
      compactionMaxTokens: 200_000,
      contextWindowLimit: undefined,
    },
  );
  const limits =
    layout === 'after' ? transcriptLimits(budget) : transcriptLimits(BASELINE_CONTEXT_BUDGET);
  const tools = toolsWithin(layout === 'after' ? budget.core_catalog_tokens : 750);
  const bundle = bundleFor(turn, boundTranscript(sofar, limits), tools);
  let system = renderInstructions(bundle);
  let input = renderInput(bundle);
  if (layout === 'before') {
    // The earlier order: recalled knowledge in the system prompt, ahead of the task notes.
    const knowledge = renderKnowledge(bundle.knowledge).join('\n').trim().replace(/^## /, '# ');
    system = system.replace('# This task', `${knowledge}\n\n# This task`);
    input = renderInput({ ...bundle, knowledge: [] });
  }
  const text = [JSON.stringify(tools), renderSoul(), system, input].join('\n\n');
  return { text, bundle, system, input, tools };
}

function sharedPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function measure(layout: Layout) {
  const messages = chat(TURNS);
  const rows: { turn: number; sent: number; cacheable: number; uncached: number }[] = [];
  let previous = '';
  for (let turn = 1; turn <= TURNS; turn++) {
    const { text } = request(layout, turn, messages);
    const sent = estimateTokens(text);
    const cacheable = turn === 1 ? 0 : Math.floor(sharedPrefix(previous, text) / 4);
    rows.push({ turn, sent, cacheable, uncached: sent - cacheable });
    previous = text;
  }
  return rows;
}

describe('a long chat on a million-token model', () => {
  const before = measure('before');
  const after = measure('after');

  test('prints tokens sent per turn, and how many of them the cache can serve', () => {
    const lines = ['turn | before: sent / uncached | after: sent / uncached'];
    for (const turn of [1, 2, 3, 10, 20, 30, 40, 50, 60]) {
      const b = before[turn - 1];
      const a = after[turn - 1];
      if (!b || !a) throw new Error('missing turn');
      lines.push(`${turn} | ${b.sent} / ${b.uncached} | ${a.sent} / ${a.uncached}`);
    }
    const total = (rows: typeof before, key: 'sent' | 'uncached') =>
      rows.reduce((sum, row) => sum + row[key], 0);
    lines.push(
      `all ${TURNS} turns | ${total(before, 'sent')} / ${total(before, 'uncached')} | ${total(after, 'sent')} / ${total(after, 'uncached')}`,
    );
    console.log(lines.join('\n'));
    expect(after).toHaveLength(TURNS);
  });

  test('the early turns are still in front of the model at turn sixty', () => {
    const messages = chat(TURNS);
    expect(request('after', TURNS, messages).input).toContain('Turn 3:');
    // Before, the bound let them fall out long before the engine would compact.
    expect(request('before', TURNS, messages).input).not.toContain('Turn 3:');
  });

  test('from the second turn on, at least 70% of each request is a cached prefix', () => {
    for (const row of after.slice(1)) {
      expect(row.cacheable / row.sent).toBeGreaterThanOrEqual(0.7);
    }
    // Recall in the system prompt ended the shared prefix before the conversation began.
    const share = (rows: typeof after) =>
      rows.slice(1).reduce((sum, row) => sum + row.cacheable, 0) /
      rows.slice(1).reduce((sum, row) => sum + row.sent, 0);
    expect(share(after)).toBeGreaterThan(share(before));
    expect(share(before)).toBeLessThan(0.5);
  });

  test('the instructions are the same on every turn, whatever is recalled', () => {
    const messages = chat(TURNS);
    const first = request('after', 2, messages).system;
    for (const turn of [3, 17, 42, TURNS])
      expect(request('after', turn, messages).system).toBe(first);
  });

  test('the request leaves with the provider’s caching controls', () => {
    const { system, input, tools } = request('after', 12, chat(TURNS));
    // The Messages protocol, as the engine writes it for a Claude model when it
    // has placed no breakpoints of its own.
    const messagesBody: Record<string, unknown> = {
      model: 'claude-fixture',
      system,
      tools: tools.map((tool) => ({ name: tool.name, input_schema: tool.input_schema })),
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    };
    const anthropic = applyPromptCaching(messagesBody, {
      provider: 'anthropic',
      protocol: 'messages',
      scope: `job_${SUFFIX}`,
    });
    expect(anthropic.markers).toBe(3);
    expect(JSON.stringify(messagesBody).match(/"cache_control"/g)).toHaveLength(3);
    const responses: Record<string, unknown> = {
      model: 'gpt-fixture',
      instructions: system,
      input,
    };
    expect(
      applyPromptCaching(responses, {
        provider: 'openai',
        protocol: 'responses',
        scope: `job_${SUFFIX}`,
      }).key,
    ).toBe(true);
    expect(typeof responses.prompt_cache_key).toBe('string');
    expect(
      applyPromptCaching(
        {},
        { provider: 'fireworks', protocol: 'chat/completions', scope: `job_${SUFFIX}` },
      ).headers,
    ).toHaveProperty('x-session-affinity');
  });
});
