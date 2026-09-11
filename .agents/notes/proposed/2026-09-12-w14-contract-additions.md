# W14 additive contracts

Status: authorized for implementation by the resumed W14 brief
Date: 2026-09-12
Base: `2d3ca94eb5c07d8ddb662d22ce35d203e61b4972`

The resumed brief permits additive contracts and explicitly authorizes the
lifecycle and shared-principal additions. The earlier freeze proposals remain
historical design evidence; their stop condition is superseded.

## Lifecycle observations

Add `hook_event` and `hook_error` to the runtime and persisted event vocabularies.
Existing event variants and dedup keys keep their meaning. Observations contain
bounded names, attempt identity, capture time, optional duration, normalized
outcome and a digest of a redacted argument shape. They contain no argument
values, messages, tool results, credentials or exception text. The adapter
sequences them alongside ordinary events; PostgreSQL persists before fan-out
and cursor replay uses the existing event stream.

The pin lacks an HTTP compaction hook. A small, version-checked source patch
adds a real `on_compaction` dispatch and binds the registered plugin observers
to the current HTTP run's queue through a context variable. The same patch is
applied in the image and local real-server tests. It changes observation only;
all broker gates remain authoritative. Hook capture has no blocking network or
disk work and a failing observer emits bounded `hook_error` metadata.

## Principal and shared-space authority

Add a `principal` authority and `space_membership` with owner/member roles,
monotonic generation and revocation state. Preserve the existing owner setup,
login and single-owner data through additive columns and migration backfill.
Add shared spaces and optional principal/membership bindings to existing wire
shapes. Bind new jobs and capabilities to their authenticated principal; legacy
capabilities cannot authorize shared-space work.

Authorize reads, bundles and broker admission against the same membership.
Revocation advances the space generation, fences the revoked principal's work
and persists `context_invalidated`. Personal spaces remain private. Skill
audiences normalize `space:<id>` to a checked space identity before selecting
at most three skills for a bundle. The invitation UI remains outside v0.1.

New operator paths and optional fields are published in generated OpenAPI and
client types. Tests must cover legacy setup, both authenticated principals,
private-space refusal, bundle selection and revocation/regrant fences.

## Implemented wire and storage additions

- `principal` reuses `own_` identity syntax and the established public account
  shape. The `owner` row remains the installation's singleton setup guard.
  Session `principal_id` is optional in storage; old sessions are backfilled.
- Spaces add optional `owner_principal_id`; `kind` accepts `shared` and audience
  accepts `space`. `space_membership` retains owner/member role, nonnegative
  generation and nullable revocation time. A revoked row is never deleted.
- Jobs, attempts and submission records gain optional principal bindings.
  Runtime bundles and capability claims gain optional `principal_id` and
  `membership_generation`. Existing personal attempts retain null bindings in
  the migration, so their already issued capabilities keep working. New
  attempts require the recorded binding; a legacy capability cannot authorize
  any shared-space attempt.
- Skill frontmatter retains an optional audience. `space:<id>` is accepted only
  for that same container; absent audience means private. Skill payloads may
  include `space_id` so delivered context names its source without exposing a
  host filesystem path. The existing selector caps the actual bundle at three.

The authenticated API adds `POST /principals` (setup owner only),
`POST /spaces/shared`, `POST /spaces/{id}/memberships` and
`DELETE /spaces/{id}/memberships/{principalId}`. Membership management requires
the shared-space owner. Additional accounts log in through the existing login
route, whose response continues using the `owner` field for compatibility.
Jobs, event timelines and submission receipts remain private to their initiating
principal; membership shares published knowledge and skills, not another
principal's private attempt context. Memory questions without a job remain an
owner-only surface because their existing schema does not carry an audience.

Revocation shares the service's commit-order transaction fence with broker
admission. It advances space and memory access generations, invalidates delivered
memory and prepared outputs, persists `context_invalidated`, and cancels the
revoked principal's work after fencing active attempts. Other attempts in the
same space restart with the new policy generation. A regrant increments the
retained membership generation again. Stale requests cannot revive old work.

The bundle includes only active, audience-checked published knowledge files;
derived memory Markdown is excluded because current claim revisions must come
from the authoritative recall path. This addition does not implement W11's
evaluation/promotion protocol. Its current scope is proved by the two named
tests in `apps/melete/test/integration/principals.test.ts` and the qualified
audience test in `packages/contracts/src/principals.test.ts`.
