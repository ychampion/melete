# Router latency evidence

`profile.ts` reads saved results and exported traces offline. `smoke.ts` makes bounded HTTP requests to an **already provisioned disposable target**. Neither tool installs a service, changes settings, reads an installation database, or selects a model. Keep configurations, credentials, raw evidence and generated reports outside the repository.

## Offline profiles

```sh
bun run evals/router-latency/profile.ts \
  --results ./saved/run-a --results ./saved/run-b \
  --task-map ./private/task-labels.json --out ./private/profile.json
bun run evals/router-latency/profile.ts \
  --results-root ./saved --out ./private/profile.json
bun run evals/router-latency/profile.ts \
  --trace ./private/trace.json --out ./private/timeline.json
```

Directories are searched for `results.json`; explicit JSON files and partial result arrays are also accepted. Repeated paths are deduplicated. A complete envelope has this form:

```json
{
  "build": "abc1234",
  "model": { "provider": "local", "model": "scripted" },
  "guidance": "on",
  "spent_usd": 0,
  "results": [{
    "task": "route_notice", "pass": true, "wall_s": 2.5,
    "model_actual": ["local/scripted"], "model_calls": 1,
    "tools": ["room.member_freebusy", "room.member_freebusy"],
    "tool_calls": 2, "cost_usd": 0,
    "checks": [{ "check": "calendar_verified", "ok": true }]
  }]
}
```

Legacy `label` values may contain a hexadecimal build identifier and `gon`/`goff`; explicit metadata takes precedence. Eight-digit numeric segments are ambiguous with dates and are not inferred as builds; provide explicit `build` metadata for such identifiers. Missing metadata remains `unknown`. Partial arrays retain that status. `checks` containing a failed `harness_error` distinguish harness failures from product/check failures. Null or absent durations stay missing. Every attempt and every outlier remains included.

Groups separate build, actual model (requested model when actual identity is absent), guidance and task. Each setting also has an aggregate with `task: null`. Output includes counts by outcome, timed sample size, missing values, median, nearest-rank p95, recorded call counts and cost. Run totals and per-result costs have different scopes and are reported separately. Repeated tool names are repeated invocations; arguments are unavailable, so they do not prove duplicate requests. Optional task labels are an arbitrary JSON object such as `{"route_notice":"Notice routing"}`; no task names are built in.

## Trace format, version 1

Timestamps are ISO instants with an explicit offset, or `null`. An observation's `at` is the product/provider timestamp; `observedAt` is when the observer noticed it. The latter never substitutes for a missing product timestamp. Supply observations in the producer's order, including multiple attempts or repeated stages. Correlate records with optional `jobId`, `attemptId`, `callId` and `actionId`.

```json
{
  "version": 1,
  "observations": [
    {"stage":"ingress_accepted","at":"2027-01-01T00:00:00Z","source":"product","jobId":"job_a"},
    {"stage":"attempt_started","at":null,"observedAt":"2027-01-01T00:00:01Z","source":"http","jobId":"job_a"},
    {"stage":"verification_completed","at":"2027-01-01T00:00:09Z","observedAt":"2027-01-01T00:00:10Z","source":"provider","actionId":"action_a"}
  ],
  "intervals": [
    {"kind":"model","start":"2027-01-01T00:00:01Z","end":"2027-01-01T00:00:03Z","source":"receipt","callId":"call_a"},
    {"kind":"human","start":"2027-01-01T00:00:03Z","end":"2027-01-01T00:00:08Z","source":"product"},
    {"kind":"machine","start":"2027-01-01T00:00:08Z","end":"2027-01-01T00:00:09Z","source":"product","actionId":"action_a"}
  ],
  "receipts": [{"callId":"call_a","latencyMs":2000}]
}
```

Supported stages: `ingress_accepted`, `attempt_started`, `first_model_call`, `freebusy_completed`, `question_available`, `answer_accepted`, `approval_available`, `approval_decided`, `resumed_attempt`, `write_completed`, `verification_completed`, `board_update_observed`. Missing stages are listed explicitly. Interval kinds are `model`, `machine`, `human` and `harness`. Model and active-machine totals use interval unions, so concurrent calls are not added twice. Active-machine time includes model intervals. Human waiting, harness waiting and observation lag are separate measures; they are not an additive partition when exported intervals overlap. A declared incomplete interval makes its total unknown; `knownIntervalUnionsMs` preserves the measured lower bound. Omitted intervals also mean that an exported trace may cover only part of a workflow. A receipt's `latencyMs` alone cannot locate the call on a timeline. Usage records without start/end timestamps cannot establish model elapsed time.

## HTTP probe prerequisites

The operator must supply existing empty case rooms, signed-in account references, seeded local fake mailbox/CalDAV services, and two read-only local evidence adapters described below. Provision and verify the hard spending gate separately. This probe does not create or repair spending infrastructure. A daily/monthly product limit or a post-run cost query is insufficient.

All model purposes, including background work and retries, must resolve to `nebius/nvidia/Nemotron-3.5-Super-VL`. The external gate must reject calls **before** execution once its shared campaign allowance is exhausted, across both revisions if comparing revisions. The CLI allowance is at most USD 0.25; use the smaller assigned cap. Matching proof metadata is checked here, but enforcement itself must already have been verified by the provisioner. The probe cannot independently certify an arbitrary gate implementation.

Example configuration (session environment values contain the existing complete `Cookie` header; provider authorization values contain the complete authorization header):

```json
{
  "version": 1,
  "preprovisionedDisposable": true,
  "targetId": "disposable-router",
  "revision": "abc1234",
  "campaignId": "router-comparison",
  "baseUrl": "http://127.0.0.1:8080",
  "expectedModel": "nebius/nvidia/Nemotron-3.5-Super-VL",
  "accounts": {
    "requester": {"sessionEnv":"ROUTER_REQUESTER_SESSION"},
    "helper": {"sessionEnv":"ROUTER_HELPER_SESSION"}
  },
  "gate": {
    "url":"http://127.0.0.1:8090/gate",
    "tokenEnv":"ROUTER_GATE_TOKEN",
    "verificationFile":"./private/gate-verification.json"
  },
  "evidence": {"url":"http://127.0.0.1:8090/evidence","tokenEnv":"ROUTER_EVIDENCE_TOKEN"},
  "cases": [{
    "roomId":"existing-empty-room",
    "requestedBy":"requester",
    "sourceMessage":{"id":"seeded-message","subject":"Practice pickup"},
    "candidates":[
      {"principalId":"requester","availability":"busy","calendarUrl":"http://127.0.0.1:8091/busy/"},
      {"principalId":"helper","availability":"free","calendarUrl":"http://127.0.0.1:8091/helper/","authEnv":"ROUTER_CALDAV_AUTH"}
    ],
    "event":{"summary":"Practice pickup","start":"2027-01-10T09:00:00Z","end":"2027-01-10T10:00:00Z"},
    "answer":"Yes, I can handle the pickup."
  }],
  "timeoutMs":120000,
  "requestTimeoutMs":3000,
  "pollMs":250,
  "maxRequests":1000
}
```

`GET gate.url`, authenticated with `Bearer $ROUTER_GATE_TOKEN`, returns:

```json
{
  "campaignId":"router-comparison","targetId":"disposable-router","revision":"abc1234","gateId":"verified-gate",
  "hardCapUsd":0.2,"spentUsd":0,"heldUsd":0,
  "preCallEnforced":true,"includesBackground":true,"includesRetries":true,"allModelPurposes":true,
  "resolvedModels":{"agent":"nebius/nvidia/Nemotron-3.5-Super-VL","background":"nebius/nvidia/Nemotron-3.5-Super-VL"},
  "expiresAt":"2027-01-11T00:00:00Z",
  "proofSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`gate.verificationFile` is a private JSON object containing matching `campaignId`, `targetId`, `revision`, `gateId`, `proofSha256`, plus `method: "pre-call rejection verified"` and `verifiedAt` (ISO timestamp). It references independently retained rejection evidence. Never fabricate that evidence to enable a run.

`GET evidence.url` exports campaign evidence for the configured target/revision:

- `campaignId`, `targetId`, `revision`, `quiescent`: the latter is true only when all foreground, queued, retry and background work has settled.
- `calls`: every campaign model attempt, including failed/retried/background calls, with unique `id`, `purpose`, `modelActual`, `costUsd`, `status`, nullable `jobId`, `latencyMs`, `startedAt`, `endedAt`. Unknown cost prevents validation; missing timing stays null.
- `sourceReads`: actual mailbox reads, each with `messageId`, `jobId`, nullable `at`. Seed presence alone is insufficient.
- `tools`: invocations with `jobId`, `name`, nullable `at`, and, for `room.member_freebusy`, `memberId` and `complete`.
- `actions`: calendar actions with `id`, `approvalId`, `payloadHash`, `memberId`, `kind: "room.add_to_member_calendar"`, `event` (`summary`, `start`, `end`), `status`, nullable `verifiedAt`.
- `calendarOperations`: fake provider requests with `method` (`PUT` or `GET`), `memberId`, `uid`, HTTP `status`, nullable `at`. Export product requests separately from observer requests.
- Optional `observations`: trace stages with `stage`, nullable `at`, `source`, optional correlation IDs. Do not invent timestamps absent from retained records.

The probe posts one neutral request, observes the actual available helper's board question, answers as that member, refuses an approval through another member's account, then approves as the calendar owner. It requires the exact proposed event, relevant complete free/busy, one canonical provider write, product read-back, a verified action, and the completed board record. It independently GETs the fake CalDAV resource by action UID and checks the approved payload binding and exact UTC start/end. An action's successful status alone cannot pass. Additional human input stops the workflow; the probe sends no corrective nudges.

```sh
# Execute only after the isolated target and shared hard cap have been supplied.
bun run evals/router-latency/smoke.ts \
  --config ./private/smoke.json --budget-usd 0.20 --limit 1 \
  --out ./private/smoke-result.json
```

At most two complete workflows total, including both revisions, are allowed for a comparison. With one revision, run at most one workflow and report no live comparison. Each invocation must remain within the same externally enforced allowance. Missing prerequisites mean zero calls. A two-case comparison cannot support a population median claim.

The probe bounds wall time (maximum 180 seconds), each entire HTTP response (maximum 5 seconds and 4 MiB), request count (maximum 2000), and configured workflows (maximum two). It never retries a mutation. On failure it attempts to stop at most two known requests per attempted workflow, each with the request timeout; these bounded cleanup requests are counted separately. The hard gate continues to cover any unreachable background work. Reports keep HTTP time, observer polling and automated human-response time separate, preserve actual model/cost receipts, and leave missing product timestamps null. Probe wall time includes observation lag and cannot establish physical inbox-arrival latency.

## Verification and scope

```sh
bun test evals/router-latency --timeout=30000
# Supply a disposable Postgres DATABASE_URL for product integration tests.
bun test apps/melete/src/jobs/queue-waker.test.ts \
  apps/melete/src/jobs/quiet.test.ts \
  apps/melete/test/integration/router-wake-latency.test.ts --timeout=60000 --max-concurrency=2
```

The synchronized queue regression first observes an empty due scan and a completed empty worker fetch, then inserts a wake due 250 ms later. It checks no early pickup (2 ms timestamp measurement tolerance) and pickup less than one second after due. Deterministic interleavings cover hints during scans, subscription startup, reconnect, fallback, coalescing and shutdown. The five-second fallback still handles lost hints and jobs inserted outside the application enqueue helper; native queue retries are not all covered by the hint.

The router integration uses the real app, runner, broker and calendar connector with a scripted runtime and local CalDAV. Its counting calendar fixture explicitly performs provider verification before returning the verified receipt. It covers parked approval, approval while the turn is finishing, declined consent, wrong-person answers/approvals, one write, one read-back, board visibility and the local date across a DST transition. Approval commit-to-resume is bracketed by HTTP request start/response; ordinary immediate approval already uses commit notifications and is separate from the scheduled-wake fix. Existing stopped-work, revoked-share and changing-conflict tests remain required.

The scheduling hint improves application-enqueued near-future attempt wakes discovered between periodic scans. It does not establish a model latency improvement or a faster household median. Mail polling, model calls, human waiting and HTTP observer polling require separate evidence; none are shortened by this change. Tool/skill guidance may reduce unnecessary reads, but only a real model run can establish fewer invocations.
