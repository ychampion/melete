# W9-fix contract additions

- Finding 2: `personReactionRequest` and `PersonReactionRequest` add a public glyph-only request schema. `createReactionRequest` remains unchanged for existing typed callers. The public reaction route rejects identity claims and assigns `person`; OpenAPI and client types describe that route.
