# W9 — the product surface that makes Melete agentic and natural

Append-only. Each section is one green commit: what changed, and the check line
that says it holds.

## 1. Identity and reply style

`packages/skills/builtin/identity.md` rewritten inside its 250-token cap (244 by
the loader's estimate). It now states the reply rules the style check measures:
answer first, one to three sentences unless detail was asked for or the thing is
the deliverable, a deliverable is an artifact, no preamble, no restating the
question, no bullets in a casual reply, never call yourself an AI, contractions
are fine, match the register, one question at a time. It also carries the
receipt rule, the stop rule (external, spend, irreversible, disputed,
untrusted origin), and the instruction to refer to prior work in one clause.

`packages/contracts/src/style.ts` is the deterministic check: banned openers
matched at the start of the reply only, a sentence budget by reply class
(casual 3, detailed 12, deliverable unbounded), at most one question mark, and
no self-reference as an AI. Code fences and code spans are removed before
counting, so a snippet containing a question mark is not a question.

`conformance/style/` holds the samples and the runner: seven good samples that
must come back clean and eight bad ones that must trip exactly the codes written
beside them. `bun run conformance/style/check.ts` prints the table.

`apps/melete/src/runtime/style.ts` wraps any runtime adapter, reads the text the
attempt committed, and hands the violations to a recorder. It never blocks: a
recorder that throws changes nothing about the outcome. `withMemoryRuntime`
wires it to `memory_contexts.style_violations` (migration 0014), so how an
attempt talked is recorded beside what it was given.

```
bun run typecheck                 clean
bun run lint                      Checked 295 files. No fixes applied.
bun test --max-concurrency=2      920 pass, 14 todo, 0 fail, 3845 expect() calls, 74 files
bun run openapi                   wrote packages/contracts/openapi.json (unchanged)
bun run client:generate           wrote packages/client/src/schema.d.ts (unchanged)
bun run compose:check             compose:check passed (12 checks)
```

Falsifier tests: `conformance/style/style.test.ts` "every sample gets the
verdict written next to it", "every banned opener is actually caught when it
opens", "the identity file is inside the 250-token cap it loads on every attempt
against"; `apps/melete/src/runtime/style.test.ts` "never blocks: a recorder that
throws does not fail the attempt".
