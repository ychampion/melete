# Release readiness report

Branch `lane/w13-release`, worktree created from `origin/integration` at
`55b6a5071527adbc8332e5eb837aa7ea8b3a5a1b` (the landed head). Append-only.

## Assumptions

- The public web app (`apps/web`) decides a permission against the action's
  canonical payload hash but never displays the hash, by the interface rule in
  `docs/CLIENT.md` ("no backend vocabulary in the interface"). The demo therefore
  shows the permission card, the receipt and the person-settled unknown outcome;
  the hash itself is visible only through the API (`GET /approvals`) and the
  mock's test `the payload the approval shows is canonical, not what the model
  typed`. The correction-invalidates-a-draft-and-yields-a-repair-brief flow is a
  service property (`a correction marks stale exactly the output that cited it
  and says what to repair`, `the next attempt is handed the repair brief in its
  inputs`) with no surface in the web app or the mock's experience routes, so the
  recording does not include it and the README caption says so.
- The scrub pattern from the brief also matches legitimate code: the
  `codex_responses` API mode name, the `claude-` and `gpt-` redaction pattern in
  the experience projector, a `claude-served` fake model id in a gateway test,
  the `astra` variable in the supervisor test for the `gpt-6-astra` provider,
  the pinned `ghcr.io/astral-sh/uv` image digest and the removal of the build
  container's root-home uv cache in the runtime Dockerfile. Code is out of this
  lane's scope, so those stay; the CI scrub check therefore matches the brief's
  narrower pattern (the Windows user-profile prefix, the Linux root home, the
  per-lane worktree prefix, and the two working-session phrases) and allows the
  one Dockerfile line, whose path belongs to the build container.
- `docs/CAPABILITIES.md` is rewritten against the landed tree. The capability
  gate uses the statuses from `docs/CAPABILITIES.md` on `lane/w14-capabilities`
  as the team lead instructed, but cites only tests that exist on `55b6a50`; the
  real-Hermes capability proof on that branch is written as pending.
- The local `v0.1.0` tag is prepared on the landed integration head `55b6a50`
  as the brief says. If the release is cut after this branch merges, the tag
  should be moved to that merge commit before pushing; the command is recorded.

## Slice 0: setup

- Command `git worktree add -b lane/w13-release <worktree> 55b6a50`: `HEAD is now at 55b6a50 Record the web lane merge`.
- Command `bun install`: 378 packages installed.
- Command `bun run compose:check`: `compose:check passed (19 checks)`.
- Command `git grep -i -E "managed hosting|enterprise|compan(y|ies)|business plan" -- . ':!node_modules' ':!bun.lock'`: no output at the landed head.
- Command: the brief's full scrub grep (the two path prefixes, the worktree prefix, the two session phrases, and the five model or harness names) over tracked files minus `node_modules` and `bun.lock`, with the `gpt-6-astra` lines removed: 44 lines across 13 files at the landed head; docs and notes hits are handled in the scrub slice, code hits are listed under Assumptions.

## Scrub and README (commits below)

- Command: the same full scrub grep after the rewrite: 11 lines, all code (`experience/projectors.ts:33` redaction pattern, `gateway/index.test.ts:420,424` fake model id, `runtime/supervisor.test.ts:69,74` and `runtime/supervisor.ts:86` for the `gpt-6-astra` provider's `codex_responses` API mode, `packages/runtime-hermes/Dockerfile:38,53` pinned `astral-sh/uv` image and its build-container cache path). No documentation or note line remains.
- Command `bun run lint`: `Checked 531 files`, one pre-existing Biome warning, then `scrub:check passed (794 tracked files)`, exit 0.
- Command `bun run typecheck`: exit 0.
- Commit `Scrub local paths and working-session phrases from the record and check for them in lint`: `.agents/notes/{0018,0021}`, four lane reports, `LANDING-REPORT.md`, `docs/CAPABILITIES.md`, `scripts/scrub-check.ts`, `package.json` (`lint` now runs `scrub:check`).
- Commit `Rewrite the README around the promise, the six gates and the install path`: `README.md`, `REPORT.md`.
