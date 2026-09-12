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
  the pinned `ghcr.io/astral-sh/uv` image digest and `rm -rf /root/.cache/uv` in
  the runtime Dockerfile. Code is out of this lane's scope, so those stay; the
  CI scrub check therefore matches the brief's narrower pattern
  (`C:/Users|/root/|melete-oss-|fix cycle|shared lock`) and excludes the
  runtime Dockerfile, where `/root/.cache` is the build container's own cache path.
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
- Command `git grep -n -E "C:/Users|/root/|melete-oss-|fix cycle|shared lock|codex|astra|opus|fable|claude" -- . ':!node_modules' ':!bun.lock' | grep -v gpt-6-astra`: 44 lines across 13 files at the landed head; docs and notes hits are handled in the scrub slice, code hits are listed under Assumptions.
