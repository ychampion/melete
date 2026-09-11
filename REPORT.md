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
