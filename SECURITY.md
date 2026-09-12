# Security

## Reporting a vulnerability

Use GitHub's [private security advisory form](https://github.com/ychampion/melete/security/advisories/new)
for reports about a running installation. Include the code revision, reproduction
steps and observed impact. A response-time guarantee is **not claimed**.

## Verified scope

Melete is pre-release. The [threat model](docs/THREAT-MODEL.md) describes the
tree at the head of `integration` and names the tests behind its boundary
claims.

- Payload/revision approval checks: conformance 4, `An approval cannot be spent
  on different content`.
- Stale-attempt rejection: conformance 2, `A stalled attempt cannot act after
  its lease expires`.
- Uncertain-effect handling: `the action is never dispatched a second time,
  including after broker restart`.
- Secret sealing: `rejects a wrong master key, changed ciphertext and cross-row swaps`.
- Memory origin at admission: `an address read off a page is refused as
  untrusted_recipient_origin`.

These are fixture tests, not proof against arbitrary compromised code. The
container egress, sibling-service, workspace and owner-control-plane probes of
scenario 6 ran from inside a claimed cell and the warm cell on one Linux Docker
host; the broker and model gateway were the only reachable peers. Static Compose
checks do not prove live networking on any other host. Writable runtime paths
are the job's own `work/<job>` subpath, the attempt's Hermes home and a
size-limited temporary filesystem.

The API, broker and trusted connectors share a process, and that process holds
the Docker socket, which is host-root equivalent. The browser worker and MCP
servers run outside the cell and are bounded by the broker, not by the cell's
network. Host-compromise containment, virtual-machine isolation, confidential
compute, provider OAuth stored inside the runtime and an exportable
tamper-evident action ledger are **not claimed**. See [MEMORY](docs/MEMORY.md)
for the narrower removal-journal and restore tests.

## Release support

A released-version security maintenance guarantee is **not claimed** for this
pre-release.
