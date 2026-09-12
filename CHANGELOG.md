# Changelog

Each entry says what the version ships and what it does not claim. Claims map
to named tests on the tagged tree; the README's gates table is the summary.

## v0.1.0

The first release: a self-hosted assistant that carries a responsibility to
completion, never repeats an external effect it is unsure about, and asks once
when only the person can decide.

### Ships

- **Durable jobs.** A job is a bounded Postgres state machine with disposable
  attempts, leases, waits, approvals and receipts; pg-boss wakes are recovered,
  stale attempts are fenced, and runtime death is survived (conformance 1, 2, 5).
- **Brokered effects.** Every external action is canonicalized, hashed,
  scope-checked, approved when its effect class needs it, budget-reserved and
  receipted; an unknown outcome is verified or settled, never resent
  (conformance 3, 4). One logical effect has one identity across attempts.
- **Typed repair.** A failing connector says what kind of failure it met; the
  broker retries what did not leave, parks a rate limit, refreshes an expired
  credential once, stops on a revoked grant, repairs schema drift through a
  tested candidate, and never re-aims an effect. Safe stops are counted apart
  from completions.
- **A pinned engine per attempt.** Hermes Agent `v2026.9.7` with a
  hash-checked lifecycle observer patch, in a container with no route out; the service supervises one container per
  attempt on a Linux Docker host, mounting only the job's own workspace.
- **Tool discovery.** A token-budgeted core catalog plus `search_tools` and
  `load_tool`, with loaded schemas persisted for the attempt and a continuation
  that carries the same authority.
- **Connectors.** Files, web with SSRF checks, IMAP/SMTP email, ICS and CalDAV
  calendars, a test destination, in-cell `exec.run` and `exec.python` with
  artifact validation, speech generation, operator-configured MCP servers over
  HTTP with installation during a running session, bounded reconnect and sealed
  credential refresh, and a browser worker outside the cell with recipes and person takeover.
- **Memory.** Evidence with exact spans, versioned claims, protected
  corrections that invalidate exactly the outputs that cited them, Tier-0
  deterministic extraction, origin that reaches broker admission, forgetting
  that survives a database restore through an independent removal journal, and
  a memory conformance runner with a withheld-memory arm.
- **Attention.** One question per wake, one owner queue, a reason on every
  notification, reactions as acknowledgements, delta briefs and watch
  predicates that wake a job only when a small deterministic test holds.
- **Learning, scoped.** A correction becomes an episode, a candidate procedure,
  a held-out evaluation with a baseline arm, a canary and an activation, with
  rollback; for one procedure family (ordering typed table records). Explicit
  space activation shares only the evaluated body with authorized members.
  Source episodes, corrections and evaluations remain private.
- **Accounts and spaces.** Additional principals, shared spaces, audience-
  qualified skills and membership revocation that fences delivered context, as
  API primitives.
- **Experience API and web app.** Conversations, permission cards, receipts
  with undo, drafts sent by the person, quick answers, agents, plans, tasks,
  routines, saved details, rules and search; the web app draws only what the
  contract carries, and the mock plays scripted scenarios through the same routes.
  Reactions resolve to exact message identities and text-only controls; setup
  answers become saved memory, and sign-out revokes the current session.
- **Deployment.** A Compose stack with an internal-only runtime network in
  isolated gateway mode, a per-attempt work subpath, a warm probe cell, a web
  proxy on the browser's own origin, a configuration generator, 23 static
  boundary checks, a runtime image that asserts its engine commit and plugin
  hash and writes a CycloneDX inventory, and a restore procedure that keeps the
  removal journal apart from the database snapshot.

- **Evaluation evidence.** A resumable harness with bounded spend reservations,
  durable phase checkpoints, 70 synthetic destination fixtures and separate
  deterministic and language grades. Reads receive fresh identities on a new
  attempt; writes retain their durable identity. Broker-owned waits and parked
  settlement preserve approval and reconciliation boundaries. Gateway startup
  and typed memory recall have regression coverage.

### Measured

Previously measured on one Linux Docker host: the clean-host install completed in about 65
seconds; conformance 1–8 passed 44 tests and skipped one (the second-provider
comparison, which needs a credential); the memory runner passed ten scenarios
across seven families with every withheld-memory arm failing as required;
restart under an active job and under a parked approval recovered with one
receipt; the restore proof served the forgotten fact to nobody and produced
exactly one destination effect. See the README's gates table for the test
suite counts on Windows and Linux. The combined real-Hermes capability proof
passes five stages and 85 assertions with a scripted HTTP provider.

### Not claimed

- Passing autonomous task performance or answer quality with a real model. The
  recorded Fireworks campaign failed its own gate: deterministic passes were
  34, 32 and 38 of 70 across three runs. It observed zero duplicate effects and
  zero successful injections within the documented fixture exposure. Ordinary
  tests use scripted providers; the paid campaign is a separate explicit command.
- Learning beyond the one evaluated procedure family.
- Real transcript compaction and production stdio MCP launch; the latter
  requires an isolated launcher. Session and tool hooks, HTTP connection
  installation, recovery, refresh and evaluated member reuse are tested.
- Virtual-machine isolation, confidential compute, host-compromise containment,
  rootless Docker, and any operating system other than a Linux Docker host for
  the sealed cell; the service holds the Docker socket and sits inside the host
  trust boundary.
- Interactive sign-in inside the browser worker, the browser image and combined
  Compose stack (not run), and provider OAuth stored inside the runtime.
- An exportable tamper-evident action ledger, an upgrade procedure between
  releases, universal physical erasure of forgotten data, and an invitation
  interface for shared spaces.
- On current Linux hosts the embedded Postgres binary does not start, so the
  test suite needs `DATABASE_URL`. Chromium and the pinned local Hermes
  environment are additional prerequisites for their optional fixtures;
  omissions appear as skips or TODOs, not passing coverage.
