# Changelog

Each entry says what the version ships and what it does not claim. Claims map
to named tests on the tagged tree; the README's gates table is the summary.

## Unreleased

### Ships

- **Long conversations are compacted as they run.** When an attempt's
  conversation grows past its trigger, the engine summarizes the middle and
  carries on inside the same attempt, without the job stopping or a request
  being refused for size. The summary is written by the attempt's own model
  through the model gateway, so it is authorized, metered and recorded like any
  other call, and every compaction becomes a durable observation on the job's
  timeline carrying its count. A summary is lossy by nature; every durable fact
  stays on the ledger, not in the conversation. `MELETE_COMPACTION_MAX_TOKENS`
  sets how large a conversation may grow first and `MELETE_ENGINE_MAX_TURNS` the
  ceiling on one run's iterations, both documented in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **One place decides what the runtime engine does.** The settings an engine is
  started with are rendered from a single description, for the image, the boot
  script, both supervisors, the evaluation stack and the local harness alike,
  and a test fails if the file the image carries drifts from it. Turning off the
  engine's own memory now uses the keys it actually reads, so nothing an owner
  asked to forget can return through it, and `compose:check` refuses a
  configuration that leaves the memory keys, the turn ceiling or compaction
  unpinned.
- **Continuous integration.** Pull requests and pushes to `main` run the
  typecheck, lint, both Compose checks, the test suite against a Postgres 17
  service, the runtime plugin suite and a build of the service, web and runtime
  images. Actions are pinned by commit and no secret is read; a test fails the
  workflow if it names a script or file that does not exist.
- **The runtime image's plugin pin is checked without Docker.** The image hashes
  `packages/runtime-hermes/melete_plugin` while it builds and refuses a
  `MELETE_PLUGIN_SHA` that describes anything else. `compose:check` now
  recomputes that digest from the tracked files and names the value the pin
  should carry, so a plugin change that leaves the pin behind fails the static
  checks instead of the image build.
- **Bounded logs.** Every Compose service and every attempt container rotates a
  `json-file` log at 10 MB with five files. `compose:check` (30 checks) and
  `browser:compose:check` (12) refuse a service without the bound.
- **A Docker Engine preflight.** In Docker runtime mode the service asks the
  engine for its version before it opens the database, and stops with one
  message naming Docker Engine 28.0 and Docker Compose 2.33.1 when the engine is
  older than API 1.48, has dropped it, or cannot be reached. The configuration
  generator and the upgrade script refuse an unsupported host the same way, and
  `bun run doctor --docker` reports it.
- **An upgrade procedure between releases.** [docs/UPGRADING.md](docs/UPGRADING.md)
  and `deploy/scripts/upgrade.ts`: a preflight, a consistent backup that keeps
  the restriction journal apart, a checkout of the tag, images tagged with the
  release version as well as `:local`, a wait for health and for every migration
  in the journal, and the exact rollback into an empty database volume with the
  newer journal retained. `--dry-run` prints the plan.
- **Accounts act only in their own space.** Every request derives its space from
  the account its session authenticates: that account's own personal space, or a
  space the session stored while the account is still a member of it under the
  membership generation it was stored with. An account without a personal space
  receives one on first use. Conversations, plans, routines, permissions,
  drafts, receipts, undo, search, the event stream, artifacts, reactions,
  browser takeover and a job's repair briefs are checked against the job's
  principal as well, so one account never reads or steers another's work.
  A request header still cannot name a space or an owner.
- **Sign-in limits a stranger cannot use to lock out a browser you know.** A
  successful sign-in or setup sets a signed `melete_device` cookie, and a
  browser presenting one for the account it signs in to spends its own budget of
  attempts: however many attempts arrive from other browsers or addresses, that
  browser can still sign in. Browsers new to an account share one per-account
  limiter that counts wrong passwords, and the per-address limit follows the
  client address the web proxy states, believed only on a connection from the
  proxy Compose names and never from a header a browser sends. `/setup` has its
  own limiter and answers 409 once an owner exists.
- **The first tools come from what the job says.** The core catalog an attempt
  opens with is ranked by its overlap with the job's objective, the latest owner
  message and the registered trigger, and the lifecycle wait and the reaction are
  pinned when the turn needs them. Nothing is hidden by the choice: what is left
  out is still there to be loaded by name.
- **Tool search matches any word.** `search_tools` matches on any term in the
  query, stems it and reads the segments of an identifier, so `send mail` finds
  `email.send`. A search that matches nothing says what `load_tool` can fetch
  instead of returning an empty list.
- **An approved action is carried out exactly as approved.** After a decision the
  next attempt is told which tool the owner approved and which stored arguments
  go with it, and carries it out by id with `resume_action`: no arguments are
  retyped, and the broker admits and dispatches the same canonical bytes the
  owner read, under the new attempt's authority. A restart between the approval
  and the send changes nothing — the action leaves once, and a proposal of the
  identical bytes still works for a runtime that makes one.
- **An attempt that asks to act without proposing waits for the owner.** A reply
  that asks for a go-ahead on an external effect it never proposed is answered
  once with a note to call the tool, since the broker asks the owner before
  anything leaves. If the attempt asks again it is recorded as waiting for the
  owner rather than as finished work.
- **Waits are named by event, and a correction does not lose one.** The attempt
  input lists the job's enabled triggers with their event names and a plain
  description, so a wait can name the event rather than an id nothing showed it.
  When an owner's correction requeues an attempt, its input says the wait was
  cancelled and none is in force; if that attempt then completes without choosing
  another, the cancelled wait is restored, as long as its trigger is still
  enabled or its timer still ahead and no action is pending.
- **Reactions need no message id.** `react` takes the glyph alone and lands on
  the owner's latest message on the same job. The reaction is an event on that
  job, so the account whose job it is sees it and nobody else does.
- **An offline regrade for recorded evaluation campaigns.**
  `bun run evals -- --regrade <artifact>` scores a recorded campaign's cells
  again from the evidence each one kept, with no model call and no network. The
  deterministic grader now separates an offer made after an answer from a request
  for leave to do the task, counts a replaced value as asserted when the reply
  stands by it, accepts a standalone number for a required fact, and never sets a
  word budget below fifteen words.
- **Tools from the first conversation.** A new installation has files, web
  reading and finished-work publishing without anyone installing them, plus
  speech where a speech-capable provider is configured and code in the
  workspace where attempts run in a container. Each is an ordinary connection
  row in the space it belongs to, admitted by the broker exactly as any other
  is, so a publication still waits for approval. An account provisioned later,
  and an account whose own space is made on its first request, is furnished the
  same way and only in its own space. An existing installation gains the
  defaults once at the next start, a grant its owner already made is kept
  undoubled, and a default that is removed stays removed.
- **Mail, calendars and MCP servers installed from Settings or the API.** `GET
  /connection-kinds` says which kinds exist and which fields each one takes,
  and Settings draws its form from that alone: a mailbox over IMAP and SMTP, a
  CalDAV calendar, a published calendar feed, and an MCP server over HTTP.
  `POST /connections` seals the password, token or feed address with the master
  key before the row is written, and no route returns it. The new connection is
  tested once and reports a fixed code rather than a transport message; a feed
  address must be public HTTPS and is checked again on every read; installation
  is the work of the owner of a space whose audience is its owner. Settings
  tests a connection again or removes it, and leaves the connections the
  service keeps in place.

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

- Reliable autonomous task performance or answer quality with a real model. The
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
