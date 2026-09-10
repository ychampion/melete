# 0002 - The v0.1 engine is a pinned, unmodified Hermes release

Status: accepted
Date: 2026-09-11

## Problem

We need an agent loop this week: context assembly, provider calls, streaming,
tool dispatch, stop conditions. Writing one is roughly 1,000 to 1,500 lines we
would then own forever. Adopting one risks inheriting its opinions about memory,
tools, and identity, which are exactly the things Melete has to control.

## Decision

The v0.1 engine is Hermes at tag `v2026.9.7`, unmodified, configured thin,
behind the `RuntimeAdapter` interface. No fork.

Thin means `skip_memory`, `skip_context_files`, built-in toolsets disabled, one
trusted Melete plugin that registers the broker's tools and nothing else,
`HERMES_EXEC_ASK=1` so approvals surface over HTTP, an identity under 250 tokens
in place of SOUL.md, and at most three skills per attempt. Melete consumes the
run's event stream once and persists before fan-out. An interrupted run is a
dead attempt and is never resumed.

A native TypeScript runtime remains the documented exit if divergence grows. The
`RuntimeAdapter` interface exists so that would be a swap, not a rewrite.

## Alternatives

- **Write the loop now.** Correct eventually, too slow for this week, and it
  would compete for attention with the broker, which is the part nobody else has.
- **Fork Hermes and cut what we do not want.** Every upstream release becomes a
  rebase. Configuration achieves the same result and survives updates.
- **Another harness with a plugin system.** None examined had both an HTTP run
  API and a working approval bridge.

## Evidence

Probe against `HEAD 77e55b4` (2026-09-10):

> `api_server` is in `_UNATTENDED_APPROVAL_PLATFORMS` so bare `/v1/runs` blocks
> Tier-2 dangerous commands with "unattended platform (api_server) with no user
> present" and the gateway notifier never fires; with `HERMES_EXEC_ASK=1` the
> notifier fires with `request_id`/`command`/`pattern_key`/`allow_session`/
> `allow_permanent` and both "once" and "deny" resolve correctly via
> `resolve_gateway_approval`; nobody-answers blocks until the 300 s approval
> timeout.

That is the difference between an approval the owner can answer and a refusal
they never see, and it is one environment variable. The image sets it.

The install path in the Dockerfile is the one upstream uses in its own container
build at that tag: `uv sync --frozen --no-install-project`, then
`uv pip install --no-deps -e .`.

Melete answers `once` or `deny` and never `allow_session` or `allow_permanent`.
A standing allowance would outlive the attempt it was granted for, which is the
property the broker exists to prevent.
