# Contributing

Melete is pre-release and moving fast. If you are thinking of doing more than a
small fix, open an issue first so we can tell you whether it collides with
something already in flight.

## Getting set up

Requires [bun](https://bun.sh) 1.3 or newer. Node 22 is listed in `.nvmrc` for
tooling that wants it.

```bash
bun install
bun run typecheck
bun run lint
bun test
```

Nothing needs a database. Tests that would use one skip themselves with a
message when `DATABASE_URL` is unset.

## Before you open a pull request

```bash
bun run typecheck
bun run lint
bun test
bun run openapi        # commit openapi.json if a schema changed
bun run compose:check
```

`bun run lint` runs Biome for both linting and formatting. `bun run lint:fix`
applies what it can.

## How to make changes that fit

- **Change the contract first.** `packages/contracts` is the shared vocabulary.
  If a boundary moves, it moves there, and every caller that needs to know breaks
  at compile time.
- **Regenerate the OpenAPI document.** A test fails if `openapi.json` differs
  from the schemas by a byte.
- **Test the behaviour, not the implementation.** The valuable tests here are the
  ones that describe a rule: an approval cannot be spent on different bytes, a
  retracted record leaves retrieval, a stale attempt cannot act.
- **Do not widen the model's surface casually.** Any change that adds a tool,
  lengthens a prompt, or loosens a limit should say in the pull request why the
  harness still works with a mid-tier model.
- **Write a note for a decision.** `.agents/notes` has one file per decision:
  problem, decision, alternatives, evidence. Supersede, never edit history.
- **Say what you did not verify.** A pull request that says "the compose file is
  syntax-checked but I could not start Docker" is more useful than one that
  implies otherwise.

## Style

Comments explain why, not what. If a line needs a comment to say what it does,
the line is usually the problem.

Commit messages are plain prose in the imperative: "Add the broker's payload
canonicaliser", not "feat(broker): add canonicalizePayload()".

## Licence

By contributing you agree that your contribution is licensed under Apache-2.0,
the same as the rest of the project.
