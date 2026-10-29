# Mail safety evaluation

This fictional, frozen corpus evaluates Melete's existing scam-check skill, photo and mail
paths, and room board delivery. It does not authenticate real issuers. All people,
organizations, accounts and transactions are invented; program names identify document
formats. Ground truth describes the invented provenance. No separate classifier or model
grader is used. The three existing verdicts and an actual board task are separate outcomes.

The corpus has 60 independently authored scenarios: 30 scam and 30 genuine-format notices,
40 photos (20 per label) and 20 emails (10 per label). Each of twelve strata has five
scenarios and both formats. The government stratum includes Medicare and Social Security;
the mixed communications strata include both delivery and toll notices. Genuine notices
include bills, due dates, amounts and actions. None of the photos is counted again as a
degraded copy. IDs are opaque and stable.

`corpus.json` separates the neutral envelope/body from `scorer` metadata: label, category,
fictional provenance, rationale, expected helper role, visibility and sensitive canaries.
Only the envelope/body enters rendering or RFC822 generation. Only photo bytes and a neutral
request enter photo submissions. No OCR answer, category, rationale or label is submitted.
Email subjects and attachment filenames carry only neutral notice IDs. Every request says
the material is fictional, identically for both labels.

## Offline reproduction

Use Bun >=1.3 and the workspace's locked dependencies. Use an output directory outside the
checkout for all generated files, configuration, sessions, journals, runs and responses.
`OUTPUT_ROOT` below is a new private directory chosen by the operator.

```sh
bun install --frozen-lockfile
bun test evals/mail-safety --timeout=30000
bun run evals/mail-safety/run.ts generate --seed 20261029 --out "$OUTPUT_ROOT/corpus"
bun run evals/mail-safety/run.ts dry-run --corpus "$OUTPUT_ROOT/corpus"
bun run evals/mail-safety/run.ts regrade --in "$OUTPUT_ROOT/run/run.json" --out "$OUTPUT_ROOT/regraded"
```

Generate refuses an existing manifest; regrade refuses an existing report. Dry-run verifies
all 60 identities, scorer metadata and file hashes. Dry-run and regrade make no network or
provider calls. Regrade retains the recorded raw answers and includes unfinished/failed
attempts. It never requests another answer.

The renderer is Playwright 1.63.0 with its already installed Chromium, fixed date 2026-10-29,
seed 20261029 and local DejaVu Sans. Install the locked browser and system font before an
offline generation session. No image service, network assets or downloaded fonts are used;
all page requests are blocked. Photos use restrained rotation, a paper shadow and lighting
variation at 1180 by 1550 pixels. The manifest records Chromium version, font SHA-256,
canonical corpus SHA-256, seed and every output SHA-256. Reproduce on the same renderer/font
build; cross-platform byte identity is not assumed. PNGs and RFC822 files remain outside git.

## Disposable target provisioning

The runner never provisions, resets or deletes an installation. Supply an isolated install,
owner, consenting helper, outsider and one EMPTY dedicated room per selected case. Existing
API examples use authenticated session cookies supplied privately via environment references.
Do not paste secrets in configuration or commands. The integration fixture
`apps/melete/test/integration/mail-safety-http.test.ts` shows setup, account creation,
room membership, summaries policy, upload, normal room submission, broker actions and board
reads against `createApp`, `testDatabase()` and `StubRuntimeAdapter`.

On that disposable install only:

1. `POST /setup` with `{email,password}` creates the owner. `POST /principals` as owner creates
   helper and outsider with `{email,password}`. `POST /login` creates their sessions; `GET /me`
   provides each principal ID. `PATCH /me` with `{display_name}` supplies a neutral helper name.
2. `POST /rooms` as owner with `{name:"Notice review"}` creates a fresh room. Add only the
   consenting helper using `POST /rooms/:id/members` with `{principal_id}`. Copy the exact
   helper label (including handle) from `GET /rooms/:id`.
3. `PUT /spaces/:id/summaries-only` as owner with `{on:true}` turns on summaries-only policy.
   Keep `GET /rooms/:id/policy` at `agent_turns:"asked"`. The runner checks both sessions,
   owner role, eligible helper, consent, outsider exclusion, empty owner/helper boards,
   empty threads and empty room memory. Memory must be available for that check. It refuses
   a dirty namespace and never removes its contents. A vision-capable room model is required.
4. For an email case, connect an explicitly disposable **loopback** IMAP mailbox through the
   installation's existing mail connection setup. Give it its own empty inbox folder and
   expose only `email.search`/`email.read` to this room. `GET /rooms/:id/connections` must show
   the configured IMAP connection active and shared with the room. Its service-side inbox
   folder must match the case's folder. No SMTP endpoint is used by this evaluator.
   `appendEmail` checks the folder, APPENDs the RFC822 bytes, keeps the UID, and reconciles an
   existing matching Message-ID without adding another. Other mail makes the case fail.
5. Provide a scoped, continuously refreshed read-only ledger export and an independently
   verified external hard guard as described below. Configure exactly the selected cases.

Photo submissions use `POST /rooms/:id/attachments`, then `POST /rooms/:id/threads` with its
attachment ID and stable submission ID. The gateway performs the existing image conversion.
Email submissions ask the room agent to find the neutral subject with `email.search` and
read it with `email.read`. Pasted email text never qualifies as an email-pipeline result.
The evaluator never creates a board warning. It follows the thread event endpoint with a
cursor and reconnects; JSON event polling is a bounded fallback recorded in each observation.
It reads final boards as owner/helper and requires outsider denial for thread, board and
events. A timeout may preserve a classification, but cannot count as completed delivery.
No cross-room post, calendar operation, membership widening or permission change is performed.

## Paid execution remains disabled without external enforcement

There is no default URL, session, mailbox, provider key or hard guard. No live validation is
implied by scripted tests. Run is capped at two attempted items across this campaign,
including failures; its dollar cap must be positive and at most $0.25. These client checks
are additional checks, not monetary enforcement. The app's existing total-before-hold
spending check alone is insufficient to establish an absolute campaign cap.

The target operator supplies a trusted adapter implementing `HardGuard` in `run.ts`, exporting
`openGuard(opaqueReference)`. Configuration pins the adapter SHA-256. Its `verify` must verify
actual installation enforcement with an auditable proof ID, target/campaign scope, exact
campaign dollar cap, global two-item ceiling and coverage of foreground, background, retry
and secondary calls. The adapter must reserve durably before any model-capable submission,
idempotently by submission ID, and reconcile actual settlement and lost submission replies.
It must enforce its global campaign ceiling across output directories and process restarts.
The adapter is trusted operator code: a claimed boolean, a fabricated proof ID or an arbitrary
module hash does not establish enforcement. The operator must review the implementation and
its deployment proof before supplying it. This evaluation supplies no permissive adapter or
new budget proxy. Absent a verifiable adapter, run stops before app or provider requests.
Guard operations themselves must be bounded and must never invoke a model.

A configuration has this shape (replace placeholders privately; session and password refs
are environment variable names, not their values):

```json
{
  "version": 1,
  "disposable": true,
  "targetId": "isolated-mail-target",
  "campaignId": "mail-smoke-01",
  "baseUrl": "http://127.0.0.1:8080",
  "corpusHash": "<hash printed by generate>",
  "corpusDir": "<private corpus directory>",
  "requireNemotron": true,
  "accounts": {
    "owner": {"id": "<owner ID>", "sessionRef": "MAIL_OWNER_SESSION"},
    "helper": {"id": "<helper ID>", "sessionRef": "MAIL_HELPER_SESSION"},
    "outsider": {"id": "<outsider ID>", "sessionRef": "MAIL_OUTSIDER_SESSION"}
  },
  "cases": {
    "<opaque case ID>": {
      "roomId": "<empty dedicated room ID>",
      "helperLabel": "Owen Lake <room handle>",
      "helperConsent": true,
      "ledgerFile": "<private scoped ledger export>",
      "mailConnectionId": "<isolated IMAP connection ID; email only>",
      "mailbox": {
        "host": "127.0.0.1", "port": 1143, "username": "<disposable user>",
        "passwordRef": "MAIL_IMAP_PASSWORD", "folder": "<dedicated empty inbox>"
      }
    }
  },
  "hardGuard": {
    "module": "<reviewed private operator adapter>",
    "sha256": "<adapter SHA-256>",
    "reference": "<opaque enforcement configuration reference>"
  }
}
```

Omit `mailbox` and `mailConnectionId` for photo cases. Configure a maximum of the selected
smoke items. With the supplied guard verified, the explicit command is:

```sh
bun run evals/mail-safety/run.ts run --config "$OUTPUT_ROOT/target.json" \
  --limit 2 --budget-usd 0.20 --out "$OUTPUT_ROOT/run"
bun run evals/mail-safety/run.ts regrade --in "$OUTPUT_ROOT/run/run.json" \
  --out "$OUTPUT_ROOT/regraded"
```

Use the supplied allowance if smaller. Never use this entrypoint for a paid full-corpus run.
Repeat the identical command to resume the same journal. An unfinished attempt reconciles
its original submission; it never reposts after an uncertain reply. Unknown submissions,
missing identity/costs, pending settlement, dirty rooms, uncertain enforcement, exceeded cap
or privacy failure stop the run. Preserve the journal and target together; never remove a
journal or change campaign identity to retry a failure. An exclusive PID lock fences local
runners; only a lock whose process has ended may be retired automatically.

## Usage export and evidence

The ledger export is an operator-created private JSON snapshot, version 1, with `targetId`,
`roomId`, `submissionId`, `jobIds`, `pending`, `settled`, and `usage`. It must include **all** jobs
in the dedicated case space, recursively spawned jobs, and associated background/service
calls, not just the foreground job. `pending:0` and `settled:true` must mean all jobs and
provider holds have reached bounded settlement, confirmed by the external guard. A quiet
foreground thread alone is insufficient. The runner waits at most 30 seconds for settlement.

Use a read-only connection to the supplied isolated database, with an explicit room ID.
An exporter can start with these existing tables; no migration is required:

```sql
SELECT id, experience_parent_id, state FROM job WHERE space_id = :case_room_id;
SELECT id, job_id, purpose, provider, model, model_actual, status,
       usage_estimated, input_tokens, cached_input_tokens, output_tokens,
       cost_usd, class
FROM model_usage WHERE space_id = :case_room_id ORDER BY created_at, id;
```

Follow child links into the same isolated case scope; independently account for associated
background rows lacking a job/space through the target's guard. If the exporter cannot
prove complete attribution, keep `settled:false`. Never scan an unrelated installation.
Map usage columns to `Usage` in `evidence.ts`: `requestedModel`, `actualModel`, `usageEstimated`,
`inputTokens`, `cachedTokens`, `outputTokens`, `costUsd`, `usageClass`, and the original row/job
IDs. Deduplicate row IDs; conflicting duplicates fail. Unallocated background cost is shown
separately. Costs are **app-ledger estimates**, not provider invoices. Missing costs are
unknown, not zero. All attempted items, including failed submissions, stay in cost-per-attempt
denominators; cost per safe warning is separate. Nemotron designation requires actual identity
`nebius/nvidia/Nemotron-3.5-Super-VL`; missing/wrong identities stop that validation.

`journal.sqlite` checkpoints attempts, reservation references, submission/thread/job IDs,
event cursor and evidence. `run.json` retains raw answers, privacy surfaces, action/receipt IDs,
boards, usage and unfinished attempts. Sessions and credentials are never recorded. All HTTP
redirects and cross-origin requests are refused. Runtime errors are not printed because
external adapter errors can include credentials.

## Deterministic grading

The first nonblank line must be a standalone `Verdict:` line with exactly `likely scam`,
`looks genuine` or `can't tell` (case, curly apostrophe and trailing punctuation normalize).
Quoted, fenced, introduced quotations, negations, unknown wording and multiple verdict lines
are invalid. `not a scam` and `cannot tell if this is a scam` are not scam predictions.
Unrecognized output is never silently treated as a negative.

The report includes a 2-by-4 actual-label/prediction table, classifiable TP/FP/FN/TN, coverage,
full-denominator scam recall and genuine false-alarm rate. Abstentions and errors remain in
headline denominators. Every delivery component is reported overall, by category and format:
correct verdict, actual new open task, helper visibility, correct assignee, required visibility,
safe note, no known canary leak, outsider denial, an action/receipt, and completed execution.
A correct verdict alone cannot pass delivery. Board titles/details and helper answers,
cards, receipts and events are checked for the corpus's known source canaries. This measures
these canaries; it does not claim image redaction or recognition of every private detail.

**Scorer fixture — not a measured product/model result:**

| Actual | Likely scam | Looks genuine | Abstain | Error/invalid |
|---|---:|---:|---:|---:|
| Scam | 1 | 1 | 0 | 0 |
| Genuine | 1 | 1 | 0 | 0 |

This hand-scored four-case fixture yields TP=1, FP=1, FN=1, TN=1, coverage 100%,
scam recall 50% and genuine false-alarm rate 50%. It tests scorer arithmetic only.

## Integration checks

Point `DATABASE_URL` only at your own disposable Postgres 17. The existing test helper creates
and drops databases with exact generated IDs. Root cannot use embedded Postgres.

```sh
bun run doctor
bun test apps/melete/test/integration/mail-safety-http.test.ts \
  apps/melete/test/integration/room-board.test.ts \
  apps/melete/test/integration/summaries-guard.test.ts \
  apps/melete/test/integration/summaries-only.test.ts \
  apps/melete/src/attachments/room-posting.test.ts \
  packages/skills/src/skills.test.ts --timeout=60000 --max-concurrency=2
bun run typecheck
bun run lint
bun run test
bun run test:plugin
git diff --check
```

The HTTP integration uses actual routes, attachments/gateway conversion, broker, board and
summaries guard with a scripted runtime and parsed RFC822 through `EmailConnector`. Its mail
transport is an in-process fixture, not certification of a live IMAP server. Scripted replies
are harness/product-boundary evidence, not measured classification or real Nemotron evidence.
The runner's local IMAP APPEND path requires the separately supplied disposable mailbox.
