# 0007 - Every effect is brokered, hash-bound, and may end unknown

Status: accepted
Date: 2026-09-11

## Problem

The moment an assistant can send email, it can send the wrong email to the wrong
person, twice. Three failures matter and they are different: acting without
permission, acting on content the person did not see, and not knowing whether an
action happened.

## Decision

Every external action is a record before it is a request.

The runtime proposes; the broker canonicalises the payload, hashes it, and
classifies its effect from the connector manifest. Reads and reversible writes
inside the workspace auto-admit within budget. External sends and spends require
an approval bound to that exact hash and to the job revision. Editing a draft
produces a new action, not an amended one, so an approval can never be spent on
different bytes.

Admission is one transaction that re-checks epoch, policy, approval, and budget,
and fails closed. Dispatch carries `idempotency_key = action.id`, so a retry is
the same request. A dispatch whose answer never comes back is `unknown` and is
never replayed; `verify` may resolve it, and when verify cannot decide the action
rests at `unresolved` and the job asks the owner in plain words.

Canonicalisation is where this becomes real: sorted keys, trimmed strings, email
addresses reduced to the address itself, recipient lists treated as sets. Two
descriptions of the same message hash the same; one changed character does not.

## Alternatives

- **Approve at the tool-call level.** The person approves "send an email" and the
  content changes underneath the approval.
- **Retry on timeout.** Sends the message twice, which is the failure people
  actually notice.
- **Treat unknown as failed.** Reports a message as unsent while it sits in the
  recipient's inbox. A wrong answer is worse than an honest one.

## Evidence

The canonicaliser is tested in both directions: key order, nested key order,
whitespace, display names, address case, and recipient order and duplicates all
leave the hash alone; one character of body, one changed recipient, or one added
`cc` all change it. `unknown` and `unresolved` are both real statuses and neither
counts as terminal, which is what stops a job completing over the top of an
unresolved effect.
