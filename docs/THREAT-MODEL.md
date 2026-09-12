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
gate (conformance 4). Initial skill selection is deterministic (`matches a
trigger in the objective`, `loads at most three skills, however many match`);
on-demand discovery can load a skill the model requests, but the broker filters
it by the current job's scopes and withholds space skills in the public
compartment, so a requested skill never supplies its own authority. Schema
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
comparison is **written, not run**. API-key forwarding through the gateway is
the verified path. Configuring provider OAuth inside Hermes would place those
credentials in the runtime's auth store, outside this boundary: a runtime
compromise exposes an OAuth token stored there, and it does not expose a
provider API key kept in Melete's gateway. The tested images and volumes
contain no such OAuth configuration.

## Attacker 4: a compromised runtime container

Live container containment was probed on a Linux Docker host (Engine 29.1.3,
2026-09-11 and 2026-09-12) from a real claimed Hermes container and the warm
probe container: the internet, the host metadata address, a live host listener,
Postgres (by DNS and by container IP), the web service and the owner control
plane (`/setup`, `/login`, `/health` on port 8787) were unreachable; the broker
and model gateway on port 8788 were the only reachable peers; the cell ran as
UID 10001 with a read-only root, zero effective capabilities, no-new-privileges
and no Docker socket. The table below records that evidence and what would
falsify it. These checks establish the tested Linux configuration, not macOS,
Windows, rootless Docker, or protection from kernel exploits.

The Compose file declares an internal-only runtime network with isolated
bridge gateway mode, non-root UID, read-only root, dropped capabilities,
no-new-privileges and process/memory limits. The static test `passes every
boundary check` reads that configuration; the live probes above are what
establish runtime behavior.

Writable paths are the current job's `/work` subpath (`work/<job>`, mounted
with a volume subpath so sibling jobs' directories are hidden by the OS mount),
the attempt's named `/var/lib/hermes` volume, and a size-limited `/tmp` tmpfs.
The declared Hermes home is checked by `taking away the runtime writable
Hermes home`. A shared kernel, the runtime volume's own contents and the
reachable broker remain attack surfaces. Virtual-machine isolation and
host-compromise containment are **not claimed**.

The capability gate has independent fixture evidence: conformance 2,
`A stalled attempt cannot act after its lease expires`, verifies stale
authority rejection and truthful late receipts. This does not limit arbitrary
code execution in the runtime to the model's usual plugin behavior.

### The runtime runs code on purpose

Since 0.1 the cell can run shell commands and Python snippets, and no approval
stands in front of it. That is not a weakening of this section, it is a
statement about where the boundary is. The container is what contains a command,
and it contains one exactly as well as it contains the agent loop that started
it: no route out, no credentials, non-root, read-only root filesystem, all
capabilities dropped, `no-new-privileges`, process and memory limits, `/work` as
the only writable mount. An attacker who can make the model run a command has
gained nothing an attacker who already had code execution in the container did
not have.

What running code does add is a record. Every execution is a
`write_reversible` action with the command, the working directory, the exit
code, the duration and a digest of the output, so a command that ran is
something the owner can see rather than something that happened inside a tool
result. The plugin refuses a working directory outside the job's workspace
before starting anything, the broker refuses the same thing again when the
record arrives, and a stored output is re-hashed on the service side before the
receipt says it verified.

What that does **not** contain: the command's effects on the filesystem. That is
the container's job and only the container's job. Two consequences worth naming:

- **A command can write anywhere the container can write.** Today that is
  `/work`, the Hermes home, and a small `/tmp`. There is no second sandbox
  inside the cell and the code says so.
- **`/work` is currently the whole volume.** `deploy/docker-compose.yml` mounts
  it at `/work` in the runtime container, so a snippet can read another job's
  workspace even though the execution tool refuses to name one. The per-attempt
  container the service will start has to mount `work/<job>` instead. Until it
  does, two jobs' workspaces are separated by a tool-level refusal and not by a
  filesystem boundary.

## Linux deployment verification

On 2026-09-11, scenario 6 ran Python standard-library probes from a real claimed
Hermes container and the warm probe container under Docker Engine 29.1.3. The
claimed cell mounted only `work/<job>` and its private runtime home. These checks
establish the tested Linux configuration, not macOS, Windows, rootless Docker,
or protection from kernel exploits.

| Boundary | Observed evidence | What would falsify it |
| --- | --- | --- |
| External network | No default route; public IP, metadata IP and a live host listener were unreachable | A successful TCP connection to any blocked target |
| Sibling services | Postgres failed by DNS and actual container IP; web DNS was unreachable | A reachable database or web listener from the cell |
| Workspace | A sibling canary existed in the full volume; three read paths returned ENOENT while the job workspace was writable | Reading that canary through any cell path |
| Sole peer | Network inspection showed only Melete and the cell; broker/model routes answered | Another attached peer or an unmediated external route |
| Runtime authority | A valid cell capability read the catalog (200) but could not approve (401); altered owner approval hashes were refused (409) | A cell capability spending an approval or changing its payload |
| Owner control plane | Scenario 6 probes setup, login and health on port 8787 from both cells; the API binds only to edge and its transport guard denies other source subnets | Either cell receiving account state or any response other than connection refusal or the fixed 403 |
| Process hardening | UID 10001, read-only root, zero effective capabilities, no-new-privileges, no Docker socket | Any failed assertion in the live hardening probe |

The restore proof replaced only the stack's Postgres volume while retaining a
newer independent restriction journal. Before normal startup, verification
rejected the stale snapshot. Startup replayed the restriction before opening
memory and job workers; afterward the forgotten fact was absent, an unrelated
fact remained available, and the restored waiting job completed with one receipt.
Serving the forgotten fact or duplicating the destination effect would falsify
those restore claims. Commands and measured results are in [deployment note 0020](../.agents/notes/0020-deployment-evidence.md).

The 2026-09-12 review added the missing peer-port checks:
`the warm cell cannot reach owner setup, login or health` and
`a claimed attempt cannot reach the owner control plane and retains its job boundary`.
The earlier peer-set test alone did not establish this control-plane boundary.
An integration test verifies the transport rejection before and after owner
creation; another verifies per-source login backoff and forged-header rejection.

## Attacker 5: a hostile operator-installed MCP server or generated wrapper

MCP workers belong outside the runtime cell. A server can lie in its description,
annotations or results, including calling a write read-only. The operator's
config supplies the exposed tools, effect classes, scopes and audience. The
default effect is `write_external`; `readOnlyHint` cannot remove an approval.
The broker still checks every action's scope, intent identity, approval hash and
trust origin. A server result cannot install a tool, load a schema or approve
an action. The stdio fixture verifies that a dishonest write does not reach the
server until the owner approves its canonical payload.

Discovery is also inside this boundary. Postgres ranks only the scoped catalog;
the model cannot supply schemas or scope declarations to `load_tool`. Loaded
schemas are context, not grants. Revoked scopes and stale epochs are rejected
again on use. A tool whose effect class changes between admission and dispatch
is refused before its connector executes.

Composition preflights only trusted read tools, and the broker checks the read
classification again inside its proposal transaction. The script receives JSON
data without a broker client or credentials. Each underlying read has its own
action and receipt; generated result fields claiming owner origin do not change
the enclosing inferred provenance or the original evidence handles.

**Production stdio is refused at the launch boundary.** The test MCP launcher filters
environment variables, redirects profile paths to its temporary directory and
grants no client roots or sampling capability. That prevents automatic credential
inheritance; it does not stop a same-identity process reading service-accessible
files, inspecting other processes where the OS permits it, or using the host's
network routes. An HTTP MCP endpoint can reach whatever its remote host permits.
Neither worker is inside the cell's `internal: true` network boundary.

Configured HTTP installations register with the `mcp` provider. They receive
only protocol messages and admitted tool arguments, with no service credentials,
vault paths, database connection strings or client-side capabilities. Their
own host's filesystem and network policy remain the operator's responsibility.
Owner-only tools are hidden in public compartments and the broker checks the
persisted audience again at dispatch, including after approval.

The [isolation proposal](../.agents/notes/proposed/2026-09-12-mcp-provider.md)
requires a separate OS identity or sandbox, no vault/database mounts or
credentials, and a verified network policy before the service can launch local
untrusted installations. Both the production adapter and raw stdio transport
reject an unisolated launch; tests prove rejection before spawning. Docker
isolation was not tested on the Windows host.
Composition likewise requires the cell executor; its test-only `node:vm`
fallback is not an OS or memory boundary.

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
transports and local protocol fixtures. The container probes run as scenario 6
when `MELETE_CONFORMANCE_COMPOSE=1` is set against a running Linux stack (see
the README). The Linux deployment and restoration checks use a scripted model
and a test destination; they do not establish live provider behavior or the
safety of an arbitrary external account.
