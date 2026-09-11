# From a good design to a provable one

The memory design, the runtime contract and the broker protocol are sound. Their
remaining weakness is uniform: in seven places they depend on a model's
judgement, on invalidating conservatively, or on a promise stated in prose. Each
item below replaces one of those with a deterministic rule the service enforces
and a scenario a test can falsify. None of them adds a service.

Melete does not ask you to trust that it remembers correctly or acts safely.
Every one of the claims below has a scenario, and the scenario fails if the claim
stops being true.

## E1. Dependence is declared, not guessed

**Weakness.** Corrections invalidate affected summaries, drafts and plans, but
the service only knows what was *delivered* to an attempt, not what an output
*depends on*. The fallback is to invalidate conservatively, which at any scale
means every correction invalidates every responsibility that ever saw the claim,
and every re-plan starts from zero.

**Rule.** Recall returns items with stable handles (`claim_id@revision`,
`source_id@version`). Any consequential output the runtime produces, a draft, a
plan step, a proposed action payload, carries a `uses` manifest of the handles it
rests on. The broker refuses a `write_external` proposal whose payload contains a
recipient, date, amount or identifier that appears in a recalled item whose
handle is not in `uses`; the check is string containment against the delivered
items, which is cheap. Derivation edges are then exact: output revision to the
handles it used.

**Consequence.** A correction invalidates exactly the outputs that cite the
superseded revision, and the next attempt receives a *repair brief*: the trip
date changed from July to August; affected: draft d3 paragraph 2, plan step 2,
action a9, not yet admitted. Unattributed outputs still exist, chat prose mostly,
and they keep the conservative rule, but they are the minority and they are
labelled as such on the context record.

**Falsifier.** Correct one claim among five delivered; assert that only the
artifact citing it is marked stale, that the other four stay current, and that
the repair brief names the paragraph.

## E2. Keys, one active head, and contradiction as a state

**Weakness.** "Resolve meaning explicitly" and "a conflicting create or supersede
must not leave two active heads by accident" are correct and unenforceable as
written, because a claim's domain key is free text.

**Rule.** Every claim of kind fact, preference, constraint or exception carries a
typed key from a small registry (`event.<slug>.date`, `contact.<slug>.email`,
`pref.<domain>.<name>`, `constraint.<job>.<name>`); the registry lives in the
schema and grows by a reviewed commit, not by extraction. The database enforces
at most one active head per (space, key, audience) with a partial unique index. A
proposal that would create a second head is not merged and not dropped: it is
committed, the key enters `contradictions`, and one owner-facing question is
queued ("Which is right for the trip: July, said on the 3rd, or August, said on
the 10th?"). Until answered, recall in `current` mode returns the protected or
newest owner-stated head and flags the key as disputed; the runtime is told not
to act externally on a disputed key without approval.

**Consequence.** The model never decides which of two facts wins. Precedence is a
table: owner correction, then owner statement, then verified connector
observation, then document assertion, then inference; ties break by event time,
never by import time.

**Falsifier.** Ingest July (owner, day 3), then a document saying June (day 5),
then owner August (day 10), then an old email saying July (event time day 1,
imported day 12). Assert exactly one active head at each step, that the document
never becomes head, that the late import never becomes head, and that exactly one
question was queued for the one genuine conflict, owner against owner, if the
correction did not carry an explicit supersede.

## E3. Deterministic extractors for the facts that decide actions

**Weakness.** The extractor is a model call. Proposals will be noisy, and the
facts that matter most for a responsibility are precisely the ones models fumble:
dates, times, time zones, recipients, amounts, identifiers.

**Rule.** Two extractor tiers. Tier 0 is deterministic and runs first: date and
time expressions resolved by a real parser against the source event time and the
owner's time zone; emails, phones, URLs, amounts and currencies by grammar;
connector observations, calendar entries, contact records, receipts, become
`checked_fact` claims with no model at all. Tier 1 is the model, restricted to
proposing keys and spans; every span must be a verbatim substring of the evidence
at the offsets it names, every date must be parseable by Tier 0, every key must
exist in the registry, and a `confidence` field is accepted only as a hint, never
as a status. A proposal failing any structural check is rejected with a reason
and never attached to a convenient nearby message.

**Consequence.** The claims that drive `write_external` payloads, when, who, how
much, do not depend on model quality. Model quality only affects how much *else*
Melete remembers.

**Falsifier.** Run the trip scenario with a scripted extractor that returns a
wrong date span and a hallucinated email; assert that both are rejected, that the
Tier-0 date from the calendar connector is the head, and that the action payload
recipient comes from the contact claim.

## E4. Trust class travels from evidence to the broker's admission rule

**Weakness.** The security design contains prompt injection at the boundary: no
egress, brokered effects. The memory design keeps provenance. Nothing connects
them, so a fact planted by a hostile web page can become a claim, be recalled,
and land in the recipient field of an approved-looking send.

**Rule.** Every claim revision carries `origin_trust` from the set owner,
verified connector, external content, inferred, derived from its evidence; a
claim's class is the minimum over its sources. The broker's admission rule for
`write_external` and `spend`: any recipient, destination, amount or resource in
the canonical payload must be traceable, via E1 handles, to a claim whose
`origin_trust` is owner or verified connector, or the action requires a fresh
explicit approval that displays the origin ("this address came from a web page
fetched on Friday"), regardless of standing grants. Untrusted-origin claims can
never satisfy an authorization check and are shown with their origin in the
memory view.

**Consequence.** A hostile document cannot steer an external effect, even hours
later through a clean process, without a person seeing where the value came from.
Taint that lives only in a process cannot offer this, because it never reaches
memory.

**Falsifier.** Plant an email address in a fetched page; let extraction store it;
have the runtime draft a send to it under a standing grant; assert that admission
is refused with `untrusted_recipient_origin`, that the approval card names the
page, and that the same flow with an owner-stated address auto-admits.

## E5. Effect identity across attempts, not only within one

**Weakness.** Action identity is per proposal. After a runtime death the next
attempt re-plans and proposes "the same" send again; the broker sees a new
proposal and, with a valid approval, would admit a second effect. The
unknown-outcome rule covers the dispatched case; the approved-but-not-yet-
dispatched case and the re-proposed-after-completion case are the classic double
send.

**Rule.** The broker derives an `intent_key` from the job, the job revision, the
connection, the kind and the canonical payload hash, and enforces one action per
intent key across attempts: a re-proposal with the same key returns the existing
action and its current state, approved, admitted, dispatched, succeeded or
unknown, never a new one. A changed payload is a new key by construction. The
runtime's tool result for a re-proposal says "already succeeded at that time,
receipt that id" so the model does not repeat it.

**Falsifier.** Approve a send, kill the runtime before dispatch, resume; the new
attempt proposes the identical send; assert one action, one dispatch, one
receipt. Repeat with the kill after dispatch; assert the re-proposal returns
`unknown` and nothing is re-sent.

## E6. The memory conformance runner, counterfactual included

**Weakness.** The experiment plan is prose plus one integrated trip test. Memory
quality will drift silently the first time somebody tunes a prompt.

**Rule.** `conformance/memory/` holds scenario files in JSON: a sequence of steps
(`say`, `import` with event time, `observe` from a connector, `correct`,
`forget`, `kill_at`, `restore_from`, `ask` in `current` or `historical` mode with
the expected answer or the expected `disputed` or `unavailable`), one per family
from the experiment plan: stable personalization, corrections and time,
continuing work, relationships, source authority, forgetting and access,
low-value memory, procedure transfer. The runner executes them against the real
service with the scripted extractor and the fake provider, and a fourth arm runs
each scenario with memory withheld: a scenario that passes with memory withheld
is flagged "memory not exercised" and fails the suite. Output is a table per
family: passed, obsolete fact used, unsupported claim, needless question,
correction-to-serving latency, recall p95.

**Falsifier.** The suite itself. A change that makes the extractor cite a nearby
message, or makes a late import win, or makes a forgotten fact return after
restore, turns a row red.

## E7. Attention as a contract: one question per wake, one queue per person

**Weakness.** "Notify only when meaningfully new" is asserted. Reducing frequency
after unread results is the right start and not the whole rule.

**Rule.** A wake may end with at most one question; questions from all
responsibilities coalesce into one owner queue ordered by whether they block an
external effect, then deadline proximity, then age. Every notification carries
`because`, the event or claim handles that made it necessary, and `if_ignored`,
the concrete consequence with its date. A notification with an empty `because`
cannot be sent. The inbox renders those two fields and nothing else.

**Falsifier.** Three responsibilities each hit a question in the same minute;
assert one queue entry per responsibility, ordered by the rule, and that a quiet
monitor with no delta sends nothing; assert that a notification without `because`
is rejected at the outbox.

## What is deliberately not here

Scale fixtures and service levels (ten thousand claims, a recall p95 budget); the
prepared-context materialized view with its own dependency edges; the
dense-retrieval arm; the procedure-promotion gate; the virtual machine boundary.
Each is a real piece of work and none of them changes whether the seven claims
above are true.
