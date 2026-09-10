# Files, web, email, calendar, knowledge, test

Each connector ships a manifest (tools with JSON Schema, effect class,
required scopes, whether `verify` can decide), `execute`, `verify`, `health`,
and its credential requirements. They run as trusted in-process code in v0.1;
`docs/THREAT-MODEL.md` says so, and moving them out of process is the documented
next step.

See `docs/CONNECTORS.md` for the tool tables.

Owned by workstream W2.
