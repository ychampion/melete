# 0006 - Skills are short Markdown files with triggers

Status: accepted
Date: 2026-09-11

## Problem

A capable assistant needs procedure knowledge: how this person likes a follow-up
written, what "organise these" means for their filing. Putting all of it in one
system prompt makes every attempt expensive and most of the context irrelevant.

## Decision

A skill is a Markdown file with frontmatter: `name`, `description`, `triggers`,
`tools`, and `max_tokens`, capped at 400. The body is short imperative
instructions, no persona, no restatement of tool documentation.

Selection is a deterministic trigger match against the job objective and the
latest user message, weighted so the latest message counts double, with ties
broken by supply order. At most three load per attempt.

Selection deliberately does not call a model. Anything that decides what the
model sees must not itself depend on model judgment, or a mid-tier model degrades
the harness rather than merely the writing.

## Alternatives

- **Embed skills and retrieve semantically.** Better recall, another embedding
  dependency, and non-deterministic bundles that make a failing attempt hard to
  replay.
- **Let the model pick its own skills.** One extra round trip and a new way for
  injected text to steer what the model reads.
- **One long system prompt.** Expensive on every attempt, and it dilutes the
  instructions that matter for this job.

## Evidence

`selectSkills` is tested for determinism: the same inputs give the same bundle,
and reversing the input order reverses only the tie-break. It caps at three
however many match, respects a lower maximum, ignores case and punctuation, and
reports which triggers fired, so a bundle can be explained to the person whose
job it was.
