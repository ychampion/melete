# Prod-readiness pass: additive contract changes

`SinceLast.evidence[].kind` gains the value `source`, with handles of the form
`source:<memory source id>@<source version>`. It names a memory source that
became active after the previous attempt ended, or every active source on the
first attempt. Existing kinds (`artifact`, `knowledge`, `action`) keep their
meaning.

`AttemptBundle.inputs.since_last` is deprecated: the delta is the top-level
`since_last`, built once inside the lease transaction by `buildSinceLast` and
completed after the lease with the memory-source evidence above. No producer
fills `inputs.since_last` any more; it stays optional so a bundle written
before the two shapes were unified still parses. The runtime renders the delta
once, through `renderSinceLast`.

Neither shape is part of the HTTP surface, so `openapi.json` and the generated
client are unchanged; `bun run openapi` and `bun run client:generate` were run
to confirm.
