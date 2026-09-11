## Assumptions

- SHA 0ddc716 is the authorized starting tip; command `git -C C:/Users/gamin/melete-oss-w10a log -5 --oneline` shows the prior agent's committed changes above reviewed SHA 5f307e0; preserve them.
- Command `bun install` passed with no changes; command `git -C C:/Users/gamin/melete-oss-w10a status --short` showed only the authorized draft test_execution_boundaries.py.
- Test draft test_execution_boundaries.py supplies starting reproductions for findings 3, 4 and 8; retain and strengthen these in their respective commits.
- Command `gh pr view 11` will identify the existing PR; use PR #11 instead of creating a duplicate PR for the same branch.
- Log start 2026-09-11 20:44 UTC; campaign deadline 2026-09-12 01:44 UTC; tests use the scripted provider and at most two concurrent workers.

## Finding 2

- Test admission_before_execution: red at SHA 0ddc716 for stale_epoch and budget_exceeded; log excerpt: command ran before admission.
- Command bun test apps/melete/test/integration/execution-admission.test.ts apps/melete/src/broker/http.test.ts apps/melete/src/connectors/exec.test.ts --max-concurrency=2: 21 passed in 17.90s against embedded Postgres 17.
- Command bun run test:plugin with later draft boundary tests deselected: 34 passed in 14.67s; test admission_reserves_stable_intent_then_settles proves one-use execution.
- Command bun run openapi and command bun run client:generate passed; command bun run typecheck passed before final formatting.
- Test execution-admission.test.ts initially had a syntax error in an optional SQL tag; corrected to the non-null fixture SQL handle and rerun green.

## Finding 8

- SHA 73c2b1f: finding 2 committed and pushed to lane/w10a-execution.
- Test plugin_output_path_escape: red before the fix in both pre-existing and command-created Windows junction cases; log excerpt DID NOT RAISE ExecRefused.
- Test test_execution_boundaries.py retained from the prior draft; findings 3 and 4 draft tests are held for their later commits to keep each commit focused.
- Command python -m pytest packages/runtime-hermes/tests/test_execution_boundaries.py packages/runtime-hermes/tests/test_execution.py -q: 14 passed in 2.57s; outside directory stayed empty; all plugin scratch/output creation and cleanup use resolve_in_workspace and realpath.

## Finding 3

- SHA af73539: finding 8 committed and pushed.
- Test timeout_descendant: red with log excerpt a descendant outlived its command; prior draft reproduction preserved with shorter waits.
- Test cancellation_descendant: red because cancellation was unsupported; green uses the same process-tree shutdown as timeout.
- Command python -m pytest packages/runtime-hermes/tests/test_execution_boundaries.py packages/runtime-hermes/tests/test_execution.py -q: tree termination uses Windows taskkill /T /F and POSIX killpg in a new session; parent is reaped.
- Command python -m pytest packages/runtime-hermes/tests/test_execution_boundaries.py packages/runtime-hermes/tests/test_execution.py -q: 16 passed in 7.76s.

## Finding 4

- SHA 282e265: finding 3 committed and pushed.
- Test capture_above_limit: red with missing captured_bytes and capture_limited; probe emits 4,195,328 bytes.
- Test capture_above_limit: green retains 4,194,304 bytes, records total_bytes 4,195,328 and capture_limited true, and labels the stored prefix without claiming full output.
- Test capture_memory_is_bounded_while_draining_both_streams: 16 MiB emitted with plugin peak allocation below 2 MB.
- Command bun run test:plugin: 42 passed in 23.34s.
- Command bun test apps/melete/src/connectors/exec.test.ts apps/melete/test/integration/execution-admission.test.ts --max-concurrency=2: 16 passed; command bun run typecheck passed.
- Command bun run openapi and command bun run client:generate passed; new optional capture counters are recorded in the contract additions note.

## Finding 1

- SHA 8afebf5: finding 4 committed and pushed.
- Test cross_space_mailbox: red against configuredConnectors with two spaces; space B published using space A transport (Expected calls 0; Received 1).
- Test cross_space_mailbox: asMailer refusal was red (Expected sends 0; Received 1); now rejects the wrong space before opening the transport.
- Test cross_space_mailbox: mailbox generation is checked at admission and at dispatch; stale generation rejects without sending.
- Command bun test apps/melete/test/integration/artifacts.test.ts apps/melete/src/connectors/email.test.ts --max-concurrency=2: 20 passed in 24.14s; command bun run typecheck passed.

## Finding 5

- SHA 4e1af68: finding 1 committed and pushed.
- Test an approval for version A publishes recorded version B: red (Expected failed; Received succeeded), then green after binding artifact_id and content_hash at proposal.
- Test an approval for version A publishes recorded version B: dispatch of A rejects replaced bytes; a fresh B proposal has a new payload hash and needs approval.
- Command bun test apps/melete/test/integration/artifacts.test.ts --max-concurrency=2: 14 passed in 36.47s.
- Command bun run typecheck, command bun run openapi and command bun run client:generate passed.
- Test raw file drift now rejects during admission as payload_invalid; an undeclared file rejects before approval. Frozen note 0016's approved-content claim is corrected by the immutable payload binding.

## Finding 6

- SHA fca7633: finding 5 committed and pushed.
- Test incorrect CSV overwrite retains passing totals validation: red (Expected false; Received true), then green with inherited totals checks reporting 91.5.
- Tests execution mutation invalidates historical totals validation and raw mutation invalidates historical totals validation: both red, then green; historical passing rows remain intact.
- Test validation digest must match the current artifact digest: completion refuses a digest-mismatched validation row.
- Command bun run --cwd apps/melete db:generate --name artifact_content_digest produced migration 0016 after 0015, adding only validated_content_hash to artifact_validation.
- Command bun test apps/melete/src/artifact/validate.test.ts apps/melete/src/connectors/files-expect.test.ts apps/melete/src/connectors/exec.test.ts apps/melete/test/integration/artifacts.test.ts --max-concurrency=2: 45 passed in 14.60s.
- Command bun run typecheck, command bun run openapi and command bun run client:generate passed; artifact roots reach both receipt revalidation and the completion gate.

## Finding 7

- SHA 31d575d: finding 6 committed and pushed.
- Test row_count min10 followed by min1 silently removes failure: red because malformed declarations reached dispatch without a typed refusal; green rejects as payload_invalid before adding an action and preserves the original failed row_count.
- Test row_count min10 followed by min1 is a typed declaration error: red with generic Error, green with ZodError for direct validator callers.
- Test duplicate persisted validation names cannot overwrite a failure: red with silent upsert, green with payload_invalid before an artifact is inserted.
- Command bun test apps/melete/src/artifact/validate.test.ts apps/melete/src/connectors/files-expect.test.ts apps/melete/test/integration/artifacts.test.ts packages/contracts/src/artifacts.test.ts --max-concurrency=2: 37 passed in 12.22s; subsequent duplicate persistence checks: 2 passed in 18.06s.
- Command bun run typecheck, command bun run openapi and command bun run client:generate passed.

## Assumptions

- Command Get-Item .hermes-src,.hermes-venv identified junctions into W3; the real-server e2e will use an isolated pinned engine and environment via MELETE_HERMES_SRC and MELETE_HERMES_PYTHON, preserving other worktrees.

## Finding 9

- SHA 74a5ab4: finding 7 committed and pushed.
- Test non-advisory unavailable renderer permits completion: red (Expected false; Received true) because the earlier partial fix marked requested unavailable rendering advisory.
- Test non-advisory unavailable renderer permits completion: green through completionFacts; PDF rendering stays unavailable and non-advisory, while explicitly advisory results remain non-blocking.
- Command bun test apps/melete/src/artifact/validate.test.ts packages/contracts/src/artifacts.test.ts apps/melete/test/integration/artifacts.test.ts --max-concurrency=2: 35 passed in 15.89s.
- Command bun run typecheck, command bun run openapi and command bun run client:generate passed.
