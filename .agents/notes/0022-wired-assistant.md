# Wired assistant: bundles, startup and disposable engines

W15 connects the existing service modules through `bootstrap()`. The runner
commits an attempt identity before any catalog or memory call that requires its
capability. `buildAttemptSkeleton` reserves the durable slice and selected
skills; `buildBundle` adds the broker catalog, current memory recall, durable
delta and pending repair briefs. `withMemoryRuntime` records that exact recall,
then fences stale events and outcomes. The additive contracts are listed in
`proposed/2026-09-12-w15-contract-additions.md`.

The schema at W15's starting commit has one owner and no membership column.
Selection therefore uses the job's space. W14's branch had no bundle change at
startup; the integrator should check subsequent skill or membership work before
merging. The gateway and broker use only service-owned credentials. Each engine
gets its bounded attempt capability and an independent API key; neither the
database URL nor provider, approval or master keys enter its environment.

The process supervisor runs `python -m hermes_cli.main gateway run` from the
job's workspace, with a fresh temporary home and the unmodified pinned checkout
at `2237be355906fbe6065ce1815711eee52b2d646e` (v2026.9.7). The HTTP dependency is
`aiohttp==3.14.3`. It kills the complete owned process tree and removes the home
on attempt end. Canonical transcript, constraints, delta and repair briefs are
rendered into every new engine's input. The per-job workspace remains available
to later attempts. Process mode has the launching user's OS access and is
intended for local development.

The thin config disables auxiliary title generation and background review, and
the plugin serializes broker results into the text format accepted by the
pinned Hermes registry. At the live service boundary the broker records an
approval request without moving the job out of `running`: the runner must
first finish the attempt under its lease. Standalone broker callers retain
their existing transition behavior. Reusing a proposal after a job revision
change fails its obsolete unadmitted action and creates a fresh approval
binding; admitted or completed effects retain their existing identity.

The Docker supervisor uses the local CLI without a shell. It rejects a network
unless Docker reports `Internal: true`, rejects an image with the wrong engine
pin label, verifies the container joined only that network, mounts the named
work volume's job subdirectory at `/work`, and removes the container when the
attempt ends. It uses a read-only root, non-root UID, no capabilities, resource
limits and temporary Hermes home. Docker 27 or later is required for volume
subpaths. The service's `/work` directory shares group 10001 with runtimes;
new job directories explicitly retain group write access after the service's
umask is applied. `DOCKER_GID` grants the service access to the socket. Runtime
containers never
receive the socket. Compose's default image-building service runs `/bin/true`
with no network, while the old static engine is an idle `runtime-dev` profile.

Docker is unavailable on the W15 Windows host. The image build, socket group,
volume-subpath permissions, container lifecycle and actual network isolation
are **unverified**; W6 must exercise them on Linux. Static Compose checks and
supervisor rejection tests are evidence about configuration and admission,
not evidence that Docker has run. The existing internal network also contains
Postgres; `internal: true` alone does not isolate peers on that network.

`wired-assistant.test.ts` starts `bootstrap()`, Postgres, pg-boss, the broker and
the real local Hermes server. Only the model provider is scripted. The test
uses HTTP login, creates a travel job, observes its first approval wait,
registers an output's claim dependency, corrects the claim over HTTP, and checks
the replacement bundle and captured provider request. It checks three selected
skills, two handled claims, delta, repair and the written context diagnostic
array, and prints cold-start and attempt wall times. Missing local engine
installation skips this specific proof with a reason; it must run before a
release claim. Timing and final results belong in `REPORT.md`.

The gateway charges output against `max_output_tokens` (8,000 by default) and
checks request input against the separate, model-derived `max_input_tokens`
allowance. Oversized assembled prompts are refused before engine launch with
`input_context_exceeded`. The fake-provider proof posts a job with no budget. `style_violations` is currently an empty array:
there is no configured prose style checker. Automatic extraction of arbitrary
text still needs an extraction gateway; existing claims, recall, explicit
corrections and deterministic structured observations work without one.

The retained restriction journal lives at
`MELETE_SPACES_DIR/.memory/restrictions.jsonl`. Startup creates it only when no
memory spaces exist; existing memory with a missing journal refuses startup.
Keep it when restoring older database snapshots. Memory's `job_recompute`
outbox commits a queue wake before marking delivery complete; repeated wakes
are rejected by the runner's epoch and state-version checks.
