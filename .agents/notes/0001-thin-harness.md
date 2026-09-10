# 0001 - The harness is thin and the boundary is thick

Status: accepted
Date: 2026-09-11

## Problem

An assistant that plans well and acts carelessly is worse than useless, and an
assistant whose safety depends on the model choosing to be safe is not safe at
all. We had to decide where the intelligence lives and where the enforcement
lives before writing anything that would be expensive to move later.

## Decision

Frontier models plan and write. Melete enforces.

The model sees short things: an identity under 250 tokens, at most three skills
of at most 400 tokens each, at most 2,000 tokens of retrieved knowledge, and a
catalog of at most 15 tools. Everything the model does passes through a typed,
durable, auditable gate that behaves identically whether the model cooperated or
not.

The practical test: the harness has to work with a mid-tier model. If a rule
only holds because a strong model chose to follow it, it is not a rule.

## Alternatives

- **Long system prompt, rich tool surface, trust the model.** Cheapest to build,
  and the failure mode is a confident wrong action with no record.
- **Fine-tune a model on the enforcement rules.** Ties the release to one model
  and makes "model-agnostic" a lie.
- **Enforce in the prompt, verify afterwards.** Verification after an
  irreversible send is a report, not a boundary.

## Evidence

The context limits live in the contract as `CONTEXT_LIMITS`, not in prose, and
the client that assembles a prompt is tested against them. The state machine
that decides whether a job may call itself complete takes the runtime's claimed
outcome as one input among four: a completed attempt with an unresolved action
still goes to `needs_reconciliation`, and a final answer with no evidence becomes
a question.
