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
