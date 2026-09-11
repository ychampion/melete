# W10a-fix additive contracts

- Finding 2: execution-admission.ts adds the `{ intent: arguments }` proposal form, a one-use execution start response, and result settlement schemas. The legacy execution record form retains its meaning.
- Finding 2: OpenAPI adds POST /actions/{actionId}/execution/start and /actions/{actionId}/execution/settle on the internal broker with attempt-capability authentication. Settlement accepts a late result only for its original job, space and attempt.
