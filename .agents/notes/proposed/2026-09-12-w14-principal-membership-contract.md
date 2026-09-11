# Proposed - Principals, shared spaces and membership revocation

Status: proposed; slice 3 stopped at the frozen-contract boundary
Date: 2026-09-12
Base: `9484023cabd32b786cb4d336dec818f441cd0cc1`

## Why this slice cannot proceed under the freeze

W14 requires `principal`, `space_membership`, `space.kind = shared` and a second
authenticated principal's shared-skill reuse and revocation. The brief also
requires a proposal and a stop of any slice needing a contract change.

`packages/contracts/src/entities.ts:17-35` describes one owner and accepts only
`personal` spaces with `owner` audience. The database enforces the singleton
(`apps/melete/src/db/schema.ts:26-37`), sessions join that owner table, and the
job has no principal id. `apps/melete/src/memory/db.ts:8-14` has an owner-scoped
memory handle; `lockSpace` checks the memory space's owner. The broker's existing
`EffectAuthorityResolver` can bind `actingPrincipal`, but defaults to the string
`owner` and has no principal-membership source of truth.

The existing knowledge/memory audience is `private | space | public`, paired
with a space id. It does not accept a literal `space:<id>`.
`skillFrontmatter` has no audience field and drops an unrecognized one during
parsing. `bun run packages/runtime-hermes/scripts/audit-contracts.ts` makes both
facts visible. Adding only tables or accepting a second login would leave the
public schema, memory handle and effect authority inconsistent. This slice is
stopped rather than shipping that partial boundary.

## Minimum compatible additions

| Surface | Proposed change |
|---|---|
| Principal | An owner-class individual account, with stable id, existing credential/session behavior and no installation-wide read grant. Preserve the existing owner's id and setup/login response compatibility. |
| `principal` table | Migrate the existing owner account into the principal authority. Preserve session/foreign-key references. A separate installation setup guard must keep concurrent `/setup` single-winner after the account singleton constraint is removed. |
| `space` | Add `shared`, an owning principal reference and a compatible shared audience read model. Personal spaces remain readable only by their owning principal. |
| `space_membership` | Composite principal/space identity, role `owner | member`, monotonic generation and revocation state. Retain the row on revoke so rejoining cannot reset a generation and revive an old capability. |
| Job and attempt authority | Persist the acting principal on a job; bind it and membership/access generation into shared-space attempts and capabilities. Legacy single-owner personal jobs keep working. A legacy token with no principal/membership binding must not authorize a shared-space job. |
| Skill/procedure audience | W11 publication records carry an explicit audience and space identity. A trusted operator representation `space:<id>` may normalize to the existing `audience: space` plus `space_id`; never discard the id or trust an id supplied by the model as authorization. |
| Bundle/context | Assemble skills and knowledge from the authenticated job principal's current memberships. Persist delivered-context principal and generation so invalidation can identify the affected attempt. |
| Read and mutation APIs | Authorize job, event, knowledge, skill, artifact and connection routes with the same principal/space authority, including global lists and replay. Creating another principal must not expose existing single-owner routes wholesale. |

Reuse W7/W8b audience checks and the current memory space generation vocabulary;
do not create an unrelated access counter. Reuse the broker's transaction-time
`EffectAuthorityResolver` and the existing `context_invalidated` event. An
operator provisioning primitive is sufficient; no invitation UI is proposed.

## Atomic revocation boundary

Revocation and admission must lock the same authority rows. In one transaction:
mark the membership revoked, advance its generation and the space access
generation, fence that principal's queued/running/waiting work in that space,
and invalidate delivered contexts with durable `context_invalidated` events.
Abort notifications follow commit; the durable fence does not depend on an
in-process abort being delivered.

The next request is refused before retrieval or dispatch, and the next bundle
assembly excludes the revoked space's knowledge and skills. Already admitted
or uncertain effects retain their honest status and receipts; revocation must
not manufacture a successful cancellation or replay an effect. A subsequent
grant creates a later generation and cannot resurrect an old bundle or token.

## Acceptance tests after the contract is available

- `shared principal > a member's job receives only the shared evaluated skill`: authenticate both accounts, promote through W11 and assert the real bundle.
- `shared principal > a member never sees the owner's personal space`: check direct ids, global lists, events and retrieval, not only the skills endpoint.
- `shared principal > revocation fences queued work and removes delivered context`: assert the generation advance, rejected old token, persisted invalidation and absence of the shared skill/knowledge from the next bundle.
- `shared principal > regrant never revives an earlier capability`: verify the monotonic membership generation under revoke/regrant.
- `shared principal > the same request is refused after membership revocation`: assert rejection at both bundle construction and broker admission/execution.

These names describe required future tests; none is claimed to exist or pass.
W11's evaluation/promotion records and W10c/W12's broker discovery/repair work
must be integrated before the one real-Hermes capability-chain proof can pass.
