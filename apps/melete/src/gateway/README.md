# Model gateway

`createModelGateway` validates capabilities, configured endpoints and model
selection before forwarding. `PostgresGatewayBudget` provides durable budget
integration. The gateway does not itself establish container network isolation;
inside-container egress probes are **written, not run**.

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

The fixtures use fake transports/providers and local TLS. General real-provider
compatibility and real-model quality are **not claimed**. The optional Fireworks
smoke helper in `smoke.ts` is **written, not run** for this documentation
verification; it needs a configured gateway and capability. No paid smoke is part
of this documentation task.

The effect listener loads configured connections and optional operator-provided
TLS termination certificates. Certificates under `fixtures/` are test-only.
Default service startup still needs an injected runtime or explicit stub;
a ready-to-run Compose assistant is **not claimed**.
See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md).
