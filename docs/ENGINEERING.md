# Engineering evidence

This page maps Melete's core implementation properties to the tests that check
them, and states the scope of each.

## E1. Declared dependencies and repair briefs

`memory/outputs.ts` records output manifests and derivation edges.
Corrections can mark cited output revisions stale and create repair briefs;
outputs without attribution keep the conservative rule.

Evidence in `properties-e1-tests.ts`:
`a correction marks stale exactly the output that cited it and says what to
repair` and `the next attempt is handed the repair brief in its inputs`.
The attribution utility matches supported literal values rather than meaning.
An output whose manifest names no dependency, which is mostly chat prose, is
recorded as unattributed and invalidated conservatively rather than refused by
the broker.

## E2. Keyed heads and disputes

The typed registry lives in `packages/contracts/src/provenance.ts`;
`memory/contradictions.ts` applies keyed precedence and stores disputes.
Database indexes constrain one visible keyed claim and one active/disputed
revision per claim. A proposal without a registered key is stored unkeyed,
outside the one-head-per-key constraint.

Evidence in `properties-e2-tests.ts`:
`July, then a document, then August, then a late email: one head, one question`,
`the database refuses a second claim on one key`, and
`the owner answers the queue entry and the key is settled`.
Equivalence is by key: claims that say the same thing share one head only when
they share a registered key.

## E3. Deterministic extraction and structural validation

`memory/service.ts` tries Tier-0 observation extraction before model proposals.
`tier0.ts` and `validate.ts` check supported structured facts, registry keys
and exact source spans. Rejections are recorded rather than attributed to
unrelated evidence.

Evidence in `properties-e3-tests.ts`:
`a wrong span and a hallucinated address are rejected; the connector date is
the head`. Validation is structural: it confirms that a keyed value sits in the
exact span it cites, while the reading of dates, times and other values rests
with the extractor and with the owner's corrections.

## E4. Origin reaches the admission gate

The effect boundary installs `createMemoryTrustResolver`. It resolves values
against handles recorded for the job and returns origin to the broker.
Recognised recipient, destination, amount and resource fields with untrusted or
unknown origin require fresh approval reflecting the origin warnings.

Evidence: `a page-sourced address is external content; the same address from
the owner is not` in `properties-e4-tests.ts`;
`an address read off a page is refused as untrusted_recipient_origin` in
`broker-seam-tests.ts`; and `an approval given before the origin was known
does not count` in `effects.test.ts`.
The seam test keeps a standing grant in force, so the origin check alone has to
hold the page's address back. The check covers the recognised field
vocabulary; a destination in an encoded form or an unrecognised field is not
identified as a destination.

## E5. Effect identity across attempts

`intentKey` in `packages/contracts/src/effects.ts` derives identity from
job, revision, connection, kind and canonical payload hash. The broker and
database uniqueness constraint reuse an existing logical action across attempts.
Changed payloads require a distinct approval.

Evidence in `effects.test.ts`:
`an attempt killed before dispatch is replaced, and the same send happens once`,
`an attempt killed after dispatch with a lost acknowledgement re-proposes
into unknown`, and `the database itself refuses a second action for one
intent key`. These tests replace the attempt through fixture state rather than
killing a deployed runtime; conformance 1 and 5 kill real child processes on a
fault schedule. Identity follows the canonical payload, so effects worded
differently are distinct actions, each with its own approval.

## E6. Memory scenarios with a withheld-memory arm

The [memory runner](../conformance/memory/README.md) calls the real memory
functions against disposable Postgres, with scripted extraction and answers
over local HTTP. It runs the memory service directly rather than the normal
service entry point or a Compose installation. Ten executable scenarios span
seven families. An eighth family, procedure transfer, holds one scenario
recorded as a todo and has no executed case here, because this harness does not
enable promotion; the [learning](LEARNING.md) tests cover it instead.

Each executable scenario requiring memory runs again with empty recall; a
scenario that still passes fails the suite as `memory not exercised`.
The break tests in `conformance/memory/breaks.test.ts` include
`a late import that wins turns the corrections family red`,
`accepting a nearby-message citation turns the source-authority family red`,
and `skipping the restriction replay turns the forgetting family red`.

These measure scripted recall behaviour, obsolete answers, unsupported answers,
needless questions and local latency, so they characterise the memory service
rather than a model's output quality or performance on a large corpus.

## E7. Questions and notifications

`jobs/questions.ts` ranks and coalesces questions; attention delivery requires
a reason. Evidence in `attention.test.ts`:
`three questions in the same minute make one queue entry per job, and answering
the middle one wakes only that job`;
`an attempt that emits two questions asks one and asks the other on the next wake`;
`a quiet monitor with no delta writes no outbox row, and one with a delta writes
one that cites its reason`; and `the outbox refuses a notification that cites
nothing`.

These tests cover service state and outbox behaviour; [CLIENT](CLIENT.md)
describes how an interface presents questions and notifications.

## Verify

Run from the repository root:

```bash
bun test apps/melete/test/integration/memory.test.ts
bun test apps/melete/test/integration/effects.test.ts
bun test apps/melete/test/integration/attention.test.ts
bun run conformance:memory
```

The memory test entry imports the E1–E4 and broker-seam modules. Database tests
use embedded Postgres when no URL is supplied; when it cannot start, they are
reported as skipped, and `bun run doctor` names the missing prerequisite. The
general suite and the container probes (scenario 6, run with the Compose
opt-in) are described in [conformance](../conformance/README.md).
