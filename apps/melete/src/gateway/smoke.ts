/** The one optional real request; never imported or invoked by the test suite. */
export const FIREWORKS_SMOKE_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';

export interface SmokeResult {
  status: 'passed' | 'skipped';
  reason?: string;
  modelRequested?: string;
  modelActual?: string;
  toolCallId?: string;
  usage?: unknown;
}

/**
 * The caller supplies a running gateway with a durable budget adapter and an authorized
 * attempt. This function never retries, calls the provider directly, or sends the tool.
 */
export async function runFireworksSmoke(
  gatewayBaseUrl: string,
  capabilityToken: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SmokeResult> {
  if (!env.FIREWORKS_API_KEY) return { status: 'skipped', reason: 'skipped: no key' };
  const response = await fetch(
    `${gatewayBaseUrl.replace(/\/+$/, '')}/providers/fireworks/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-smoke',
        'x-melete-capability': capabilityToken,
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: FIREWORKS_SMOKE_MODEL,
        max_tokens: 512,
        messages: [{ role: 'user', content: 'Call report_probe with the value GATEWAY_OK.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'report_probe',
              description: 'Return the smoke-test marker; no external action is performed.',
              parameters: {
                type: 'object',
                properties: { value: { type: 'string', enum: ['GATEWAY_OK'] } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'report_probe' } },
      }),
    },
  );
  if (!response.ok) throw new Error(`Fireworks smoke failed: gateway HTTP ${response.status}`);
  const body = (await response.json()) as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: {
      message?: {
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  const tool = body.choices?.[0]?.message?.tool_calls?.[0];
  if (
    tool?.function?.name !== 'report_probe' ||
    !tool.id ||
    !tool.function.arguments ||
    JSON.parse(tool.function.arguments).value !== 'GATEWAY_OK' ||
    !body.model ||
    typeof body.usage?.prompt_tokens !== 'number' ||
    typeof body.usage.completion_tokens !== 'number'
  ) {
    throw new Error('Fireworks smoke failed: missing expected tool call, actual model, or usage');
  }
  return {
    status: 'passed',
    modelRequested: FIREWORKS_SMOKE_MODEL,
    modelActual: body.model,
    toolCallId: tool.id,
    usage: body.usage,
  };
}
