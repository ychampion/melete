# W15 additive contract fields

`AttemptBundle.inputs.since_last` is optional. It carries the prior attempt ID,
up to 50 source-version handles, 50 action statuses with receipt identities,
20 open questions, and 20 pending approvals. Existing bundle fields keep their
meaning. The durable action ID identifies a receipt because the receipt contract
has no separate receipt ID.

The service assembles this field after the attempt lease commits. The Hermes
adapter renders it alongside repair briefs in the volatile input.

Regenerate with `bun run openapi` and `bun run client:generate`.

`HealthResponse.runtime_adapter` is an optional string identifying the selected
adapter. `ContextRecord.style_violations` is an optional string array. New
contexts always persist the diagnostics array, including an empty array when
there are no observed violations. Migration `0015_famous_nova.sql` adds the
matching JSONB column with an empty default; existing records remain readable.
