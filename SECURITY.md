# Security

## Reporting a vulnerability

Report privately through GitHub's [security advisory
form](https://github.com/ychampion/melete/security/advisories/new). Please do
not open a public issue for anything that could be used against a running
install.

Tell us what you can reproduce, on which version, and what an attacker gets. A
proof of concept helps and a working exploit is not required.

You will get an acknowledgement within three days. Melete is maintained by
volunteers, so a fix may take longer than that; we will tell you what we are
doing rather than go quiet. There is no bounty programme.

## What v0.1 is, honestly

Melete is pre-release and has never been installed anywhere but a development
machine. Do not connect it to an account you cannot afford to have misused.

The boundaries this release actually enforces:

- The runtime container has no route to the internet. It sits on a docker
  network declared `internal: true`, so there is no default route in the kernel,
  and the Melete broker is the only peer it can reach.
- The runtime holds no database credentials and no provider keys. Provider keys
  are injected by the gateway proxy; connection secrets never leave the service.
- The runtime runs as a non-root user with a read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, and process and memory limits, with
  `/work` as its only mount.
- Every external effect passes the broker. An approval binds to the canonical
  payload hash and to the job revision; editing the draft creates a new action.
- Attempts are fenced by an epoch. A stale attempt cannot admit an action.
- Provider keys and connection secrets are encrypted at rest with a master key
  the operator holds.
- Approval screens are rendered from action records, never from model text.

The boundaries that are weaker than they sound, stated plainly:

- **The container shares a kernel with the host.** This is not virtual-machine
  isolation. A container escape is a host compromise. gVisor is the documented
  intermediate step and a Firecracker microVM is the target; neither is in v0.1.
- **The broker runs inside the same process as the API.** A bug in one is a bug
  in the other. Splitting them into separate processes with separate database
  roles is planned, not shipped.
- **Connectors are trusted in-process code.** A malicious connector has whatever
  the service has. Only install connectors you would install as a library.
- **OAuth tokens for subscription providers live in the runtime's own auth
  store** in v0.1, unlike API keys. That is a real difference and
  [the threat model](docs/THREAT-MODEL.md) describes it.
- **Inbox hygiene is best-effort.** Retrieval filters things that look like
  one-time codes and password resets with regular expressions and sender
  heuristics. Treat it as a speed bump, not a control.
- **There is no confidential compute.** The operator of the machine can read
  everything.

## Supported versions

None yet. Nothing has been released. When v0.1.0 is tagged, the latest minor
release will receive security fixes.
