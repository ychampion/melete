# Connectors

A connector is how Melete touches something outside itself. Each one ships a
manifest, and the manifest is what policy reads: the tools, their arguments, what
class of effect each has, which scopes it needs, and whether it can answer the
question that matters after a timeout.

> **Status: none of these are implemented yet.** The manifest schema and the
> effect classes are in `packages/contracts`; the connectors themselves land with
> the broker.

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

Not yet. The interface will not be stable until the broker is, and a connector
written against today's types will need changes. If you want to write one anyway,
open an issue first so it can be built against the shape that is landing.

Two rules that will not change:

1. **Declare the effect class honestly.** Calling a send `read` to skip the
   approval defeats the only mechanism protecting the person running this.
2. **Implement `verify` if you possibly can.** A connector without it leaves its
   users with unresolved actions and a question they have to answer by hand.
