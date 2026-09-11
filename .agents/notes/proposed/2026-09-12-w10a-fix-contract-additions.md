# W10a-fix additive contracts

- Finding 2: execution-admission.ts adds the `{ intent: arguments }` proposal form, a one-use execution start response, and result settlement schemas. The legacy execution record form retains its meaning.
- Finding 2: OpenAPI adds POST /actions/{actionId}/execution/start and /actions/{actionId}/execution/settle on the internal broker with attempt-capability authentication. Settlement accepts a late result only for its original job, space and attempt.
- Finding 4: execRecord and its JSON Schema add optional captured_bytes, total_bytes and capture_limited. output_bytes continues to mean retained bytes, and output_path names retained output; capture_limited explicitly distinguishes a prefix from full output. This corrects the full-output claim in frozen note 0016.
- Finding 1: artifact.publish tool schema adds optional mailbox_connection_id and mailbox_generation, resolved by trusted connector preparation and checked at admission and dispatch.
- Finding 5: artifact.publish adds optional artifact_id and content_hash to the tool schema. Trusted preparation binds both before hashing; admission and dispatch load that exact artifact in the same job and space. A replacement declaration requires a different approval payload.
