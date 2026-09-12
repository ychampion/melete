# Melete evaluations

These evaluations run the actual Melete API, broker, Postgres authority, model gateway, pinned Hermes engine, and Melete plugin. The external destinations are fixtures: no scenario sends a real email, changes a real calendar, or modifies a real server. The destination records every acceptance without deduplicating it, so duplicate dispatches remain observable.

## Run

Install the repository's locked dependencies with `bun install --frozen-lockfile`. Docker must have the pinned runtime image available as `melete-runtime:local`, or set `EVALS_RUNTIME_IMAGE` to an existing image. The harness verifies the engine commit inside the image, then builds a small derivative with the current checked observer bridge and support module. Current plugin and entrypoint files are mounted read-only. To build an image on a machine with sufficient free disk:

```sh
docker build -t melete-runtime:local packages/runtime-hermes
```

Set `FIREWORKS_API_KEY` through your environment, not a command-line argument or a tracked file. Then run:

```sh
bun run evals -- --provider fireworks --model accounts/fireworks/models/deepseek-v4p1-flash --suite all --runs 3 --campaign acceptance --budget 50 --workers 3
```

Without that environment variable, the command uses the scripted transport and records Fireworks inference and language-rubric grading as **not run**. A scripted pass is evidence of an exercised product boundary, not evidence of the requested model's judgment, instruction-injection resistance, or writing quality.

```sh
bun run evals -- --provider scripted --suite all --runs 3 --campaign scripted-check
bun run evals -- --list
bun run evals -- --provider scripted --case approval-mail-approved --runs 1 --workers 1 --campaign approval-check
```

`--suite` accepts `asks`, `approval`, `unknown`, `memory`, `waits`, `injection`, `briefing`, `naturalness`, or `all`. The corpus has 70 cases: eight per suite, plus six combined correction/wait/trigger cases in the waits suite. Each repetition uses a recorded seed and a different deterministic shuffle. At most three workers run concurrently. Every worker has a separate API listener, broker listener, model-transport instance, and SQLite connection; all share the same atomic budget ledger.

The Compose project is always `melete-evals`. The API ports are 19187, 19197, and 19207; broker ports are 19188, 19198, and 19208. Runtime ports are not published. Each attempt gets its own non-root, read-only container, private API credential, scoped attempt capability, and per-job writable home. The runtime receives a surrogate model key, never the provider credential. The harness reuses existing image layers, bounds container logs, and stops before starting an attempt with less than 1 GiB free. It never prunes Docker.

## Results and the release gate

`docs/EVALS.md` documents the latest recorded campaign. `evals/results/<campaign>.json` contains metadata, per-suite tables, individual checks, replies, and database/destination evidence. The deterministic result and language rubric are separate columns. Unknown safety counters are null, not fabricated zeros. Reports are replaced atomically after each completed case.

A normal evaluation command records failures without hiding subsequent cases. Add `--gate` for release gating: a failed or unobserved case, failed or unavailable rubric, or scripted fallback makes the exit status nonzero. Therefore, a green scripted run cannot certify the Fireworks release gate.

The price schedule is explicit in `state.ts`. Agent calls and judge calls reserve money in the same journal before requests leave the service. Missing or invalid usage keeps the full reservation. The total budget cannot exceed $50, and changing the campaign name does not reset accumulated spend. Only the named model is priced; other paid model IDs are rejected. All workers share a seven-second request interval. HTTP 429 and 503 responses get at most two retries with bounded backoff; unsuccessful requests retain their conservative reservations when usage is unavailable.

## Resume and crash checks

Repeat the identical command to resume. A completed case is read from the journal rather than executed again. Submitted job identities, owner decisions, initial evidence, and trigger phases are checkpointed. API submissions use stable idempotency keys. A new source, model, provider, image, seed, or scenario selection cannot be substituted into an existing campaign.

Private state lives in `.eval-state/`, which is excluded from version control, including when it is a symbolic link. `EVALS_DATA_DIR` can place database and runtime-home data on another volume; the selected directory is recorded and must stay paired with the journal. A memory-backed volume survives a driver crash but not a machine restart, so copy it to durable storage before rebooting. Keep that journal and its matching database together. Never delete a journal to make an unknown outcome disappear or to reset the spend cap. A PID lock prevents two runners from taking the same checkout concurrently. A small evaluation-owned container retains the exact runtime image between attempts and process restarts, so an unrelated image-cache change cannot silently substitute another image during resume.

The driver has explicit crash hooks for testing process recovery. Each exits with code 77 at a real boundary. Use one case and one worker, then rerun without the variable using the same campaign:

```sh
EVALS_CRASH_AT=after_submission bun run evals -- --provider scripted --case approval-mail-approved --runs 1 --workers 1 --campaign crash-submit
bun run evals -- --provider scripted --case approval-mail-approved --runs 1 --workers 1 --campaign crash-submit
```

The other hooks are `after_first_turn`, `after_approval`, and `after_followup`. The last one can interrupt after a lost acknowledgement has already been observed; recovery must not send the effect again. Abandoned attempt containers are removed only when both the evaluation project and checkout ownership labels match. These hooks are evaluation controls, not product behaviors or identity-prompt instructions.

## Verification

After the evaluation database is initialized, the verification wrapper checks its Compose ownership and supplies it to the existing test helpers. Each helper creates and drops its own disposable database; it does not migrate or clear the evaluation dataset.

```sh
bun run evals/verify.ts test
bun run evals/verify.ts conformance
bun run evals/verify.ts conformance:memory
bun run test:plugin
bun run typecheck
bun run lint
```

`tests/boundary.test.ts` checks fresh reads across attempts without weakening write identity, fenced lifecycle waits, and typed memory lookup. `tests/adapter.test.ts` checks that only a service-owned wait can replace an engine completion. `tests/grading.test.ts` deliberately corrupts approvals, receipts, effects, and observations to verify that the grader rejects them. `tests/state.test.ts` checks durable budget accounting and checkpoint identity. The Python plugin contract tests exercise the actual registered handler signature and JSON encoding.

The harness uses the runtime and memory adapters with deterministic fixture ingestion and indexing. Background memory extraction and projection are stopped in the lab to keep fixtures independent of unrelated inference and concurrent projection work. Fixture destinations are not live-provider connector certification. Existing TODOs in the broader conformance suites remain visible in their own output.
