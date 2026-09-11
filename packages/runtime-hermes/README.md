# Hermes runtime adapter

This package contains the HTTP adapter, plugin and container configuration for
Hermes `v2026.9.7`, behind the `RuntimeAdapter` contract.
The pin is checked by `names the exact release the image is built from` in
[`client.test.ts`](src/client.test.ts).
Automatic construction of this adapter by the default service bootstrap is
**not claimed**; callers must inject a runtime or use the explicit local stub.

## Configuration and prompt scope

`config/config.yaml` selects the Melete plugin toolset, disables Hermes memory
and the tool-search bridge, and points model traffic at Melete's gateway.
The container build and its live configuration behavior are **written, not run**
for this documentation verification. Historical measurements remain in
[the engineering record](../../.agents/notes/0009-hermes-surface.md); they are
not a current deployment benchmark.

The broker filters tools by scopes, but a universal 15-tool cap is **not claimed**:
the current broker catalog does not truncate to the contract constant.
`renderInstructions` orders identity, skills and knowledge; named client tests
include `the identity is short enough to be a prefix, not a personality`,
`the instructions are identity, then skills, then knowledge`, and
`every knowledge excerpt carries where it came from`. The engine's own prompt
is additional; a 250-token total system prompt is **not claimed**.

## HTTP lifecycle and approvals

The client builds requests for capabilities, run start/status/events/stop and
shell-approval responses. Evidence includes `start posts to /v1/runs with the
surrogate token`, `the attempt id is the idempotency key and the job id is the
session`, and `the event request asks for a stream and does not try to resume one`.

Adapter tests use a fake Hermes fetch surface:
`refuses an engine whose run idempotency is not durable`,
`maps the stream to contract events in order`,
`a tool result is paired with the call that opened it`, and
`an interrupted run fails retryably and says history is missing`.
They prove adapter behavior for those frames, not a full real-engine deployment.

Broker-tool decisions use Melete park-and-resume:
`a parked action turns a completion into waiting_for_approval`.
They are not routed through Hermes's plugin approval gate.
Unexpected shell approval notifications are denied
(`a shell-command approval is denied, never allowed for the session`).

## Plugin and container limits

The plugin forwards broker proposals and returns their dispositions. Its Python
test suite is **written, not run** for this documentation verification; see
`tests/`. A local TypeScript adapter pass does not imply Python plugin or
container execution passed.

Compose declares an internal-only runtime, read-only root, non-root UID and
dropped capabilities. It provides writable `/work`, `/var/lib/hermes` and
temporary storage. The home volume supports durable engine run-idempotency;
the static check `taking away the runtime writable Hermes home` covers the
declaration.

Inside-container egress/filesystem probes are **written, not run** in
[conformance 6](../../conformance/scenarios/06-no-route-out.test.ts).
Postgres shares the internal network, so exclusive broker reachability is
**not claimed**. The per-attempt environment and writable home configuration do
not by themselves implement the service's missing runtime lifecycle wiring.

## Verify the adapter

From the repository root:

```bash
bun test packages/runtime-hermes/src
```

This command uses fake HTTP responses and does not start Docker or call a paid
provider. [REPORT.md](../../REPORT.md) records the result.

## Licence

Melete is Apache-2.0. The engine is fetched at image build time; see
[NOTICE](../../NOTICE) for the upstream attribution.
