# Browser control contract additions

Status: implemented under the owner's additive-contract authorization.

`packages/contracts/src/browser.ts` adds `browserControlResponse` and its inferred
type. The response carries the opaque session id, controller epoch, control owner,
and an explicit requirement for a fresh observation. It carries no worker token,
profile path, screenshot bytes, or browser credentials.

`packages/contracts/src/openapi.ts` adds owner-facing POST paths for
`/browser/sessions/{id}/takeover` and `/browser/sessions/{id}/handback`. Both use
the existing owner authentication and same-origin middleware. Takeover fences
controller input before parking the job; handback leaves the job parked and
requires an observation before automation resumes.

`bun run openapi` and `bun run client:generate` regenerate the document and client
types. The new response has an explicit component name so adding it cannot shift
the existing generated component identifiers. Existing paths, fields, runtime
events, provider names, and approval contracts keep their prior shapes.

The browser connector continues to use the existing `web` connection provider,
selected by its owner-controlled configuration. The private worker protocol stays
inside `apps/melete/src/workers/browser`; it is not a public runtime-cell API.
