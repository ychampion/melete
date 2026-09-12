import type { State } from './state.ts';

/** Every paid request, including judge requests, crosses the same durable money gate. */
export function meteredTransport(state: State, role: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.href !== 'https://api.fireworks.ai/inference/v1/chat/completions')
      throw new Error('Unexpected paid endpoint');
    const body = (await request.json()) as Record<string, unknown>;
    // Evaluation configuration, not an identity change. The effective cap is recorded by hash.
    body.max_tokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 4096), 4096);
    delete body.max_completion_tokens;
    delete body.service_tier;
    if (body.stream) body.stream_options = { include_usage: true };
    let delay = 0;
    for (let retry = 0; ; retry++) {
      const start = state.requestTime(Date.now(), delay);
      while (Date.now() < start) {
        request.signal.throwIfAborted();
        await Bun.sleep(Math.min(500, start - Date.now()));
      }
      request.signal.throwIfAborted();
      const id = state.reserve(body, role);
      const response = await fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
        }),
      );
      // Bounded completions; persist billing evidence before returning it to the gateway.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Paid response exceeded evidence bound');
          }
          chunks.push(chunk.value);
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      state.settle(id, response.status, text);
      if ([429, 503].includes(response.status) && retry < 2) {
        const requestedDelay = Number(response.headers.get('retry-after')) * 1000;
        delay = Math.min(45_000, Math.max(7000 * 2 ** retry, requestedDelay || 0));
        continue;
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(text, { status: response.status, headers });
    }
  };
}
