# Connectors

A connector is how Melete touches something outside itself. Each one ships a
manifest, and the manifest is what policy reads: the tools, their arguments, what
class of effect each has, which scopes it needs, and whether it can answer the
question that matters after a timeout.

The frozen manifest schema and effect classes are in `packages/contracts`.
Implementations and boundary tests live in `apps/melete/src/connectors`; the
broker persists the canonical action and reserves budget before calling them.

## The contract

```ts
type ConnectorManifest = {
  name: string;
  version: string;
  provider: 'imap' | 'smtp' | 'caldav' | 'web' | 'files' | 'test';
  description: string;
  tools: ConnectorTool[];
  credentials: CredentialRequirement[];
  health: boolean;
};

type ConnectorTool = {
  name: string;             // `connector.tool`, shown to the model verbatim
  description: string;
  input_schema: JsonSchema; // carried through to the model's catalog
  effect_class: 'read' | 'write_reversible' | 'write_external' | 'spend';
  required_scopes: string[];
  verify: boolean;          // can verify() decide this tool's outcome?
  requires_approval: boolean;
};
```

Alongside the manifest, a connector implements `execute(action)`,
`verify(action)`, and `health()`.

## Effect classes

The class decides what an action costs before anyone looks at its content.

| Class | Meaning | Policy in v0.1 |
|---|---|---|
| `read` | Observes without changing anything | Auto-admits within budget |
| `write_reversible` | Changes something inside the workspace or a git-tracked space | Auto-admits within budget; the change is reviewable and revertible |
| `write_external` | Changes something outside, where an undo is not ours to give | Requires an approval bound to the payload hash |
| `spend` | Costs money | Requires an approval and a budget reservation |

v0.1 ships no standing grants for external sends. Every one is approved once, per
payload hash. Editing a draft produces a new action with a new hash.

## Why `verify` matters more than it looks

A dispatch that times out leaves an action `unknown`: it may have happened or it
may not. Melete never retries an unknown external action, because the failure
people actually notice is the message that arrived twice.

`verify` is the connector's answer to "did this actually happen?". A connector
that can answer turns most unknowns into a fact. A connector that cannot leaves
the action at `unresolved`, and Melete says so in plain words rather than
guessing: *Melete cannot confirm whether this email was sent. Check your Sent
folder, then mark it.*

That is why `verify` is a field in the manifest and not an assumption.

## The v0.1 set

| Connector | Tools | Effect class | verify |
|---|---|---|---|
| **files** | `files.list`, `files.read`, `files.write`, `files.move` within `/work` and the space's artifacts | read, write_reversible | content hash |
| **web** | `web.fetch` | read, with a data-release check | none |
| **email** | `email.search`, `email.read`, `email.draft`, `email.send` over IMAP and SMTP | read, write_external | Message-ID in the Sent folder |
| **calendar** | `calendar.list`, `calendar.create`, `calendar.update` over ICS import and CalDAV | read, write_external | GET by UID |
| **knowledge** | `knowledge.search`, `knowledge.propose_write` | read, write_reversible | git sha |
| **test** | `test.send` with an optional `drop_ack` | write_external | the destination's ledger |

### files

Reads and writes are confined to `/work` and the space's artifacts directory. A
path that resolves outside is an error at the connector, not a permission check
somewhere later.

### web

`web.fetch` has two modes and the difference is the point. A job in
public-research mode carries no private knowledge in its context and may fetch
anything. A job carrying private context may fetch only allow-listed domains.
Query strings are recorded in the action ledger, because a URL is itself a way to
send data.

### email

IMAP and SMTP with an app password you supply. Not OAuth: Google and Microsoft
restricted scopes need weeks of verification, and this release would rather work
now than promise a nicer login later.

`email.send` is the archetypal `write_external`. Its payload is canonicalised
before hashing: recipient addresses are reduced to the address itself, so
`Zara <ZARA@Example.COM>` and `zara@example.com` are the same recipient, and
recipient lists are treated as sets, so reordering To: does not invalidate an
approval you already gave. One character of the body does.

Verification searches the Sent folder for the Message-ID.

### calendar

ICS import for read-only calendars, CalDAV for read and write. Verification is a
GET by UID.

### knowledge

`knowledge.search` is scoped to exactly one space by the index handle the process
holds, not by an argument the model passes. Cross-space search is impossible
rather than disallowed.

`knowledge.propose_write` is the only write path an agent has. The proposal is
validated against the frontmatter schema and the lint rules, then rendered as a
diff for the owner. Applying it is a git commit, which is both the audit record
and the undo.

### test

A destination that exists so the conformance suite can be deterministic. It
accepts sends, records them in a ledger, and can be told to drop its
acknowledgement, which is how scenario 3 produces a genuine `unknown` without
anything real going wrong.

## Writing a connector

Implement `Connector` from `apps/melete/src/connectors/types.ts`, then register
the trusted instance under its persisted connection id with `ConnectorRegistry`.
`execute(action, ctx)` receives the admitted canonical action, trusted job/space
constraints, and `ctx.idempotency_key === action.id`. Return a typed dispatch
result; exceptions after dispatch remain unknown. `verify` reads destination
evidence and never repeats the effect. Keep secrets in the service-side instance.

Two rules that will not change:

1. **Declare the effect class honestly.** Calling a send `read` to skip the
   approval defeats the only mechanism protecting the person running this.
2. **Implement `verify` if you possibly can.** A connector without it leaves its
   users with unresolved actions and a question they have to answer by hand.

## Watching a feed without spending on it

An `event` trigger wakes the job on every observation the connector delivers. On
a busy feed that means an attempt, a model call and a bill for every message,
most of which say nothing the person wanted to hear. A `watch` trigger is the
other thing: the service tests the observation itself, and wakes the job only if
a small deterministic predicate holds.

```ts
await client.api.POST('/jobs/{jobId}/triggers', {
  params: { path: { jobId } },
  body: {
    kind: 'watch',
    connection_id,
    event_name: 'mail.new',
    predicate: {
      all: [
        { field: 'from.address', op: 'eq', value: 'billing@example.test' },
        { field: 'subject', op: 'contains', value: 'overdue' },
        { field: 'amount', op: 'gt', value: 100 },
      ],
    },
  },
});
```

The language is deliberately too small to hide a decision in: dotted field paths
into the observation, at most five clauses, all of which must hold, and six
operators.

| Operator | Holds when |
|---|---|
| `eq` | the field is exactly the value |
| `contains` | the text contains the value, or the list has it as an item |
| `matches` | the text matches the regular expression; a pattern that does not compile is refused when the watch is made |
| `lt`, `gt` | both sides are numbers, or both are timestamps |
| `changed` | the field differs from the last observation this watch looked at |

There is no `or`. Two reasons to wake are two watches, which keeps every wake
traceable to one predicate a person can read.

Everything unclear is false: a missing field, a comparison between things that
are not comparable, a first sighting under `changed`. A watch that cannot tell
is a watch that does not wake.

When one does match, the job wakes with that observation as its evidence and the
consumed-event notice carries `because: ["event:<seq>"]`, so the wake can always
name the observation that caused it. Observations that do not match advance the
trigger's cursor and cost nothing else: no attempt, no model call, no row.
