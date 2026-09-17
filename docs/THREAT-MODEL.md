# Threat model

This document describes the tree at the head of `integration`. It
distinguishes rejection tests from deployment claims. A fixture pass proves the exercised gate under its
inputs, not that every attack is contained.

The service container mounts the host Docker socket to supervise attempt
containers. Socket access is **host-root equivalent**: the service can ask the
Docker daemon to launch privileged containers and mount host filesystems. Its
non-root UID and selected socket group do not reduce that authority. The trusted
supervisor and service therefore sit **inside the host trust boundary**. A
compromised service can compromise the host; the attempt sandbox does not contain
that compromise. Runtime attempts never receive the socket. Compose requires an
explicit `DOCKER_GID` matching its host ownership, and the supervisor's launch
argument tests check the restrictions applied to each runtime.

## Attacker 1: hostile content in email or on a web page

Hostile text can influence a model's proposed actions and summaries.
General prompt-injection containment is **not claimed**.

The broker checks canonical payloads, approval hashes and attempt authority.
Conformance 4, `An approval cannot be spent on different content`, tests
payload/revision binding and cancellation fencing. `resume_action` carries only
an action id: an attempt can carry out an action the owner approved for its own
job and current revision, with the stored bytes, under its own live capability,
and nothing else (`resume refuses whatever the owner has not approved for this
job and revision`). The memory/broker test
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
compatibility is **not claimed**. Conformance 8 ran against the Linux stack with
the scripted provider (a cell capability could read the catalog but not approve,
and an altered approval hash was refused); its comparison against a second, real
provider was skipped because no credential was configured. API-key forwarding through the gateway is
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
- **`/work` is the job's own subpath.** Each per-attempt container mounts
  `work/<job>` with a volume subpath, so a sibling job's directory is not
  present in the cell at all. Scenario 6 planted a canary in a sibling
  directory and read it through three cell paths; all three returned ENOENT
  while the job's own workspace stayed writable. Two jobs' workspaces are
  separated by the OS mount, and the tool-level refusal is a second check
  rather than the boundary.

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
creation. Sign-in limits and their tests are under Attacker 6.

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

Launching a local untrusted installation requires a separate OS identity or
sandbox, no vault/database mounts or credentials, and a verified network
policy. Both the production adapter and raw stdio transport
reject an unisolated launch; tests prove rejection before spawning. A
container-isolated MCP launcher has not been built or tested.
Composition likewise requires the cell executor, which the default service does
not inject; its test-only `node:vm` fallback is not an OS or memory boundary.

## Attacker 6: a remote client at the sign-in form

This attacker reaches `/login` and `/setup` like any browser, from one address
or many, and knows or guesses the owner's email. The aims are to guess the
password, to learn which emails have accounts, and to keep the owner from
signing in by exhausting whatever limits the guessing.

Guessing meets three in-memory limiters in front of the argon2id check: one per
client address, one per account shared by every browser that has not signed in
to that account before, and one per known device. The client address is the
socket source, or the address the web proxy states in
`X-Melete-Client-Address`. The proxy writes that header from its own socket over
anything the browser sent, and the API believes it only on a connection from the
peer named by `MELETE_TRUSTED_PROXY`, which Compose fixes to the edge-only `web`
service. From any other peer the header is ignored, so inventing addresses mints
no fresh buckets. An unknown email costs the same verification and returns the
same 401 as a wrong password. `/setup` answers an installed service before it
parses or hashes anything and has a limiter of its own.

Lockout is the part a limiter can turn against the owner. A refused request
changes no limiter state, so it cannot lengthen a wait or postpone a reset. A
browser that has signed in to the account before carries a signed
`melete_device` cookie; with it, the browser bypasses the address and account
limiters and spends an attempt budget of its own. The cookie authenticates
nobody, is bound to one account by a keyed digest, and is signed with a key
derived from `MELETE_MASTER_KEY`. The tests `strangers cannot lock a known
browser out of its account`, `browsers behind the web proxy are throttled by
their own address`, `a forged client address from a peer that is not the proxy
mints no fresh bucket`, `setup answers an installed service before hashing and
is throttled` and `an unknown email costs the same password verification as a
known one` in [auth.test.ts](../apps/melete/test/integration/auth.test.ts)
exercise each property. Exact numbers are in
[DEPLOYMENT](DEPLOYMENT.md#sign-in-limits).

What remains: a stranger who keeps the shared account limiter closed delays a
sign-in from a browser that is new to the account, to at most one admitted
attempt per 60 seconds, for as long as the guessing continues. A known browser
is unaffected. A stolen device cookie removes that protection for its holder
and nothing else; it expires after 90 days and cannot be revoked singly. All
limiter state is per process and is cleared by a restart. Behind the default
loopback ports, an SSH tunnel or a host TLS proxy, every browser reaches the web
server from the Docker gateway and therefore shares one client address. No
second factor exists. Distributed guessing below the account limit is slowed,
not stopped; the password remains the control.

## Attacker 7: another account on the same installation

The setup owner can provision further accounts. Such an account is a full
person with a password, not a guest of the owner, and must not reach the
owner's rows or act through the owner's connections.

A session's space is derived from its authenticated principal on every request:
that principal's own personal space, or a stored selection it is still a member
of under the membership generation the selection was stored with. No path falls
back to another account's space, and an account without a personal space
receives its own on first use. Conversations, plans, routines, permissions,
drafts, receipts, undo, search, quick answers, the event stream, artifacts,
reactions and browser takeover or handback are also checked against the job's
principal, so they stay private inside a shared space.
[principal-scope.test.ts](../apps/melete/test/integration/principal-scope.test.ts)
drives each surface from a second account against the owner's rows, and from the
owner against the second account's, and asserts that nothing was read, decided,
sent, undone or steered.

What remains: the profile, tasks, saved rules, agents and connection reads are
rows of a space rather than of a person, so a shared space offers them to its
owner only. A file whose job row was deleted is scoped by its space alone.
Accounts share one service process, one database role and one master key;
isolation between them is an application check, not an operating-system or
database boundary.

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

## Browser worker boundary

The browser worker is a connector process outside the runtime cell. A hostile
page may influence the model's proposed actions, and a compromised Chromium or
worker process may read the selected space's browser profile. The controller,
broker, and container boundary have separate jobs:

- **Controller authority.** Every dispatched input carries its planned
  `control_epoch`. Takeover increments the epoch immediately, including while
  another action is waiting for a locator; the next input is refused by the
  controller. Handback increments it again and requires a fresh observation.
  The service parks the job as `waiting_for_input`. This claim is falsified by a
  second fill reaching the page after takeover. The local fixture tests inject
  exactly that interleaving and require zero submissions.
- **Consequential effects.** Form commits use `browser.submit` through the broker's
  approval, intent-key, and trust-origin gates. The controller binds the observed
  form and outgoing request to that approved intent. Reversible inputs have no
  network budget; an approved submit has one matching mutation. An unapproved
  request reaching the fixture ledger would falsify the gate. Unknown commit
  outcomes are not replayed.
- **Page networking.** Chromium's direct networking is pointed at a fail-closed
  proxy, and trusted worker code relays checked requests. Public-address checks,
  pinned DNS transport, redirect checks, and the private-context domain allow-list
  apply there. WebSockets and service workers are denied. The public-web
  compartment does not reuse a signed-in private profile. Private-address traffic
  reaching a fixture transport would falsify these checks.
- **Space and process isolation.** The browser override mounts only
  `spaces/<space id>` at `/space`, runs uid 10003, and supplies no database URL,
  vault key, provider key, runtime capability, all-spaces mount, global artifacts
  root, or runtime work volume. It does not share the runtime or Postgres networks.
  The YAML tests deliberately add each forbidden mount, credential, network, or
  privilege and require the configuration check to reject it. A host operator
  still has to create and permission the intended volume subdirectory.
- **Narrow worker listener.** The control network is shared only with the broker,
  no control port is published, and a separate worker token is required. The
  listener accepts bounded JSON requests for health, leases, semantic commands,
  release, takeover, and handback; it exposes no CDP or arbitrary code endpoint.
  Browser-originated requests are rejected. The owner-facing control routes use
  the service's existing authentication and same-origin protection.

The worker can reach the internet by design, for the person's authorized sites.
The relay policy constrains an intact worker; a compromised Node process can
use its own outbound sockets and can steal or alter its mounted browser profile.
It can read whatever the configured uid may read within that one mounted space.
It has no direct mount of the vault, runtime cell, or another space. The container
shares the host kernel; a kernel compromise removes those boundaries. A separate
virtual machine and a Chromium renderer-sandbox proof are **not claimed**.

Docker bridge membership is not directional. A compromised worker can reach the
Melete service ports on `browser-control`, even though it cannot directly join the
runtime or database network. The worker token grants no authority to those ports;
owner authentication and broker capability checks must continue to reject it.
Melete still holds credentials in the same process as the API, so an exploitable
service bug remains a route to them. The topology does not claim otherwise.

Development on Windows uses a same-user child process with a restricted
environment, not an OS isolation boundary. Production requires an explicitly
configured isolated endpoint and never silently starts that development child.
The endpoint address is trusted operator configuration, not an attestation of
the remote deployment. Takeover supplies fencing and owner control routes. A
person may enter credentials on an operator-owned worker display using
`MELETE_BROWSER_HEADLESS=false`; a remote desktop transport or login UI is not
provided here. The network guard remains closed to unbrokered requests during
takeover; interactive sign-in remains unsupported. Recipes and episodes exclude
authentication factors, while Chromium's private profile may retain the cookies
needed for a warm signed-in session.

`bun run deploy/scripts/browser-compose-check.ts` checks deployment configuration;
the browser and integration tests check live controller behavior on local
fixtures. The browser image build, the combined Compose startup with the browser
override, and Linux packet-level isolation of the worker have not been run;
static YAML checks do not substitute for them. Installation and operation are
described in [browser-worker.md](browser-worker.md).
