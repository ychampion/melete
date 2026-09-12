# W11 additive learning contracts

The owner authorized additive contract changes in the 2026-09-11 orchestration update. This lane adds `learning.ts`, learning HTTP paths, and optional `createJobRequest.learning` metadata. Existing requests, responses, job states, capabilities, operation identities, and authority decisions retain their existing meaning.

Job admission registers optional learning scope and evidence handles inside its existing transaction, before enqueueing the first wake. This closes the race between creating a job and separately attaching its task family. The separate scope endpoint remains available before a first attempt for existing callers.

The new API covers scoped episode reads/deletion, owner intervention, candidate generation/inspection, trusted evaluation, canary enablement, activation, rejection, and rollback. Procedure bodies carry reusable steps; episode evidence and customer facts remain scoped evidence. OpenAPI and generated client types are regenerated from these schemas.

No breaking contract change is proposed. W12's `repair_candidate` can share this state machine at integration while retaining its own typed repair payload.
