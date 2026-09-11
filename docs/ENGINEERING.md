# Engineering evidence

This maps implementation properties at code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1` to tests. It does not equate a design
goal, an injected test seam or a small scripted fixture with a released feature.
Run outcomes are in [REPORT.md](../REPORT.md).

## E1. Declared dependencies and repair briefs

`memory/outputs.ts` records output manifests and derivation edges.
Corrections can mark cited output revisions stale and create repair briefs;
outputs without attribution retain conservative invalidation.

Evidence in `properties-e1-tests.ts`:
`a correction marks stale exactly the output that cited it and says what to
repair` and `the next attempt is handed the repair brief in its inputs`.
The attribution utility checks supported literal values, not arbitrary meaning.
Automatic complete attribution of every model output, and a universal
broker-side rejection for every omitted dependency, are **not claimed**.

## E2. Keyed heads and disputes

The typed registry lives in `packages/contracts/src/provenance.ts`;
`memory/contradictions.ts` applies keyed precedence and stores disputes.
Database indexes constrain one visible keyed claim and one active/disputed
revision per claim. Older unkeyed paths remain.

Evidence in `properties-e2-tests.ts`:
`July, then a document, then August, then a late email: one head, one question`,
`the database refuses a second claim on one key`, and
`the owner answers the queue entry and the key is settled`.
Universal semantic equivalence and retroactive keys for all claims are
**not claimed**.

## E3. Deterministic extraction and structural validation

`memory/service.ts` tries Tier-0 observation extraction before model proposals.
`tier0.ts` and `validate.ts` check supported structured facts, registry keys
and exact source spans. Rejections are recorded rather than attributed to
unrelated evidence.

Evidence in `properties-e3-tests.ts`:
`a wrong span and a hallucinated address are rejected; the connector date is
the head`. This proves the exercised rejection cases. General date/time
understanding, model-independent correctness of all action values and truth of
every extracted claim are **not claimed**.

## E4. Origin reaches the admission gate

The effect boundary installs `createMemoryTrustResolver`. It resolves values
against handles recorded for the job and returns origin to the broker.
Recognized recipient, destination, amount and resource fields with untrusted or
unknown origin require fresh approval reflecting the origin warnings.

Evidence: `a page-sourced address is external content; the same address from
the owner is not` in `properties-e4-tests.ts`;
`an address read off a page is refused as untrusted_recipient_origin` in
`broker-seam-tests.ts`; and `an approval given before the origin was known
does not count` in `effects.test.ts`.
The rejection seam deliberately injects permissive policy to challenge the
gate; a reusable owner send-authorization feature is **not claimed**.
The tested field vocabulary is not a proof against arbitrary encoded or
unrecognized destinations.

## E5. Effect identity across attempts

`intentKey` in `packages/contracts/src/effects.ts` derives identity from
job, revision, connection, kind and canonical payload hash. The broker and
database uniqueness constraint reuse an existing logical action across attempts.
Changed payloads require a distinct approval.

Evidence in `effects.test.ts`:
`an attempt killed before dispatch is replaced, and the same send happens once`,
`an attempt killed after dispatch with a lost acknowledgement re-proposes
into unknown`, and `the database itself refuses a second action for one
intent key`. These particular tests simulate replacement through fixture
state; the names do not mean they kill a whole deployed runtime. Real child
process fault schedules also exist in conformance 1 and 5. Arbitrary semantic
deduplication of differently worded effects is **not claimed**.

## E6. Memory scenarios with a withheld-memory arm

The [memory runner](../conformance/memory/README.md) calls the real memory
functions against disposable Postgres, with scripted extraction and answers
over local HTTP. It does not boot the normal service entry point or exercise
a Compose installation. Ten executable scenarios span seven families; procedure
transfer is **written, not run** as a todo.

Each executable scenario requiring memory runs again with empty recall; a
scenario that still passes fails the suite as `memory not exercised`.
The falsifiers in `conformance/memory/breaks.test.ts` include
`a late import that wins turns the corrections family red`,
`accepting a nearby-message citation turns the source-authority family red`,
and `skipping the restriction replay turns the forgetting family red`.

These measure scripted recall behavior, obsolete answers, unsupported answers,
needless questions and local latency. Real-model output quality, learning,
large-corpus performance and statistical superiority are **not claimed**.

## E7. Questions and notifications

`jobs/questions.ts` ranks and coalesces questions; attention delivery requires
a reason. Evidence in `attention.test.ts`:
`three questions in the same minute make one queue entry per job, and answering
the middle one wakes only that job`;
`an attempt that emits two questions asks one and asks the other on the next wake`;
`a quiet monitor with no delta writes no outbox row, and one with a delta writes
one that cites its reason`; and `the outbox refuses a notification that cites
nothing`.

These tests cover service state and outbox behavior. A complete reference client
for every new attention surface, absence of approval fatigue and perfect
notification relevance are **not claimed**.

## Verify

Run from the repository root:

```bash
bun test apps/melete/test/integration/memory.test.ts
bun test apps/melete/test/integration/effects.test.ts
bun test apps/melete/test/integration/attention.test.ts
bun run conformance:memory
```

The memory test entry imports the E1–E4 and broker-seam modules. Database tests
use embedded Postgres when no URL is supplied; missing binaries may cause skips,
which are not passes. The general suite and the **written, not run** container
probes are described in [conformance](../conformance/README.md).
