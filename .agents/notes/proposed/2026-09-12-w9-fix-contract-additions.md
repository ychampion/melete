# W9-fix contract additions

- Finding 2: `personReactionRequest` and `PersonReactionRequest` add a public glyph-only request schema. `createReactionRequest` remains unchanged for existing typed callers. The public reaction route rejects identity claims and assigns `person`; OpenAPI and client types describe that route.
- Finding 3: `compileWatchPattern` adds a shared RE2 compiler with the existing 1000-character pattern cap. The authorized matcher change uses the RE2 subset; unsupported constructs are rejected on creation and never fall back to native backtracking. No schema fields are removed.

- Finding 11: `artifactReceiptDetail` adds a typed generated-file receipt detail with optional `artifact_id`; `artifactIdForAction` supplies a stable retrieval identity across dispatch and reconciliation. Existing receipt fields are preserved.
- Finding 11: `GET /artifacts/{id}/content` adds session-authenticated, space-scoped content retrieval, including 206 byte ranges and 401/404/416 outcomes. OpenAPI records the session-cookie security scheme and client types are regenerated.
