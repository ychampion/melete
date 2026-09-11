# 0010 - One action per intended effect, and admission that knows where a value came from

Status: accepted
Date: 2026-09-11

## Problem

Note 0007 made every effect a record before it is a request, bound to the bytes
of its payload. Two holes were left open, and both of them end with a person
getting mail they did not agree to.

**A retry is not the same thing as an effect.** The payload hash says what would
be done. It does not say which real-world effect this is. A runtime that died
between proposing a send and hearing the answer comes back and proposes again;
without a client reference it gets a second action over the same bytes, and the
second one can be approved and dispatched on its own. The `client_ref` from W2
closes this only when the runtime remembers to pass one and remembers the same
string, which is exactly what a process that has just been killed cannot be
relied on to do. Identity has to come from the effect, not from the caller's
discipline.

**An address is not just an address.** By the time a payload reaches admission it
is bytes. An address the owner typed and an address the model lifted out of a web
page it read on Friday are indistinguishable. Approval binds to the hash, so the
person is shown the right bytes; nothing tells them that one of those bytes came
from a page an attacker could have written. Prompt injection does not need to
defeat the approval screen if it can decide what the screen is asking about.

## Decision

**Effect identity.** At proposal the broker derives

```
intent_key = sha256(job_id, job_revision, connection_id, kind, canonical_payload_hash)
```

with each part length-prefixed so no two tuples can be run together into the same
bytes. It is stored on the action and carries a unique index. A proposal whose
key already exists returns the existing action and whatever state it rests in:
`needs_approval`, `approved`, `admitted`, `dispatched`, `succeeded`, `failed`,
`unknown`, `unresolved`. It never creates a second one, and an `unknown` is never
dispatched again. The response carries a sentence built from the record, so the
tool result for a repeat of a send that already happened says it already
succeeded, when, and with which receipt, rather than reporting a fresh send.

One changed byte is a different payload hash and therefore a different key, so an
edited draft is a new action that needs its own approval. That is the same rule
0007 already made, now enforced by the index rather than by the caller.

**Trust-class admission.** A `TrustResolver` is asked, at proposal, at admission
and again at dispatch, where each recipient, destination, amount and resource
field in the canonical payload came from. It answers with a class in
`owner | verified_connector | external_content | inferred | unknown` and the
handle the value came from. For `write_external` and `spend`, every such field
must resolve to `owner` or `verified_connector`. Anything else becomes an
`origin_warning` carrying the field, the class, the handle, and a sentence in
plain words, and admission then requires a fresh approval whose record carries
exactly that set of warnings.

The set is hashed and the approval is bound to that hash. So an approval taken
when nothing was in doubt does not survive the moment something is: the decision
is set aside, the action returns to `needs_approval`, the person is asked again
with the warnings attached, and the superseded answer stays in the event log.
Admission with no such approval is refused with `untrusted_recipient_origin`, not
with a generic `approval_required`, because the reason is the thing the person
needs to hear.

A standing grant is never a way past this. The grant is consulted only when
nothing about the payload is in doubt. v0.1 ships no grants at all: the resolver
option defaults to absent, which matches section 6 of the architecture, and the
mechanism exists so the rule can be proved rather than asserted.

## Alternatives

- **Keep `client_ref` as the only identity.** It makes correctness a property of
  the caller's memory. The case that matters is the one where the caller has no
  memory, because it just died.
- **Include the attempt in the intent key.** Then every new attempt is a new
  effect, which is precisely the duplicate send this note exists to prevent.
- **Put the warnings hash in the effect binding tuple.** It would refuse with
  `approval_hash_mismatch`, which is true and useless. The binding stays as W2
  left it; the warnings bind to the approval record, where a person can read them.
- **Create a second approval row instead of setting the first aside.** The unique
  index on `(action_id, payload_hash)` is what keeps one question per set of bytes
  in the inbox, and W1 registers an approval wait by joining one approval per
  action. A second row would put two questions about the same send in front of
  the owner. The event log carries the history instead.
- **Let a standing grant cover an untrusted value if the grant is narrow enough.**
  A grant is written before the value exists. It cannot consent to a destination
  chosen later by a web page.
- **Treat `unknown` origin as acceptable.** Not knowing where a value came from is
  the state an attacker can most easily produce.

## Consequences

- Two proposals of identical bytes in the same job and revision are now one
  action. A W2 test that produced two actions that way now moves the job revision
  between them, because that is the only thing that makes them two effects.
- Resetting an approval keeps its stored `expires_at`, taken from the effect
  binding. A later approval therefore cannot extend an authorization, and an
  action whose approval window has already closed needs a new action rather than
  a new answer.
- If the origins stop being in doubt after an approval was taken with warnings,
  the approval is also set aside. Strict equality on the warnings hash is the
  rule; the person answered a different question either way.
- The integration fixture now applies migration 0009 on top of the frozen initial
  schema. A fixture that stops at 0000 cannot exercise an index added later, and
  a test that cannot exercise the index is not evidence.

## Evidence

`apps/melete/test/integration/effects.test.ts`, against Postgres 17 and the
durable test destination:

- an attempt killed before dispatch, replaced at a bumped epoch, re-proposing the
  identical send: one action row, one dispatch event, one destination row, one
  receipt;
- the same with the kill after dispatch and a dropped acknowledgement: the
  re-proposal returns `unknown` and says so, the destination is written once, and
  `verify` resolves it to succeeded;
- a re-proposal with one changed byte: a different intent key, a second action, a
  second approval, nothing sent;
- a direct insert of a second action with the same intent key: refused by
  `action_intent_key_idx`;
- an address resolved as `external_content` under a standing grant: refused with
  `untrusted_recipient_origin`, no reservation, nothing dispatched, and an
  approval request whose warning names the web page it came from;
- the same payload with that address resolved as `owner`: admitted under the grant
  with no approval record at all;
- an approval given while the address looked like the owner's, then the origin
  becoming known: the decision is set aside, the refusal names the origin, and the
  send only goes out after the owner answers the question that carries the warning.

`packages/contracts/src/effects.test.ts` covers the key derivation, including that
length prefixes stop two fields being run together into a collision, and the
canonical ordering of a warning set. `apps/melete/src/broker/trust.test.ts` covers
which payload fields are gated, that a resolver's silence about a gated field
reads as `unknown`, and that no resolver at all warns about nothing.
