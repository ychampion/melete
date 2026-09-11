# Threat model

This document describes code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1`. It distinguishes rejection tests
from deployment claims. A fixture pass proves the exercised gate under its
inputs, not that every attack is contained.

## Attacker 1: hostile content in email or on a web page

Hostile text can influence a model's proposed actions and summaries.
General prompt-injection containment is **not claimed**.

The broker checks canonical payloads, approval hashes and attempt authority.
Conformance 4, `An approval cannot be spent on different content`, tests
payload/revision binding and cancellation fencing. The memory/broker test
`an address read off a page is refused as untrusted_recipient_origin`
checks a planted address at admission; it does not prove arbitrary prose is
safe or that every possible destination field is recognized.

The web connector rejects private/metadata addresses and rechecks redirects:
`web SSRF guard denies private, metadata, multicast and mapped private
addresses` and `redirects repeat compartment and DNS checks, with no request to
the denied destination`. Private-context allowlists use exact hosts
(`private compartment allowlist is trusted context and exact-host only`).
Public-compartment context assembly is tested separately by `approved shared
context and public compartments are assembled before delivery`; universal
deployment integration is **not claimed**.

Email hygiene is a heuristic, tested by `withholds OTP, password resets and
magic links from search and direct read`. Complete detection is **not claimed**.
Approval fatigue, misleading summaries, harmful permitted reads and social
engineering of the owner remain outside these proofs.

## Attacker 2: a malicious skill file

Skill text is not a capability credential. Broker admission still checks the
attempt and connection scopes, and external effects still cross the approval
gate (conformance 4). Skill selection is deterministic (`matches a trigger in
the objective`, `loads at most three skills, however many match`); schema
length limits are tested by `refuses a skill that is longer than the contract
allows`.

These tests do not establish that short skills are harmless. A skill may
influence permitted reads, draft contents and the owner's decisions. Skill
signing, a verified installation/review workflow and malicious-skill containment
are **not claimed**. Inspect installed skill text as trusted prompt input.

## Attacker 3: a compromised model provider

A provider receives the prompt sent to it and can return misleading text.
Confidentiality from that provider and truthfulness of its responses are
**not claimed**.

The gateway tests enforce the configured forwarding boundary:
`rejects missing capability, missing surrogate, wrong model, arbitrary paths
and methods`; `reserves before injecting credentials and strips capability
and caller headers`; and `stale epoch and concurrent budget exhaustion stop
requests before transport`. The fake-provider test `streams the fake tool
conversation end to end and records actual model and usage` checks recording
of the response's reported model. It cannot verify the provider's internal
model identity.

`Astra requires Responses and Anthropic drops sampling controls without
rewriting history` tests request handling against fake transport. Every-provider
compatibility is **not claimed**, and conformance 8's two-provider policy
comparison is **written, not run**. API-key forwarding is implemented;
subscription OAuth credential storage and its isolation are **not claimed**.

## Attacker 4: a compromised runtime container

Live container containment is **not claimed**. The scenario 6 container probes
are **written, not run**: internet, Postgres, metadata, sibling service, broker
reachability and filesystem/UID checks all remain `test.todo`.

The Compose file declares an internal-only runtime network, non-root UID,
read-only root, dropped capabilities, no-new-privileges and process/memory
limits. The static test `passes every boundary check` reads that configuration;
it does not establish runtime network behavior. In particular, Postgres shares
the runtime's internal network. The assertion that Postgres cannot be reached,
and the assertion that the broker is the only reachable peer, are **not claimed**.

Writable paths include `/work`, `/var/lib/hermes` and a `/tmp` tmpfs.
The declared Hermes home is checked by `taking away the runtime writable
Hermes home`; container enforcement is **written, not run**. A shared kernel,
runtime volume contents and reachable broker remain attack surfaces.
Virtual-machine isolation and host-compromise containment are **not claimed**.

The capability gate has independent fixture evidence: conformance 2,
`A stalled attempt cannot act after its lease expires`, verifies stale
authority rejection and truthful late receipts. This does not limit arbitrary
code execution in the runtime to the model's usual plugin behavior.

## Credentials, host and storage

Connector secrets have tested sealing and scope checks: `stores randomized
sealed boxes and only decrypts in the owning space` and `rejects a wrong
master key, changed ciphertext and cross-row swaps`.
The process holding the master key and plaintext at dispatch remains trusted.
The broker, API and connectors share a service process. Process-level separation,
confidential compute and protection against a compromised host are **not claimed**.

Memory restrictions are checked in Postgres before recall, not merely in a
filesystem search index. `source and space revocation invalidate delivered
context and block stale serving` tests that boundary. The restriction journal
supports memory restore gating; a shipped exportable tamper-evident action
ledger is **not claimed**. See [MEMORY](MEMORY.md) for retained-copy limits.

## Verification

Run from the repository root:

```bash
bun run compose:check
bun test apps/melete/src/connectors
```

The first command checks YAML only; the second uses temporary files, fake
transports and local protocol fixtures. Full-suite results and the unrun
container probes are recorded in [REPORT.md](../REPORT.md).
