# Three knowledge operations the OpenAPI document does not describe yet

Status: proposed
Date: 2026-09-11

## Problem

The knowledge module is implemented against the frozen contract in
`packages/contracts`. Four of its operations are described there: search a
space, read one record, propose a write, and retract or delete a record.

Three operations the module needs are not described, and the contract types are
frozen, so they were built without changing `openapi.ts` and are listed in
`PENDING_CONTRACT` in `apps/melete/src/knowledge/routes.test.ts`. The contract
test fails if any other undeclared route appears, so this list cannot grow by
accident.

| Operation | Why it exists |
|---|---|
| `GET /knowledge` | A client needs the catalog of a space. Search answers a question; it cannot list what is there. |
| `GET /knowledge/proposals` | A proposal is staged, not applied. Nothing else can show a person what is waiting, or which of them the space policy would apply without asking. |
| `POST /knowledge/proposals/{proposalId}/apply` | `POST /knowledge/proposals` stages and diffs. Without this there is no declared way to turn an approved diff into a commit, which leaves the mediator with no exit. |

## Decision

Add the three operations to `packages/contracts/src/openapi.ts` and regenerate
`openapi.json`, with these shapes, which is what the routes already serve:

- `GET /knowledge?space_id&limit` returns `{ records: [{ id, path, title, type, status, tags, updated }] }`.
- `GET /knowledge/proposals?space_id` returns `{ proposals: [{ proposal_id, path, rationale, type, proposed_by, proposed_at, requires_approval }] }`.
- `POST /knowledge/proposals/{proposalId}/apply` takes `{ approved_by?: string }` and returns `{ proposal_id, path, commit, approved_by }`, with 409 when the space policy needs a person and none was named.

Two smaller notes for whoever picks this up:

- Every declared response schema is generated with `additionalProperties: false`,
  so `POST /knowledge/proposals` could not report whether the policy would
  auto-apply the record. That is why the decision is reported on the proposals
  list instead of on the staging response.
- `knowledgeSearchQuery` has an `include_retracted` flag, but a retracted record
  is never in the index. The route answers that flag by scanning the files, and
  the description should say so: it is the owner's audit view, and no model
  reaches it.

## Alternatives

- **Edit the frozen contract now.** Rejected: other lanes are editing the same
  file this week, and a contract change belongs in one reviewed commit rather
  than in six.
- **Leave the three operations out.** Rejected: the mediator would have no apply
  path, so an agent could propose a record that nothing could ever land.
- **Serve them under a different prefix so they read as unofficial.** Rejected:
  a second vocabulary for the same resource is worse than an undescribed route.

## Evidence

`bun test apps/melete` passes with two contract tests: every knowledge and
skills operation the document declares is served by the module, and every route
the module serves is either declared or in the three-entry pending list.
