# Broker/service production review — September 12, 2026

## Scope and conclusion

Reviewed the integration commit
`9484023cabd32b786cb4d336dec818f441cd0cc1`. This patch repairs three related
broker/service contract failures. It does not declare the application ready for
production, replace the runtime, change the UI, or merge the active feature lanes.

The existing tests passed against real PostgreSQL before changes: **901 passed,
14 TODO, zero failed**. Seven new checks then failed against the unchanged source.
The final regression suite contains eleven tests; the full suite now reports
**912 passed, 14 TODO, zero failed**. The tests use actual database transactions,
pg-boss records, runner claims, and a durable test destination, not mocked database
or queue responses.

No application was deployed, no live inference request was made, and no real
external message was sent.

## Fixed findings

### 1. P1: Broker events could be skipped by a persisted-event cursor

**Locations:** Broker records and service transactions.

The service serializes event-producing transactions before taking job row locks.
The broker took only a job row lock. Two transactions writing different jobs
could therefore allocate event sequence numbers in one order and commit in the
opposite order. A client observing the larger committed sequence could advance
past a broker event that was still uncommitted. Polling would not repair this:
the replay query asks for sequence numbers greater than the client's cursor.

Broker inserts also omitted the persisted epoch and commit notification. A
per-job reconnect from one of these events could produce an `unknown_epoch`
reset instead of normal replay; live subscribers depended on fallback polling.

**Change:** Export the existing service advisory-lock identity and acquire it in
broker `lockJob`, before taking the job row lock. Its parameter now requires a
`TransactionSql`, so an ordinary autocommit client is not a valid caller. Broker
events persist the current job epoch and issue `pg_notify` only when the deduped
insert creates a row. PostgreSQL delivers that notification on commit, not on
rollback. The network operation remains outside the transaction.

**Evidence:** A test pauses a broker transaction after its insert, then starts a
service writer for another job. Before the patch, the later writer committed
while the first event was invisible. After the patch, PostgreSQL reports the
contender waiting on the advisory lock; it cannot commit first. Other checks
verify the epoch-based reconnect, one notification per new event, no notification
for duplicate delivery, and release of the lock with no event or notification
on rollback.

This closes the **broker/service** ordering hole. It is not a claim that every
other subsystem's event writer follows the protocol; see the memory follow-up
below. The PostgreSQL rules behind the test are documented in
[sequence functions](https://www.postgresql.org/docs/16/functions-sequence.html)
and [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).

### 2. P1: Approval and reconciliation wakes did not satisfy the runner contract

**Location:** Broker service, `wake()`.

Broker wake messages lacked `expected_version`, although `AttemptRunner.claim`
requires it to match the persisted `state_version`. Every such wake failed that
check. An otherwise approved responsibility depended on the periodic recovery
scan to create another, valid wake. The same path always used the interactive
queue, disregarding the persisted background or quiet scheduling class.

The old singleton key identified only the job and epoch. It was not an identity
for successive state transitions within that epoch.

**Change:** Read the epoch, state version, scheduling class, and due time back
from the job update in the same transaction. Build an `AttemptWake` and send it
to `attemptQueue(scheduling_class)`, using the service queue's start-time, retry,
and expiry settings. Remove the obsolete epoch-only singleton key. The durable
state transition and existing idempotent decision/result checks remain the
source of deduplication.

**Evidence:** Tests start with a nonzero state version and check all three
scheduling classes. The exact stored pg-boss message starts a real runner claim
without calling recovery; a second claim of the same message is rejected. The
resumed attempt reuses the approved action and delivers once.

Two further tests take an accepted send through an unknown outcome, then resolve
it by verification or a deferred receipt. The fresh recovery wake is claimable;
the prior same-epoch approval wake is stale. There is one destination ledger row
and one dispatch event. A database trigger deliberately fails a real queue
insert: the approval, action status, job version, and decision event all roll
back. Retrying the decision after removing the failure creates one wake.

### 3. P2: Completed or denied actions still reported that approval was required

**Location:** Broker service, `proposalView()`.

The approval query selected `id` and `origin_warnings`, but its result was later
read as though it also included `decision`. Consequently, an action with an
approval record continued to return `requires_approval: true` after successful
execution or denial. This misrepresented the durable disposition to the runtime
and could make a re-proposal look like another question for the owner.

**Change:** Select `decision` explicitly and report approval as required only
when the action is `needs_approval` and the decision is pending or no matching
approval row exists. Keep the approval
ID, origin warnings, action identity, and durable result in the response.

**Evidence:** Re-proposing a pending action still reports that it needs approval.
Re-proposing a succeeded, denied, or unknown action does not ask for approval
again. Denied actions stay denied; uncertain sends are not re-executed. A unit
regression confirms that a pending action still requires approval when the
lookup returns no matching row.

## Test implementation and execution

The new broker/service contract regression suite uses the full
service migrations rather than the broker-only frozen schema. The existing
broker fixture also applies the committed migration journal, so its event and
wake tests exercise production columns without maintaining a filename list.
No production migration was introduced or edited.

The initial database fixture could not start. Those startup errors were not
counted as application failures or skipped to obtain a green result. Fixtures
then used a separate PostgreSQL instance and created and dropped their own
disposable databases. No existing application database was used.

| Check | Result |
| --- | --- |
| Existing tracked tests on the base commit | 901 passed, 14 TODO, 0 failed |
| Initial seven new checks against unchanged source | 0 passed, 7 failed |
| Final broker/service regression suite | 11 passed, 0 failed; five additional consecutive runs also passed |
| Full test suite, with an isolated database | 912 passed, 14 TODO, 0 failed; 926 tests across 74 files |
| Type checking | Passed |
| Lint | Passed |
| Plugin tests | 20 passed |
| API specification generation | Passed; generated document unchanged |
| Client generation | Passed; generated client types unchanged |
| Deployment configuration checks | All 12 configuration assertions passed |

The 14 TODO cases are unchanged. They cover six live container-boundary checks,
four knowledge-retraction conformance cases, and four two-provider conformance
cases. Passing the static deployment check does not prove the running container's
network isolation. This review did not run a complete deployed stack, browser
acceptance tests, live-provider comparisons, or a production load benchmark.

## Compatibility, rollout, and self-review

- No public schema, generated client, configuration variable, or database
  migration changed. The fixes restore contracts that were already present.
- Old broker events with null epochs are not rewritten. An old cursor may still
  require the existing reset path. Already-queued malformed wake hints are not
  rewritten; the durable recovery mechanism still handles them.
- Commit ordering requires participating writers to run the updated code.
  A mixed deployment with an old broker can still bypass the guard.
- Every broker job lock acquires the same global advisory lock. This serializes
  read-only broker operations and per-request gateway budget accounting against
  all service transactions. Connector I/O remains outside the lock; throughput
  under production load is unmeasured.
- `lockJob` must receive the transaction client from `sql.begin`. Taking it on a
  pool/autocommit client would release the guard before the later write. The
  narrowed type makes that misuse visible during integration.
- Reviewed the final changes for preserved approval/hash binding, action
  identity, cancellation and uncertain-outcome behavior. This is the patch
  author's self-review, not a separate person's approval.

## Remaining review items, not fixed by this patch

These are inspection findings, not additional regression-proven fixes in this PR.
They should not be read as claims of an exhaustive security audit.

**Memory event integration.** Memory invalidation directly
inserts into the shared event table without the epoch/notification behavior.
Its callers lock memory state and jobs on a different path. That path needs a
separate lock-order and replay review, including a concurrency reproducer.
Adding a late advisory lock while already holding memory or job locks would not
be a safe automatic fix. Do not interpret this PR as whole-system replay proof.

**Lease-expiry enforcement.** Broker `checkAttempt` checks the job epoch,
revision, capability expiry and attempt outcome, but does not read the attempt's
lease expiry/status. The service runner has more detailed lease checks. The
expired-lease interval before recovery fences an attempt should be exercised
across broker and gateway admission in a dedicated test and patch.

**Active integration lanes.** PRs #11, #12 and #14 touch related broker files.
Their reviewed diffs did not already fix these wake, proposal-view or event
problems. In particular, the execution lane contains a `lockJob(this.sql, ...)`
call: it must be converted to a transaction or to an explicitly non-locking
read when rebased onto this patch. Re-run type checking and integration tests
after combining those lanes; a green run on this base does not verify that merge.
