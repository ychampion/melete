# Key-injecting model proxy

`createModelGateway` returns a Node HTTP server that also runs on Bun. Bind it on
the internal service interface; the runtime network has no default route. A
listener alone does not enforce that network isolation. W2 development uses
port 3112 for the broker; the service can route model endpoint requests to this
gateway listener without exposing it to the host network in compose.

The service supplies `authenticate(token)` and a durable `GatewayBudget` adapter.
The adapter persists each reservation before the provider request, rechecks the
attempt epoch and revision under the job row lock, and enforces the job's remaining
allowance and the principal's request/token caps together. `settle` is idempotent
by reservation id. It writes actual-model and usage evidence to the attempt and
request record. Missing usage and interrupted requests retain the conservative
reservation charge. Reported usage above an estimate must still be recorded and
charged so that the next admission fails closed. The proxy never retries a call.
An uncertain receipt also sets `attempt.outcome_detail.gateway_usage_uncertain`
and `model_receipt.usage_uncertain`; known token totals are not represented as a
complete total when this flag is set. `model_actual` comes only from provider
response data, including when the requested alias differs from the served model.

The principal's `allowedModels` contains the selected provider/model and, only
when authorized for that job, its fallback. The proxy never chooses a fallback.
Provider credentials live in the service environment and are absent from the
runtime. The gateway rejects real credentials supplied by runtime requests.

## Requests

The metered paths are `POST /providers/<provider>/v1/chat/completions`,
`POST /providers/<provider>/v1/responses`, and
`POST /providers/<provider>/v1/messages`. Only protocols configured for that
provider are admitted. `/v1/chat/completions` and `/v1/responses` use the configured
default provider; `/v1/messages` selects Anthropic. Credentials are
`Authorization: Bearer melete-surrogate-<label>` for OpenAI-compatible requests
and `x-api-key: melete-surrogate-<label>` for Anthropic. The independent capability
is carried in `x-melete-capability` or `Proxy-Authorization: Bearer <capability>`.
Caller cookies, arbitrary headers, capability tokens, and surrogate keys never
reach the provider. Known provider keys are redacted from response bodies even
when split across SSE chunks; provider error details and response headers are
not forwarded.

HTTP absolute-form proxy requests admit only exact configured HTTPS inference
URLs. Defaults allow `api.fireworks.ai`, `api.anthropic.com`, `api.openai.com`, and
`generativelanguage.googleapis.com`; `OPENAI_COMPAT_BASE_URL` adds an explicitly
configured HTTPS endpoint with `OPENAI_COMPAT_API_KEY` (or `OPENAI_API_KEY`).
Provider URL query strings, credentials, arbitrary paths, and redirects are
rejected. Only POST is accepted.

HTTPS CONNECT is supported with **metered TLS termination**, not an opaque
tunnel. Supply `connectTls(host)` with an operator-provided certificate and key
for each allowed provider host and install the corresponding internal CA trust
certificate in the runtime. The CONNECT capability is inherited by the inner
HTTP/1.1 requests; each inner request reserves separately and rechecks fencing.
SNI and the inner Host/path must match the CONNECT destination. The runtime's
trust configuration must not disable certificate verification. Without a
certificate the allowed host receives `metered_endpoint_required`; unknown hosts
are denied before TLS. This closes the otherwise unmeterable route around request
and token caps. Bun requires a real HTTP parser, so each admitted CONNECT relays
TLS bytes to a temporary loopback-only HTTPS listener in the service process.
There is no uninspected outbound socket. The PEM files in `fixtures/` are public,
test-only fixtures and must never be trusted or used in a running installation.

## Metering and supported content

Every request reserves its JSON UTF-8 byte length plus a 256-token framing
allowance and its explicit maximum output tokens. This conservative text-only
estimate avoids a provider-specific tokenizer. The provider receives one output
with that enforced limit. Images, audio, video, files, and hosted execution/search
tools are rejected because their input cost cannot be bounded by that estimate.
Large request/response bodies and long requests are bounded. Actual usage releases
the unused estimate only after successful settlement.

JSON and SSE responses retain their provider format. OpenAI chat stream requests
always ask for the final usage frame. The parser captures OpenAI Chat Completions,
OpenAI Responses, and Anthropic message usage, including cache token counts, from
response bodies and records actual model and latency. A truncated SSE stream is
`unknown`; missing usage is never interpreted as zero. `gpt-6-astra` requires the
Responses endpoint. Anthropic requests omit temperature/top_p/top_k and preserve
the caller's message history in order.

## Verification

`bun test apps/melete/src/gateway --max-concurrency 2` runs a scripted fake
tool-calling conversation through HTTP and SSE, capability/surrogate/model/epoch
rejection, request/token caps, credential injection, unknown usage retention,
chunk-split usage parsing, and a real local CONNECT/TLS request. The injected
transport and fake provider keep every automated test offline. No mailbox or
external provider is contacted.

`fake` is an in-process provider with a separate script cursor per attempt. Its
default first response calls `test.send`; the next returns the recorded-receipt
summary. It supports JSON, OpenAI-compatible SSE, Responses, and Anthropic shapes.

The optional `runFireworksSmoke(gatewayBaseUrl, capabilityToken)` helper in
`smoke.ts` makes exactly one chat completion through an already running gateway
with its durable budget adapter. The capability must allow provider `fireworks`
and model `accounts/fireworks/models/deepseek-v4p1-flash`. It validates a forced
`report_probe` tool call and returned usage without executing that tool. When
`FIREWORKS_API_KEY` is absent it returns `skipped: no key`. The model identifier
comes from the [Fireworks model page](https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash).

## Starting the service

`PORT=3110`, `MELETE_BROKER_BIND=127.0.0.1:3112`, `DATABASE_URL`,
`MELETE_CAPABILITY_KEY`, and the distinct `MELETE_APPROVAL_KEY` start the API and
effect listener locally. The service starts pg-boss on the same database and
recovers timed-out dispatched actions without executing them again. The fake
provider and test destination require `MELETE_ENABLE_FAKE_PROVIDER=true` and
`MELETE_ENABLE_TEST_CONNECTOR=true`; both are disabled by default.

Compose keeps the effect port unpublished, supplies the signing keys only to
Melete, and mounts the same `/work` volume in Melete and the runtime. Files tools
confine job paths to `/work/<job_id>` and shared artifacts to
`/data/spaces/<space_id>/artifacts`. Proxy environment variables route supported
runtime HTTP clients to the gateway; the runtime adapter must attach the attempt
capability and surrogate on each model request. These variables alone do not
implement the adapter's authentication or the container network boundary.

`MELETE_CONNECTIONS_FILE` points to an owner-controlled JSON array (compose uses
`deploy/config/connections.json`). Each entry's `id` must identify an active
connection row in the database. An email entry has `kind: "email"`, `username`,
`from`, and `imap`/`smtp` objects containing `host`, `port`, and `secure`; optional
`inbox` and `sent` select folders. CalDAV entries have `kind: "caldav"`,
`calendarUrl`, and `username`; read-only imports have `kind: "ics"` and `icsPath`.
Passwords live exclusively in the connection's sealed `secret_ref`. The registry
loads this configuration at startup; restart after changing endpoints. The
master key must decode to 32 bytes (base64 or 64 hexadecimal characters).

Optional CONNECT certificates are read from `MELETE_GATEWAY_TLS_DIR` as
`<provider-host>.key.pem` and `<provider-host>.cert.pem`. In compose place them in
`deploy/config/gateway-tls/`, which is ignored by Git. Install the private CA's
public trust certificate in the runtime image separately. Direct gateway
endpoints work without TLS interception certificates.
