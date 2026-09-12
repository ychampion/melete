# W10c additive contract changes

The owner's 2026-09-11 steering permits additive changes and requires regenerated
OpenAPI and client types. W10c adds the `mcp` connection-provider value so an
operator-installed server has an explicit provider identity. All existing values,
fields and HTTP paths remain valid. The database stores provider text and needs
no enum migration. Existing endpoints can create and return an MCP connection;
only the operator-owned configuration file supplies its transport and policy.

Regenerate with `bun run openapi` and `bun run client:generate`. Consumers built
against this revision understand the additional provider value; an older strict
consumer must upgrade before reading an MCP connection. No existing connection
is changed or reclassified.

The internal discovery paths stay service-local and use the existing `ToolSpec`
contract. Composition uses a service-owned executor seam without adding a public
runtime outcome. W10a supplies the cell executor when that lane merges.

The earlier MCP provider proposal is superseded for the provider value only.
The OS isolation requirement remains: production stdio launch is refused before
spawning a process, while an operator-configured HTTP endpoint can be registered.
No worker receives vault, database, broker or inference credentials. The
in-process stdio fixture is limited to tests and does not establish OS isolation.


## PR 15 review: unknown closing check

The `unknown_check` attempt outcome is additive, with `check: parked_actions`,
`reason: timed_out | unavailable` and a message. It records uncertainty without
claiming model failure or permitting an automatic replay. The service stores
it unchanged and holds the job in the existing `waiting_for_input` state.
Attempt outcomes are database text, so no migration is required. The exported
`BROKER_TIMEOUT_MS` default is shared by service dispatch and the ledger client;
a configured ledger timeout is propagated to adapter finalization. Regenerated
OpenAPI and client types include the additional outcome.


## PR 15 review: invalid tool schema

The additive `schema_invalid` broker fault distinguishes operator schema faults
from repairable `payload_invalid` arguments. It is terminal for that plugin tool
handler: the model receives `retryable: false` and a stop instruction, and repeated
calls return the refusal locally without another broker request. Compilation or
async-schema refusal creates no action. Existing broker fault codes stay valid.
