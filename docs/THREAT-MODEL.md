# Threat model

This document names each attacker Melete is built to withstand, the boundary in
the way, the tests that check that boundary, and what lies beyond it. Two kinds
of evidence appear throughout: fixture tests, which check a gate against the
inputs they supply, and the live probes of conformance scenario 6, which check
the deployed container boundary on a Linux Docker host.

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

Hostile text can influence a model's proposed actions and summaries. Melete does
not rely on the model resisting injected instructions: the defence sits at the
effect boundary, where text the model has read cannot widen what an attempt may
do or change what an approval covers.

The broker checks canonical payloads, approval hashes and attempt authority.
Conformance 4, `An approval cannot be spent on different content`, tests
payload/revision binding and cancellation fencing. `resume_action` carries only
an action id: an attempt can carry out an action the owner approved for its own
job and current revision, with the stored bytes, under its own live capability,
and nothing else (`resume refuses whatever the owner has not approved for this
job and revision`). The memory/broker test `an address read off a page is
refused as untrusted_recipient_origin` checks a planted address at admission.
Origin is checked on the recognised
recipient, destination, amount and resource fields; free prose, and a
destination carried in any other field, have no origin check.

The web connector rejects private/metadata addresses and rechecks redirects:
`web SSRF guard denies private, metadata, multicast and mapped private
addresses` and `redirects repeat compartment and DNS checks, with no request to
the denied destination`. Private-context allowlists use exact hosts
(`private compartment allowlist is trusted context and exact-host only`).
A calendar feed is fetched under the same public-address rules, resolved again
on every read, with redirects refused (`ics-feed.test.ts`).
Public-compartment context assembly is tested by `approved shared context and
public compartments are assembled before delivery`: a public-compartment job
receives no private memory.

Email hygiene matches the known shapes of one-time codes, password resets and
magic links, tested by `withholds OTP, password resets and magic links from
search and direct read`; a sensitive message in any other shape is read like
any other message. Approval fatigue, misleading summaries, harmful reads within
granted scope and social engineering of the owner rest on the owner's judgement
rather than on these checks.

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

A skill that passes these checks can still influence permitted reads, draft
contents and the owner's decisions. A skill file in a space loads once it passes
schema and length validation, and skills carry no signature, so treat installed
skill text as trusted prompt input and read it before installing it.

## Attacker 3: a compromised model provider

A provider sees the content of every request sent to it and can return
misleading text. What it returns is model output with no authority of its own,
subject to the same broker checks as any other proposal. Choose a provider you
trust with the content of your jobs.

The gateway tests enforce the configured forwarding boundary:
`rejects missing capability, missing surrogate, wrong model, arbitrary paths
and methods`; `reserves before injecting credentials and strips capability
and caller headers`; and `stale epoch and concurrent budget exhaustion stop
requests before transport`. The fake-provider test `streams the fake tool
conversation end to end and records actual model and usage` checks recording
of the response's reported model; the recorded model is the one the provider
reports.

`Astra requires Responses and Anthropic drops sampling controls without
rewriting history` tests request handling against a fake transport; the
supported providers are listed in [DEPLOYMENT](DEPLOYMENT.md#providers).
Conformance 8 runs against the Linux stack with the scripted provider: a cell
capability can read the catalog but not approve, and an altered approval hash is
refused. Its comparison against a second, real provider runs when the stack has
that provider's credential and `MELETE_CONFORMANCE_REAL_PROVIDER` and
`MELETE_CONFORMANCE_REAL_MODEL` select it. API keys stay in the gateway, which
forwards them. Configuring provider OAuth inside Hermes would place those
credentials in the runtime's auth store, outside this boundary: a runtime
compromise exposes an OAuth token stored there, and it does not expose a
provider API key kept in Melete's gateway. The runtime image and Compose volumes
carry no OAuth configuration.

## Attacker 4: a compromised runtime container

Conformance scenario 6 probes containment live, from a real claimed Hermes
container and the warm probe container on a Linux Docker host: the internet, the
host metadata address, a live host listener, Postgres (by DNS and by container
IP), the web service and the owner control plane (`/setup`, `/login`, `/health`
on port 8787) are unreachable; the broker and model gateway on port 8788 are the
only reachable peers; the cell runs as UID 10001 with a read-only root, zero
effective capabilities, no-new-privileges and no Docker socket. The table under
[Linux deployment verification](#linux-deployment-verification) records each
boundary, its evidence and what a breach would look like. The probes establish
the boundary on a Linux host running Docker Engine; macOS, Windows and rootless
Docker hosts are outside what they cover.

The Compose file declares an internal-only runtime network with isolated
bridge gateway mode, non-root UID, read-only root, dropped capabilities,
no-new-privileges and process/memory limits. The static test `passes every
boundary check` reads that configuration; the live probes above are what
establish runtime behaviour.

Writable paths are the current job's `/work` subpath (`work/<job>`, mounted
with a volume subpath so sibling jobs' directories are hidden by the OS mount),
the attempt's named `/var/lib/hermes` volume, and a size-limited `/tmp` tmpfs.
The declared Hermes home is checked by `taking away the runtime writable
Hermes home`. Inside the boundary, the shared kernel, the runtime volume's own
contents and the reachable broker remain attack surface. The isolation boundary
is the attempt container on the host's shared kernel; a kernel exploit or a
compromised host is outside it.

The capability gate has independent fixture evidence: conformance 2,
`A stalled attempt cannot act after its lease expires`, verifies stale
authority rejection and truthful late receipts. The gate governs what an attempt
may ask the broker to do; code running inside the cell is bounded by the
container, as the next section describes.

### The runtime runs code on purpose

The cell runs shell commands and Python snippets, with no approval in front of
them, because the container is the boundary for code. It contains a command
exactly as well as it contains the agent loop that started it: no route out, no
credentials, non-root, read-only root filesystem, all capabilities dropped,
`no-new-privileges`, process and memory limits, and `/work`, the attempt's
Hermes home and a small `/tmp` as the only writable paths. An attacker who can
make the model run a command gains nothing beyond what code execution in the
container already gives. The tools that run code are among the default
connections a space is given, and only where attempts run in a container; under
the process supervisor that row offers nothing
([CONNECTORS](CONNECTORS.md#default-connections)).

What running code does add is a record. Every execution is a
`write_reversible` action with the command, the working directory, the exit
code, the duration and a digest of the output, so a command that ran is
something the owner can see rather than something that happened inside a tool
result. The plugin refuses a working directory outside the job's workspace
before starting anything, the broker refuses the same thing again when the
record arrives, and a stored output is re-hashed on the service side before the
receipt says it verified.

A command's effects on the filesystem are bounded by the container alone. Two
consequences follow:

- **A command can write anywhere the container can write.** That is `/work`,
  the Hermes home and a small `/tmp`; the cell has no second sandbox inside it.
- **`/work` is the job's own subpath.** Each per-attempt container mounts
  `work/<job>` with a volume subpath, so a sibling job's directory is not
  present in the cell at all. Scenario 6 plants a canary in a sibling
  directory and reads it through three cell paths; all three return ENOENT
  while the job's own workspace stays writable. Two jobs' workspaces are
  separated by the OS mount, and the tool-level refusal is a second check
  rather than the boundary.

## Linux deployment verification

Scenario 6 runs Python standard-library probes from a real claimed Hermes
container and the warm probe container; the recorded run used Docker Engine
29.1.3 on Linux. The claimed cell mounts only `work/<job>` and its private
runtime home.

| Boundary | Observed evidence | What a breach would look like |
| --- | --- | --- |
| External network | No default route; public IP, metadata IP and a live host listener were unreachable | A successful TCP connection to any blocked target |
| Sibling services | Postgres failed by DNS and actual container IP; web DNS was unreachable | A reachable database or web listener from the cell |
| Workspace | A sibling canary existed in the full volume; three read paths returned ENOENT while the job workspace was writable | Reading that canary through any cell path |
| Sole peer | Network inspection showed only Melete and the cell; broker/model routes answered | Another attached peer or an unmediated external route |
| Runtime authority | A valid cell capability read the catalog (200) but could not approve (401); altered owner approval hashes were refused (409) | A cell capability spending an approval or changing its payload |
| Owner control plane | Scenario 6 probes setup, login and health on port 8787 from both cells; the API binds only to edge and its transport guard denies other source subnets | Either cell receiving account state or any response other than connection refusal or the fixed 403 |
| Process hardening | UID 10001, read-only root, zero effective capabilities, no-new-privileges, no Docker socket | Any failed assertion in the live hardening probe |

The restore proof replaces only the stack's Postgres volume while retaining a
newer independent restriction journal. Before normal startup, verification
rejects the stale snapshot. Startup replays the restriction before opening
memory and job workers; afterwards the forgotten fact is absent, an unrelated
fact remains available, and the restored waiting job completes with one receipt.
Serving the forgotten fact, or a second destination receipt, would mean the
restore boundary had failed. Commands and measured results are in [deployment note 0020](../.agents/notes/0020-deployment-evidence.md).

Two scenario 6 tests cover the owner control plane from inside the cells:
`the warm cell cannot reach owner setup, login or health` and
`a claimed attempt cannot reach the owner control plane and retains its job boundary`.
An integration test verifies the transport rejection before and after owner
creation. Sign-in limits and their tests are under Attacker 6.

## Attacker 5: a hostile installed MCP server or generated wrapper

MCP workers belong outside the runtime cell. A server can lie in its description,
annotations or results, including calling a write read-only. The exposed tools,
effect classes, scopes and audience come from the installation, either the row
an owner installs through `POST /connections` or an entry in the operator's
connections file, and a server cannot change them. The
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
inheritance; a process under the service's own OS identity could still read
service-accessible files, inspect other processes where the OS permits it, and
use the host's network routes. An HTTP MCP endpoint can reach whatever its
remote host permits. Neither worker is inside the cell's `internal: true`
network boundary.

Configured HTTP installations register with the `mcp` provider. They receive
only protocol messages and admitted tool arguments, with no service credentials,
vault paths, database connection strings or client-side capabilities. Their
own host's filesystem and network policy remain the operator's responsibility.
Owner-only tools are hidden in public compartments and the broker checks the
persisted audience again at dispatch, including after approval.

A local, untrusted MCP server can run safely only under a separate OS identity
or sandbox, with no vault or database mounts or credentials, and behind a
verified network policy. Both the production adapter and the raw stdio
transport refuse a launch without that isolation, and
`production stdio cannot launch under the service OS identity` shows the
refusal happens before anything is spawned, so a production MCP server is an
HTTP endpoint, installed by the owner or pinned in the operator's connections
file. Composition likewise needs a cell executor
to run its script; the default service supplies none, so it does not offer the
composition tool. The `node:vm` executor exists for deterministic tests, refuses
to start outside them, and is not an OS or memory boundary.

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
server from the Docker gateway and therefore shares one client address. Sign-in
is by password alone. Distributed guessing below the account limit is slowed,
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
The broker, API and connectors share one trusted service process. It holds the
master key and decrypts credentials in ordinary process memory at dispatch, so a
compromise of that process, or of the host, exposes them.

Memory restrictions are checked in Postgres before recall, not merely in a
filesystem search index. `source and space revocation invalidate delivered
context and block stale serving` tests that boundary. The restriction journal
exists to gate memory restore: it records removals, not actions. The action
ledger is ordinary Postgres state, with no tamper-evident export. See
[MEMORY](MEMORY.md) for what forgetting reaches.

## Verification

Run from the repository root:

```bash
bun run compose:check
bun test apps/melete/src/connectors
```

The first command checks YAML only; the second uses temporary files, fake
transports and local protocol fixtures. The container probes run as scenario 6
when `MELETE_CONFORMANCE_COMPOSE=1` is set against a running Linux stack (see
[service conformance](../conformance/README.md)). The Linux deployment and
restoration checks use a scripted model and a test destination, so they
exercise Melete's side of each boundary rather than a live provider or an
external account.

## Browser worker boundary

The browser worker is a connector process outside the runtime cell. A hostile
page may influence the model's proposed actions, and a compromised Chromium or
worker process may read the selected space's browser profile. The controller,
broker, and container boundary have separate jobs:

- **Controller authority.** Every dispatched input carries its planned
  `control_epoch`. Takeover increments the epoch immediately, including while
  another action is waiting for a locator; the next input is refused by the
  controller. Handback increments it again and requires a fresh observation.
  The service parks the job as `waiting_for_input`. The local fixture test
  `controller refuses the second fill after takeover, and handback requires
  fresh observation` races a second fill against takeover and requires that it
  is refused with nothing submitted; `takeover during DNS is checked
  immediately before transport and refuses the queued POST` covers the network
  path.
- **Consequential effects.** Form commits use `browser.submit` through the broker's
  approval, intent-key, and trust-origin gates. The controller binds the observed
  form and outgoing request to that approved intent. Reversible inputs have no
  network budget; an approved submit has one matching mutation, and the fixture
  ledger must record no request the owner did not approve. Unknown commit
  outcomes are not replayed.
- **Page networking.** Chromium's direct networking is pointed at a fail-closed
  proxy, and trusted worker code relays checked requests. Public-address checks,
  pinned DNS transport, redirect checks, and the private-context domain allow-list
  apply there. WebSockets and service workers are denied. The public-web
  compartment does not reuse a signed-in private profile. The fixture transports
  must see no private-address traffic.
- **Space and process isolation.** The browser override mounts only
  `spaces/<space id>` at `/space`, runs uid 10003, and supplies no database URL,
  vault key, provider key, runtime capability, all-spaces mount, global artifacts
  root, or runtime work volume. It does not share the runtime or Postgres networks.
  The YAML tests deliberately add each forbidden mount, credential, network, or
  privilege and require the configuration check to reject it. The host operator
  creates and permissions the intended volume subdirectory.
- **Narrow worker listener.** The control network is shared only with the broker,
  no control port is published, and a separate worker token is required. The
  listener accepts bounded JSON requests for health, leases, semantic commands,
  release, takeover, and handback; it exposes no CDP or arbitrary code endpoint.
  Browser-originated requests are rejected. The owner-facing control routes use
  the service's existing authentication and same-origin protection.

The worker can reach the internet by design, for the person's authorised sites.
The relay policy constrains an intact worker; a compromised Node process can
use its own outbound sockets and can steal or alter its mounted browser profile.
It can read whatever the configured uid may read within that one mounted space.
It has no direct mount of the vault, runtime cell, or another space. The worker
is a container on the host kernel rather than a virtual machine, and Chromium
runs with its own renderer sandbox off (`--no-sandbox`, Playwright's default),
so a compromised renderer has the worker's access; a kernel compromise removes
the remaining boundaries.

Docker bridge membership is not directional. A compromised worker can reach the
Melete service ports on `browser-control`, even though it cannot directly join the
runtime or database network. The worker token grants no authority to those ports;
owner authentication and broker capability checks must continue to reject it.
Melete holds credentials in the same process as the API, so an exploitable
service bug remains a route to them.

Development on Windows uses a same-user child process with a restricted
environment, not an OS isolation boundary. Production requires an explicitly
configured isolated endpoint and never silently starts that development child.
The endpoint address is trusted operator configuration, not an attestation of
the remote deployment. Takeover supplies fencing and owner control routes. A
person may enter credentials on an operator-owned worker display using
`MELETE_BROWSER_HEADLESS=false`; Melete includes no remote desktop transport or
login interface for reaching that display. The network guard stays closed to
unbrokered requests during takeover, so a site sign-in cannot be completed
interactively through takeover. Recipes and episodes exclude authentication
factors, while Chromium's private profile may retain the cookies needed for a
warm signed-in session.

`bun run deploy/scripts/browser-compose-check.ts` checks deployment configuration;
the browser and integration tests check live controller behaviour on local
fixtures. Unlike the runtime cell, which scenario 6 probes from inside, the
worker's network boundary rests on that checked configuration: no conformance
scenario builds the browser image, starts the stack with the browser override,
or probes the worker's network from inside it. Installation and operation are
described in [browser-worker.md](browser-worker.md).
