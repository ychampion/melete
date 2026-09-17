# Model gateway

`createModelGateway` validates capabilities, configured endpoints and model
selection before forwarding. `PostgresGatewayBudget` provides durable budget
integration. The gateway does not itself establish container network isolation;
scenario 6 on a Linux Docker host found this listener to be the cell's only
reachable peer.

Named tests in `index.test.ts` cover:

| Behavior | Test |
| --- | --- |
| Fake HTTP/SSE conversation and reported usage | `streams the fake tool conversation end to end and records actual model and usage` |
| Reserve before forwarding | `reserves before injecting credentials and strips capability and caller headers` |
| Epoch and concurrent budget checks | `stale epoch and concurrent budget exhaustion stop requests before transport` |
| Provider request handling | `Astra requires Responses and Anthropic drops sampling controls without rewriting history` |
| Metered local TLS CONNECT | `allowed TLS CONNECT injects a key, meters each inner request, and rejects a different Host` |
| Incomplete usage | `a truncated SSE stream stays unknown and keeps the reservation charged` |
| Response redaction | `redacts a known key even if split between chunks` |
| Output limit for a request that names none | `a request without an output limit gets the configured default, within what the attempt may spend` |
| Operator-configured plain HTTP endpoint | `an operator-configured plain HTTP endpoint is forwarded to as written` |

`providers.ts` holds the one provider table: the protocols each upstream is
served over, the API mode every launcher hands its runtime (`modelApiMode`), and
the start-up messages for a provider selection that can never answer.
`providers.test.ts` and `configured.test.ts` cover them. Only the endpoint named
in `OPENAI_COMPAT_BASE_URL` may be plain HTTP; every built-in upstream is HTTPS,
and `OPENAI_API_KEY` stands in for that endpoint's key only when it is HTTPS.

The fixtures use fake transports/providers and local TLS. General real-provider
compatibility and real-model quality are **not claimed**. The optional Fireworks
smoke helper in `smoke.ts` needs a configured gateway, capability and key; it is
not part of the test suite.

The effect listener loads configured connections and optional operator-provided
TLS termination certificates. Certificates under `fixtures/` are test-only.
The Compose stack runs this gateway with the scripted provider; a useful
assistant with a real model is **not claimed**.
See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md).
