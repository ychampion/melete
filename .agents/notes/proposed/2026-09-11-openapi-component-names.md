# Proposed - Name the shared OpenAPI components

Status: proposed
Date: 2026-09-11
Raised by: the client lane, while generating types from openapi.json

## Problem

`buildOpenApiDocument` passes `{ reused: 'ref' }`, which is right: shared shapes
such as `job` appear on many paths and emitting them once keeps the document
reviewable. But zod-openapi has no name to give them, so it invents one:

```
components.schemas.__schema0 … __schema24
```

Every generated client inherits those names. `openapi-typescript` produces
`components['schemas']['__schema14']` for an action, and any generator in any
language does the equivalent. A caller who opens the generated file cannot tell
`__schema9` from `__schema14`, and the names are positional: adding a path can
renumber shapes that did not change, so a regenerated file shows a diff nobody
can review.

## What this is not

This is not blocking. `packages/client/src/types.ts` derives friendly aliases
from the paths instead:

```ts
export type Action = Ok<paths['/actions/{actionId}'], 'get'>['action'];
```

That works, stays tied to the document, and costs one small file. The client
shipped on it. So this note is a suggestion, not a request to unfreeze anything.

## Proposal

Give the reused schemas an id where they are defined, which zod-openapi uses as
the component name:

```ts
export const job = z.object({ … }).meta({ id: 'Job' });
```

The candidates are the shapes that already get hoisted: `job`, `attempt`,
`action`, `approvalRequestView`, `space`, `connectionView`, `event`,
`knowledgeFrontmatter`, `jobState`, `actionStatus`, `effectClass`.

## Cost

`bun run openapi` rewrites `openapi.json`, and the openapi sync test then
expects the new bytes. Generated clients change shape in one commit. Doing it
before v0.1.0 is tagged costs nothing; doing it afterwards breaks every
generated client at once.

## Evidence

`bun -e "const d=require('./packages/contracts/openapi.json'); console.log(Object.keys(d.components.schemas).join(','))"`
prints `__schema0` through `__schema24`. The generated
`packages/client/src/schema.d.ts` references those names 60 times.
