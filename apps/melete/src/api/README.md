# HTTP surface

Hono routes for the endpoints in `packages/contracts/openapi.json`. Every route
validates its request with the Zod schema from `@melete/contracts` and returns a
response that parses against the matching response schema, so the document and
the service cannot drift.

Rules this module keeps:

- The approval view is built from `action` rows. Model text never reaches an
  approval screen, and Markdown a model produced is rendered sanitised.
- No response carries a `secret_ref` or a credential. `connectionView` is the
  only shape connections leave the process in.
- Reads are scoped to one space. A caller that holds a handle to one space
  cannot widen it with a query parameter.

`actions.ts` implements the space-scoped action list through an injected owner
authorization function. It deliberately includes actions belonging to cancelled
jobs and orders `unknown`/`unresolved` sends first. The broker's internal listener
exposes this read adapter to the API using its service credential. Other owner
routes remain for the API lane.
