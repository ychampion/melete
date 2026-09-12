# Trusted connectors

This directory implements files, web, email, calendar and the test destination.
The configured registry does not register a knowledge connector; that catalog
feature is **not claimed**.

`registry rejects duplicate connections and returns a stable connection order`
checks registration. `file boundary rejects parent traversal, absolute paths,
alternate streams and device names` checks local paths; `redirects repeat
compartment and DNS checks, with no request to the denied destination` checks
web requests.

File checks use portable filesystem APIs and do not establish a kernel boundary
against another process racing directory replacement; the container mount
boundary (a per-attempt `work/<job>` subpath) was probed live on Linux in
scenario 6. Mail and calendar use local protocol fixtures; general live-account
compatibility is **not claimed**.

[CONNECTORS](../../../../docs/CONNECTORS.md) contains the implementation table,
named tests and executable verification command.

## Typed faults

A connector that fails on purpose throws `ConnectorFaultError` with a kind from
`CONNECTOR_FAULT_KINDS`, a `may_have_committed` flag, an optional `retry_after`
in seconds, and plain-words detail. The broker's repair policy reads the class;
see `.agents/notes/0015-typed-repair.md` for what each class does.

`may_have_committed` is the field with teeth. True means no retry of any shape
until `verify` has spoken, whatever the kind says, and a connector that is
unsure must say true. Anything thrown that is not a `ConnectorFaultError` reads
as `unclassified` with `may_have_committed: true`, so an untyped throw behaves
exactly as it did before typed faults existed: the action rests at `unknown` and
reconciliation stays a separate step.

Three optional methods let a connector be repaired rather than only retried.

`describe()` answers with the fields the destination requires now, plus the
fields it accepts, plus `equivalent_fields`: the renames the connector itself
vouches for, old name to new name. A repair applies only what is declared there.
Nothing infers an equivalence from a missing field and a surplus field lining
up, because from outside a payload that is what a recipient and a memo look
like, and a field that decides where the effect lands keeps its name whatever
the destination now calls it.

`refreshCredential()` borrows the credential inside the store's `withSecret`,
uses it, and keeps nothing but the fact that a refresh happened; it answers
false when the grant is gone, and it never substitutes another identity. The
broker re-checks the connection row afterwards, so a fresh token on a revoked
connection is still a stop. A connector with no credential store cannot refresh
and stops at `needs_reconnect`.

`routes()` offers equivalent authorized routes for the same operation, used only
after a route said definitively that it did not execute.

A connector that implements none of them simply stops instead, which is the
correct outcome rather than a missing feature.

Which connectors classify what, in v0.1:

| Connector | Classes it raises |
|---|---|
| `test` | every class, on demand, for the falsifiers |
| `calendar` | `rate_limited` (with the server's `Retry-After`), `expired_credential` on 401, `revoked_credential` on 403. Every other refusal stays a plain failure |
| `files` | `bad_output` when a move's source is not the content the action recorded, and when a write does not read back as what was written |
| `web`, `email` | none yet. A web fetch reports the destination's status in its receipt rather than failing on it, and mail transport errors are not yet distinguishable enough to classify honestly |

A connector that classifies nothing behaves exactly as it did before typed
faults existed. Adding a class is a per-connector change with its own falsifier,
and guessing one would be the same guess the policy exists to refuse.

