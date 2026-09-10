# 0004 - v0.1 isolation is a compose internal network, and we say so

Status: accepted
Date: 2026-09-11

## Problem

The runtime executes text written by a model that has read email and web pages an
attacker may control. It must not be able to reach the internet, the database, or
the host. We had a week, and the strong answers do not fit in a week or on every
self-hoster's machine.

## Decision

The runtime container is attached only to a docker network declared
`internal: true`, so the kernel gives it no default route. The Melete broker is
the only peer it can reach. It runs as a non-root user with a read-only root
filesystem, all capabilities dropped, `no-new-privileges`, a pids limit, a memory
limit, and `/work` as its only mount.

And we describe that boundary exactly as strong as it is. The threat model says
the kernel is shared with the host, the broker runs in the same process as the
API, and connectors are trusted in-process code. gVisor is the documented
intermediate step; a Firecracker microVM is the target.

## Alternatives

- **Firecracker now.** The right answer, and not a week of work. Requires KVM,
  which rules out most laptops.
- **gVisor now.** Closer, but an extra runtime dependency on every host for a
  release nobody has installed yet.
- **Trust the process boundary.** Not a boundary.

## Evidence

`bun run compose:check` parses the compose file and asserts eleven properties,
including that `runtime.networks` is exactly `[internal]` and that the internal
network is declared internal. Its own test suite breaks the file seven ways and
checks that each break is caught. Conformance scenario 6 runs the same claims
from inside the container: the internet, `postgres:5432`, `169.254.169.254`, and
a sibling service all fail; the broker succeeds.

Docker is not installed on the machine where this was written, so the image has
not been built and the stack has not been started here. The YAML and the
Dockerfiles are syntax-checked only. That limitation is stated in the runtime
package README rather than implied away.
