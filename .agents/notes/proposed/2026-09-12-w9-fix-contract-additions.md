# W9-fix contract additions

- Finding 2: `personReactionRequest` and `PersonReactionRequest` add a public glyph-only request schema. `createReactionRequest` remains unchanged for existing typed callers. The public reaction route rejects identity claims and assigns `person`; OpenAPI and client types describe that route.
- Finding 3: `compileWatchPattern` adds a shared RE2 compiler with the existing 1000-character pattern cap. The authorized matcher change uses the RE2 subset; unsupported constructs are rejected on creation and never fall back to native backtracking. No schema fields are removed.
