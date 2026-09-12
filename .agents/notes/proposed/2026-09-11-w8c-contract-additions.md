# Proposed - Contract additions for attention as a contract

Status: **accepted 2026-09-12**, as landed with the lane. One thing changed
afterwards: `ownerQuestion` now also carries `source`, `space_id` and `key`,
and its `job_id`, `job_title` and `attempt_id` are nullable, because the one
queue holds disputed memory keys beside the jobs' questions. The migration
became `0011_attention_contract`.
Date: 2026-09-11
Raised by: the attention lane, implementing E7

Everything here is additive and lives in `packages/contracts/src/responsibility.ts`,
plus two new paths in `packages/contracts/src/openapi.ts`. Nothing in
`job-state.ts`, `events.ts`, `entities.ts`, `api.ts`, `broker.ts` or `runtime.ts`
changed. `bun run openapi` and `bun run client:generate` were rerun, and a
dereferenced comparison of `openapi.json` against `origin/integration` removes no
path and no schema.

## New primitives

| Name | Shape | Why |
|---|---|---|
| `attentionHandle` | `"<kind>:<id>"` where kind is one of `event`, `claim`, `action`, `approval`, `attempt`, `obligation`, `submission`, `question`, `trigger`, `operation`, `job` | A reason has to be a record, not prose. The grammar is checked so a handle can be followed back. |
| `ifIgnored` | non-empty string, at most 2000 characters | The consequence of nobody acting, in plain language, carrying a date when one exists. |
| `questionSpec` | `{ text, because[], if_ignored, blocks_external_effect, deadline_at }` | One thing the service wants answered. The last two fields are what the ranking rule reads, and both default. |
| `deferredQuestion` | `questionSpec` plus `created_at` | What "oldest" is measured on, so a held question keeps its age. |
| `ownerQuestion` | `deferredQuestion` plus `id`, `job_id`, `job_title`, `attempt_id`, `state`, `answer`, `answered_at` | One entry in the owner's queue. |
| `questionState` | `open` / `answered` / `withdrawn` | `withdrawn` covers a question closed by something other than its own answer: the job finished, or an ordinary message moved it on. |
| `questionList`, `questionAnswerRequest`, `questionAnswerResponse` | the `/questions` bodies | The answer response carries a `submissionReceipt`, because answering is an input submission. |
| `attentionBudget` | `{ questions_allowed, guidance, open_question, deferred_questions }` | What the bundle tells the model about how much it may ask. |
| `QUESTION_GUIDANCE` | string constant | One wording for "you may ask one question", shared by the service and any client that explains the rule. |
| `responsibilityAttemptOutcome` | `{ outcome, questions[] }` | How an attempt carries more than one question without touching the frozen `attemptOutcome` union. |
| `QuestioningRuntimeAdapter` | `RuntimeAdapter` with a widened `start` return | A runtime may return the envelope or the frozen outcome; both are accepted. |

## Extended shapes

- `notification` gains `because` (non-empty array of handles) and `if_ignored`.
  Existing fields are unchanged.
- `responsibilityJob` gains `deferred_questions`, defaulting to `[]`, so
  `/snapshot`, `/jobs/{id}/snapshot` and `/jobs/{id}/responsibility` show what a
  job is still holding.
- `responsibilityAttemptBundle` gains `attention`, with a default, so a bundle
  built by older code still parses.
- `SubmissionService.onAccepted` gains a fourth argument, `'create' | 'input'`.
  This is a service interface rather than a contract, but it is a shared seam:
  the reply service uses it to decide that creating a quiet monitor owes no
  reply, and the question service uses it to close a question when its answer is
  admitted in the same transaction.

## New paths

- `GET /questions` returns `questionList`: one entry per responsibility, ordered
  by what blocks an external effect, then the nearest deadline, then the oldest.
- `POST /questions/{id}/answer` takes `questionAnswerRequest` and returns
  `questionAnswerResponse`, or `409` when the question is no longer open.

## Storage

Migration `0010_attention_contract.sql` adds the `question` table, `job.deferred_questions`,
and `notification.because` / `notification.if_ignored`. Two check constraints
(`question_because_not_empty`, `notification_because_not_empty`) and one partial
unique index (`question_open_job_idx` on `job_id where state = 'open'`) put the
two rules that matter below the service, so nothing that bypasses the service can
break them. The migration backfills any pre-existing notification row with a
`job:` handle before adding its constraint.

## What this does not propose

Nothing is asked to be unfrozen. `attemptOutcome` keeps its six kinds, and a
runtime that never returns the envelope behaves exactly as it did. The one place
that costs something is noted in `.agents/notes/0011-attention-contract.md`:
questions raised by an attempt that dies before committing are lost with the
attempt, because the frozen runtime event stream carries the outcome and not the
questions.
