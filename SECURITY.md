# Security

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's
Security tab and choose **Report a vulnerability**, or go straight to the
[advisory form](https://github.com/ychampion/melete/security/advisories/new).
The report stays between you and the maintainers until a fix is published.
Include the code revision, reproduction steps and the impact you observed.
Reports are triaged as they arrive.

Please keep vulnerabilities out of public issues, pull requests and
discussions.

## The isolation boundary

Melete's isolation boundary is the per-attempt container. The
[threat model](docs/THREAT-MODEL.md) describes it in full and names the tests
behind each claim.

Inside that boundary, the broker and the model gateway are the only reachable
peers. The container egress, sibling-service, workspace and owner-control-plane
probes of conformance scenario 6 ran from a claimed cell and the warm cell on a
Linux Docker host, and found the internet, the host metadata address, Postgres
by DNS and by container IP, the web service and the owner control plane all
unreachable. Writable paths are the job's own `work/<job>` subpath, the
attempt's Hermes home and a size-limited temporary filesystem. Static Compose
checks read configuration; scenario 6 is what establishes live enforcement, on
the host where it runs.

Outside that boundary sit the service and the workers it supervises. The API,
broker and trusted connectors share a process, and that process holds the Docker
socket, which is host-root equivalent. The browser worker and MCP servers run
outside the container and are bounded by the broker rather than by the
container's network.

Named evidence for the authority checks:

- Payload and revision approval binding: conformance 4, `An approval cannot be
  spent on different content`.
- Stale-attempt rejection: conformance 2, `A stalled attempt cannot act after
  its lease expires`.
- Uncertain-effect handling: `the action is never dispatched a second time,
  including after broker restart`.
- Secret sealing: `rejects a wrong master key, changed ciphertext and cross-row
  swaps`.
- Memory origin at admission: `an address read off a page is refused as
  untrusted_recipient_origin`.

These are fixture tests. See [MEMORY](docs/MEMORY.md) for the removal-journal
and restore tests.
