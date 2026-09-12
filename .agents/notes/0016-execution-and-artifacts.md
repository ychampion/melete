# 0016 - Code execution in the cell and artifact validation

Status: accepted

Melete exposes `exec.run` and `exec.python` through the broker catalog. The
plugin runs admitted commands in the cell; the broker owns admission, budget
reservation, action state and receipts. Artifact validation ties declared
checks to file content, and publication binds approval to a recorded version.

## Execution admission and settlement

The plugin registers the broker's scoped catalog in the `melete` toolset.
Hermes's built-in terminal is not part of that toolset. `HERMES_EXEC_ASK`
controls the built-in shell and does not govern these broker tools. Both
execution tools declare `write_reversible`, `execution: 'in_cell'` and
`requires_approval: false`; the registry rejects an in-cell tool that also
requires approval.

The plugin follows this sequence:

1. Post `{ intent: arguments }` to `POST /actions` with a stable job-scoped
   proposal reference. The broker validates the input, checks the attempt and
   budget, reserves the action, and returns the admitted canonical intent.
2. Call `POST /actions/{actionId}/execution/start`. The broker rechecks dispatch
   admission and grants a one-use claim. Only an `execute: true` response permits
   the plugin to spawn the command; refusal or an already-claimed action does
   not run it again.
3. Run the admitted canonical arguments in the cell with the workspace guard,
   child environment and execution limits.
4. Call `POST /actions/{actionId}/execution/settle` with the execution record,
   or an error if execution could not proceed. Settlement checks the original
   job, space and attempt identity, the record schema, and the admitted command,
   language and working directory. The exec connector checks the recorded
   paths and any stored output before producing a receipt.
5. Persist the result through `recordResult`'s transaction. It locks the job and
   action, settles the reservation and records the receipt event and any
   declared artifacts. A repeated terminal result returns the existing action.
   A matching result from an older attempt epoch can be recorded as late.

The action's canonical payload retains the immutable intent; the execution
record belongs to settlement and the receipt. `input_schema` describes model
arguments and `record_schema` describes the result. The broker also accepts the
legacy completed-record proposal shape for compatibility; the plugin uses the
intent/start/settle workflow. Registered handlers keep Hermes task and session
metadata outside the model arguments and serialize results as JSON text.

`admission_before_execution` in
`packages/runtime-hermes/tests/test_plugin.py` proves that stale-epoch and
budget refusals leave no command marker. The same two cases run through the
real broker in `apps/melete/test/integration/execution-admission.test.ts`.
`test_admission_reserves_stable_intent_then_settles` proves the plugin's proposal,
claim and settlement order and prevents a retry from executing twice.
`admission reserves once, claims once, and accepts only its matching late result`
proves the broker's reservation, claim and result-identity checks.

## Execution limits and output evidence

The default timeout is 30,000 ms and the maximum is 120,000 ms. Timeout and
cooperative cancellation terminate the process tree using Windows `taskkill /T /F`
or a POSIX process group, then reap the parent. `timeout_descendant` and
`cancellation_descendant` in
`packages/runtime-hermes/tests/test_execution_boundaries.py` require the parent
to confirm that it spawned a child and then prove the child leaves no marker.

Standard error is merged into standard output. The plugin drains the pipe
incrementally, keeps a preview of at most 16,384 bytes, and stores output beyond
that preview in a spill file. `MAX_CAPTURE_BYTES` caps retained output at
4,194,304 bytes. Further bytes are drained and counted but discarded.

| Record field | Meaning |
|---|---|
| `output_bytes`, `captured_bytes` | Number of retained bytes |
| `total_bytes` | Number of bytes read from the combined output pipe |
| `truncated` | The emitted output exceeded the display preview limit |
| `capture_limited` | Some emitted bytes were discarded at the capture limit |
| `output_digest` | SHA-256 of the retained bytes |
| `output_path` | Stored retained output, or null when it fits in the preview |

The display adds a truncation marker. When capture is limited, it labels the
file as a captured prefix and reports the emitted byte count. A spill file
contains full output only when capture was not limited. The optional capture
counters preserve compatibility with older records; missing counters do not
establish that capture was complete.

`capture_above_limit` emits 4,195,328 bytes and proves that 4,194,304 are retained
with explicit capture loss. `capture_memory_is_bounded_while_draining_both_streams`
emits 16 MiB and checks bounded plugin memory. Both are in
`packages/runtime-hermes/tests/test_execution_boundaries.py`.

The exec connector checks capture-counter consistency and, when output is
stored, verifies its size and digest. `digest_verified: true` means the stored
bytes match the record; it does not establish that discarded bytes were saved.
Without stored output, `digest_verified` is false and the digest is the cell's
claim. Stored output is declared as a text artifact with no requested semantic
checks or renderer. Its current content still participates in the artifact
digest gate. A successful execution action records a valid result; command
failure or timeout remains visible in the receipt's exit and timeout fields.

## Workspace and container boundaries

The plugin resolves its working directory and every plugin-owned scratch,
output and cleanup path against the workspace root. `realpath` resolution
rejects symlinks or junctions that escape that root. `plugin_output_path_escape`
tests redirects present before execution and created by the command. The exec
connector independently rejects recorded paths outside the job workspace and
re-hashes stored output; these checks are covered in
`apps/melete/src/connectors/exec.test.ts`.

The child receives an allow-listed environment without `MELETE_ATTEMPT_TOKEN`,
`MELETE_MODEL_KEY` or `API_SERVER_KEY`. This removes those inherited environment
values; it is not a filesystem sandbox. Arbitrary code can open paths outside
its working directory wherever operating-system permissions allow it.
`packages/runtime-hermes/tests/test_execution.py` explicitly demonstrates that
limit when execution runs outside a container.

Compose configures a non-root runtime with a read-only root filesystem,
dropped capabilities, resource limits and an internal network. Writable
locations include the work volume, Hermes home and temporary storage. The
whole work volume is mounted into the runtime, so the plugin's job path guard
does not prevent arbitrary code from reading or writing sibling job
workspaces. Per-job filesystem isolation requires a narrower mount or another
enforced boundary. Configuration checks and ordinary-process tests do not
prove container confinement or network isolation.

## Artifact declarations and validation

`files.write` accepts an optional `expect` declaration, for example:

```json
{"kind": "csv",
 "checks": [{"kind": "totals", "column": "amount", "total_label": "Total"},
            {"kind": "required_columns", "columns": ["item", "amount"]}],
 "render": true, "human": false, "critique": null}
```

Malformed declarations are refused before writing. Checks that would share a
persisted name are rejected with a typed declaration error, and the recorder
also rejects duplicate validation names. `row_count min10 followed by min1
silently removes failure` and `duplicate persisted validation names cannot
overwrite a failure` in `apps/melete/test/integration/artifacts.test.ts` prove
that a later passing check cannot erase the first failure.

Validators operate on the written bytes and produce these result classes:

| Class | Behavior |
|---|---|
| `deterministic` | Parsing and declared checks such as totals, columns, sections, row counts, JSON Schema and image dimensions; errors are recorded as failures. |
| `render` | Markdown and CSV produce HTML; text-like kinds check decodability and images check recognized headers. DOCX, XLSX, PDF and binary rendering are unavailable. A requested render is non-advisory. |
| `critique` | An optional `ArtifactCritic` hook supplies advisory results. Without a critic, the requested critique is recorded as unavailable. |
| `human` | Requested acceptance starts pending and blocks until the owner accepts that artifact version. |

Artifact rows and their validations are persisted with the successful receipt
in the broker transaction. Each validation carries the content digest it
checked. Publication receipts also persist the artifact ID, destination,
external reference and content hash; `source_job_id` retains the producing job.

## Completion uses current bytes

`completionFacts` includes `artifact_validations_passed`. The gate selects the
newest declared artifact per `(area, path)`, hashes the current file, and rejects
missing, unreadable or changed content. Every non-advisory validation must
match the artifact digest and have status `passed`. Failed, pending and
unavailable required checks block completion. Advisory results do not block.
The job transition guard routes blocked completion to `waiting_for_input` and
the runner includes the artifact failures in its question. Files without an
artifact declaration are outside this gate.

Successful file-write, file-move and execution receipts trigger inspection of
existing declared artifacts. Changed bytes are revalidated using the inherited
expectation and recorded as a new version; previous rows remain intact. A
rewrite without `expect` therefore does not erase a previous totals check.
Changes made outside those receipt paths are caught by the live digest check
at completion. Fixing the file allows completion only when current content and
its required validations pass; rewriting alone is not sufficient.

`incorrect CSV overwrite retains passing totals validation`, the execution and
raw mutation tests, and `validation digest must match the current artifact
digest` in `apps/melete/test/integration/artifacts.test.ts` prove these gates.
`non-advisory unavailable renderer permits completion` proves that an
unavailable required PDF renderer blocks completion while an explicitly
advisory result does not.

## Publication binds approval to identity

`artifact.publish` is `write_external` and requires approval bound to the
canonical payload hash. It publishes to the space artifacts directory or
sends an email attachment. Before approval, trusted preparation selects the
latest declared artifact for the job, space, area and path, and adds its exact
`artifact_id` and `content_hash` to the canonical payload. Undeclared files and
explicitly requested versions that are no longer current are refused.

Admission and dispatch load that exact ID and hash in the same job and space;
dispatch does not select a newer version by path. The service reads the file
itself and verifies its bytes against the approved digest before copying or
sending them. Replacement declarations cannot silently substitute a different
artifact under an existing approval. A proposal for a replacement version has
a different canonical payload and requires its own approval. Publication
requires a declared artifact with matching bytes; it does not independently
require every validation to pass, which is the completion gate's responsibility.

`an approval for version A publishes recorded version B` in
`apps/melete/test/integration/artifacts.test.ts` proves that dispatch refuses
replaced bytes under A's approval and that publishing B requires a new approval.
The same file checks direct file drift and undeclared-file refusal.

Email preparation also binds an active mailbox connection with `email.send`
scope from the artifact's space, including its connection ID and generation.
Admission and dispatch recheck that binding, and the mailer refuses a mismatched
space or connection before opening the transport. `cross_space_mailbox` and
the mailbox-generation tests in `apps/melete/test/integration/artifacts.test.ts`,
plus the mailer refusal in `apps/melete/src/connectors/email.test.ts`, cover
these checks. Email verification cannot confirm an unacknowledged send from
the artifact store alone and returns an undecided result.

## End-to-end coverage

`packages/runtime-hermes/scripts/e2e-exec.ts` connects a real Hermes API server
to the broker, gateway and adapter with a scripted provider. It reports the
attempt outcome and checks that a Python snippet produces the expected CSV
and leaves a successful `write_reversible` execution action without an approval.
It also reads and reports the execution receipt.
It exercises execution and ledger integration, not container confinement.
