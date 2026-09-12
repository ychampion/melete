# 0017. Agentic and natural

Status: accepted. Supersedes nothing; extends 0006 (skills), 0009 (the Hermes
surface), 0011 (the attention contract), 0012 (provable memory properties) and
0014 (the memory conformance runner).

Melete's boundary is the part that is hard to get right and the part that is
easy to admire. It is also not what a person experiences. What they experience
is an assistant that writes three paragraphs when one sentence would do, that
wakes a model to look at an inbox where nothing happened, that starts every
attempt as though the last one never ran, and that can do exactly the things a
connector was written for and nothing else. This note is about the five changes
that close that gap, and about what each of them refuses to do.

## 1. The reply style is measured, not requested

The identity file states how to answer. Prose in a prompt is a wish: it cannot
be checked, so it drifts, and the drift is invisible until someone reads a
transcript and winces.

Four of the rules can be decided without judgment: no canned opener, a sentence
budget for the class of reply, at most one question mark, no describing yourself
as an AI. Those four are a function in `packages/contracts/src/style.ts`, with
samples in `conformance/style/` that name the codes each one must trip.

**The check never blocks.** It is recorded on the attempt's context record as
`style_violations` and nothing else happens. Blocking a finished answer because
it opened with the wrong word would be a worse failure than the word, and a
gate on outgoing text is a gate a model learns to talk around. Measurement makes
drift visible across releases; enforcement would make it invisible and worse.

The reply class is decided from records, not from how the text reads: an outcome
citing an artifact is a deliverable and its prose is a covering note, so it
carries no sentence budget. Everything else is measured against the tightest
budget, because that is the safe default.

## 2. Reactions

Not every message deserves a paragraph back. A person who read a result and is
satisfied wants one tap; an assistant told "thanks, got it" should be able to
answer with an acknowledgement rather than manufacturing three sentences.

A reaction is an event about an event. Melete has no message table — the durable
event stream is the transcript and a bubble on screen is one event — so a
message id is that event's `seq`, a reaction is an ordinary row on the same
stream, and it replays on reconnect with the message it belongs to. Nothing new
had to be stored to make reactions durable.

**A reaction is never a transcript row.** A system line saying "the owner
reacted to a message" is exactly the noise a reaction exists to replace. It is
drawn on the bubble or it does not exist.

Two glyphs mean something to the service: a thumbs-down from a person on an
assistant message makes that result count as two unread ones, and a thumbs-up
clears the streak the way opening the job does. A read result that was wrong for
someone is worse news than an unread one, and the reduced cadence should arrive
a cycle sooner. Everything else is expression and moves nothing.

The runtime reaches the same behaviour through a `react` tool: effect class
`read`, no connection, no approval, and refused for a message belonging to
another job.

## 3. Delta briefs

An attempt is disposable and the responsibility is not. Without a delta, every
wake rereads the whole history to learn the one thing it needs: what happened
while it was not running.

`since_last` is built from durable rows only — the actions since the last
attempt with their status and the connector's own receipt reference, artifacts
and knowledge written since, the question already asked and the ones still held,
the approvals nobody has decided, and any repair brief a correction produced.
`renderSinceLast` turns it into plain lines.

**An action with no receipt is never described as though it had one**, and a
first wake says so rather than inventing prior work. The delta is measured from
the newest attempt whose context still matches the current generations, so it
never names work the next attempt is not allowed to build on.

## 4. Watch predicates

A monitor that wakes a model every five minutes to look at an unchanged inbox is
not watching, it is spending. A `watch` trigger is the other thing: a small
deterministic predicate the service evaluates when a connector observation
arrives. No match, no attempt, no model call, no row.

The language is deliberately too small to hide a decision in: dotted field paths
into the observation, at most five clauses, all of which must hold, six
operators. **There is no `or`** — two reasons to wake are two watches, which
keeps every wake traceable to one predicate a person can read. Anything the DSL
cannot say is a thing the model should be woken for, not an operator the DSL
should grow.

Everything unclear is false: a missing field, a comparison between things that
are not comparable, a first sighting under `changed`. A watch that cannot tell
is a watch that does not wake. When one matches, the consumed-event notice
carries `because: ["event:<seq>"]`, so a wake can always name the observation
that caused it.

## 5. Capabilities

A connector reaches something that already exists. A capability makes something
that did not. The difference that matters is that generation costs money and
produces a file, so a capability call is an action of effect class `spend` like
any other: one action, an approval bound to the payload hash, a budget
reservation, an idempotency key, a receipt persisted before the runtime hears
anything, and a verify that reads the file back.

That is why a capability is implemented behind the connector interface rather
than beside it. Adding a second path to the world would mean a second place to
get approval, fencing and idempotency right.

Cost and effect class come from trusted configuration, never from a tool
argument: a model that could name its own price could spend the budget by asking
nicely.

The catalog an attempt sees is connectors ∪ capabilities filtered by grants, and
**a skill is offered only when every tool it names is in that catalog**. A skill
that tells the model to call something this installation does not have is a
promise the attempt cannot keep, and the person finds out after the model has
already said it would. Without a speech provider, `make-a-podcast` is absent.

The fake adapter writes a valid RIFF/WAVE file of silence with the script in its
metadata, so the whole path is exercised with no key and no network, and the
assertion "the episode says what the script said" is a real read of a real file.
A test that asserted on a placeholder string would prove nothing about the real
format.

## What is deliberately not here

Standing grants for capability spend; a reaction vocabulary with meaning beyond
the two glyphs the attention rule reads; `or` in the watch DSL, and predicates
over anything but a single observation; the three capability kinds named in the
enum without adapters behind them; a style check that grades tone rather than
form. Each would need a case that this release cannot make honestly.
