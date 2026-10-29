/**
 * Synthetic Token Factory responses based on its public OpenAPI schema and
 * NVIDIA's Nemotron chat templates, rather than captures from a paid account.
 * https://api.tokenfactory.nebius.com/openapi.json
 * https://docs.tokenfactory.nebius.com/cached-tokens
 * https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
 * https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16
 * https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16
 */
export const nemotronModels = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', costUsd: 0.000516 },
  // The ledger stores whole micro-dollars.
  { id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', costUsd: 0.000127 },
  { id: 'nvidia/Nemotron-3.5-Super-VL', costUsd: 0.000516 },
] as const;

export const tokenFactoryUsage = {
  prompt_tokens: 1000,
  completion_tokens: 400,
  total_tokens: 1400,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 300 },
};

export function completion(
  model: string,
  message: Record<string, unknown> = { content: 'Tea is ready. ☕' },
  finishReason = 'stop',
) {
  return {
    id: 'chatcmpl-nebius',
    object: 'chat.completion',
    created: 1793167200,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason },
    ],
    usage: tokenFactoryUsage,
  };
}

export function chunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: 'chatcmpl-nebius',
    object: 'chat.completion.chunk',
    created: 1793167200,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

export function textChunks(model: string) {
  return [
    chunk(model, { role: 'assistant', content: null, reasoning_content: '' }),
    chunk(model, { reasoning_content: 'Compare the kettle readings privately. ' }),
    chunk(model, { reasoning_content: 'The water is hot.' }),
    chunk(model, { content: 'Tea ' }),
    chunk(model, { content: 'is ready. ☕' }),
    chunk(model, {}, 'stop'),
  ];
}

export function inlineReasoningChunks(model: string) {
  return [
    chunk(model, { role: 'assistant', content: '<thi' }),
    chunk(model, { content: 'nk>Compare the kettle readings privately. ' }),
    chunk(model, { content: 'The water is hot.</th' }),
    chunk(model, { content: 'ink>Tea ' }),
    chunk(model, { content: 'is ready. ☕' }),
    chunk(model, {}, 'stop'),
  ];
}

export const toolCalls = [
  {
    id: 'call_calendar',
    type: 'function',
    function: { name: 'calendar_search', arguments: '{"query":"tea ☕","limit":2}' },
  },
  {
    id: 'call_notes',
    type: 'function',
    function: { name: 'notes_search', arguments: '{"query":"kettle"}' },
  },
];

export function toolChunks(model: string, parallel: boolean) {
  return [
    chunk(model, { role: 'assistant', content: null }),
    chunk(model, { reasoning_content: 'Check the available evidence first.' }),
    chunk(model, {
      tool_calls: [
        {
          index: 0,
          id: 'call_calendar',
          type: 'function',
          function: { name: 'calendar_search', arguments: '' },
        },
        ...(parallel
          ? [
              {
                index: 1,
                id: 'call_notes',
                type: 'function',
                function: { name: 'notes_search', arguments: '' },
              },
            ]
          : []),
      ],
    }),
    chunk(model, {
      tool_calls: [
        ...(parallel ? [{ index: 1, function: { arguments: '{"query":' } }] : []),
        { index: 0, function: { arguments: '{"query":"tea ' } },
      ],
    }),
    chunk(model, {
      tool_calls: [
        { index: 0, function: { arguments: '☕","limit":2}' } },
        ...(parallel ? [{ index: 1, function: { arguments: '"kettle"}' } }] : []),
      ],
    }),
    chunk(model, {}, 'tool_calls'),
  ];
}

export function eventStream(model: string, chunks: unknown[]) {
  const usage = {
    id: 'chatcmpl-nebius',
    object: 'chat.completion.chunk',
    created: 1793167200,
    model,
    choices: [],
    usage: tokenFactoryUsage,
  };
  return `${[...chunks, usage].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`;
}

export const tokenFactoryErrors = {
  limited: {
    status: 429,
    body: {
      error: {
        type: 'rate_limit_error',
        message:
          'Your request rate increased too quickly. Reduce your request rate and increase it gradually.',
        code: 'slow_down',
      },
      detail:
        'rate_limit_error: Your request rate increased too quickly. Reduce your request rate and increase it gradually.',
    },
  },
  unavailable: {
    status: 503,
    body: {
      error: {
        type: 'service_unavailable_error',
        message: 'The service is temporarily unavailable.',
      },
      detail: 'service_unavailable_error: The service is temporarily unavailable.',
    },
  },
  internal: {
    status: 500,
    body: {
      error: {
        type: 'server_error',
        message: 'Unable to process request. Repeat the request later.',
      },
      detail: 'server_error: Unable to process request. Repeat the request later.',
    },
  },
  // Defensive example: the provider documents the limit, but not this exact envelope.
  context: {
    status: 400,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message:
          "This model's maximum context length is 262144 tokens. Reduce the length of the messages or completion.",
        param: 'messages',
      },
    },
  },
};
