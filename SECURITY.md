# Security

## Reporting a vulnerability

Use GitHub's [private security advisory form](https://github.com/ychampion/melete/security/advisories/new)
for reports about a running installation. Include the code revision, reproduction
steps and observed impact. A response-time guarantee is **not claimed**.

## Verified scope

Melete is pre-release. The [threat model](docs/THREAT-MODEL.md) describes code
baseline `9484023cabd32b786cb4d336dec818f441cd0cc1` and names the tests behind
its boundary claims.

- Payload/revision approval checks: conformance 4, `An approval cannot be spent
  on different content`.
- Stale-attempt rejection: conformance 2, `A stalled attempt cannot act after
  its lease expires`.
- Uncertain-effect handling: `the action is never dispatched a second time,
  including after broker restart`.
- Secret sealing: `rejects a wrong master key, changed ciphertext and cross-row swaps`.
- Memory origin at admission: `an address read off a page is refused as
  untrusted_recipient_origin`.

These are fixture tests, not proof against arbitrary compromised code.
Container egress and filesystem probes are **written, not run** in scenario 6.
Static Compose checks do not prove live networking; Postgres shares the runtime
network, so exclusive broker reachability is **not claimed**. Writable runtime
paths include the workspace, Hermes home and temporary storage.

The API, broker and trusted connectors share a process. Host-compromise
containment, virtual-machine isolation, confidential compute, subscription OAuth
isolation and an exportable tamper-evident action ledger are **not claimed**.
See [MEMORY](docs/MEMORY.md) for the narrower removal-journal and restore tests.

## Release support

A released-version security maintenance guarantee is **not claimed** for this
pre-release. The documentation lane's pull request (#17) records the verification performed for the
documentation revision.
