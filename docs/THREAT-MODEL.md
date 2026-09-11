# Threat model

Melete reads your email, fetches web pages, and acts on your behalf. This
document names the attackers and says, for each one, what v0.1 actually
contains and what it does not. Where a boundary is weaker than it sounds, that
is stated rather than implied away.

The general shape: **the model is never the boundary.** Every rule below holds
whether the model cooperated or not, because it is enforced by something the
model cannot reach.

---

## Attacker 1: hostile content in email or on a web page

Someone sends you a message, or you point Melete at a page, containing text
written to be read as instructions. This is the attack Melete is most likely to
meet, because it needs no access to your machine at all.

**Contained in v0.1: mostly.**

What contains it:

- **The runtime has nowhere to send anything.** Its container sits on a network
  declared `internal: true`, so there is no default route in the kernel. A model
  persuaded to exfiltrate cannot open a socket to do it.
- **Every effect is a proposal, not an action.** Injected text can make the model
  propose sending your inbox to an attacker. The broker canonicalises that
  proposal, classifies it as an external write, and requires an approval bound to
  its exact payload hash. You see the recipient and the body before anything
  leaves.
- **The approval screen is built from the action record.** Model text never
  renders as an approval prompt, so injected content cannot dress itself up as a
  system message. Markdown the model produced renders sanitised, in a sandboxed
  frame with a null origin, with no scripts and no external loads.
- **Scopes filter the catalog before the model sees it.** A job with no email
  scope has no email tool in its context, so there is nothing for the injection to
  aim at.
- **The public-web compartment.** A job fetching arbitrary URLs carries no private
  knowledge in its context. A job that does carry private context may fetch only
  allow-listed domains. Query strings are logged in the ledger.
- **Budgets and turn caps.** An injection that tries to loop runs out of the
  attempt's allowance and stops.

What is not contained:

- **An injection can waste your attempt and lie to you in its summary.** Nothing
  stops the model producing a plausible, wrong account of what it did. The
  defence is that claims are checkable: the action ledger and the receipts are the
  record, not the prose.
- **Approval fatigue is a real attack.** A stream of plausible approval requests
  is a way to get one bad one through. v0.1 does not rate-limit approvals or
  cluster them, and it should.
- **Inbox hygiene is best-effort.** Retrieval filters what looks like one-time
  codes and password resets using regular expressions and sender heuristics. Treat
  it as a speed bump. A determined sender can word around it.
- **Read-only damage still counts.** An injection can steer what Melete reads and
  therefore what it concludes and writes into knowledge, without any external
  effect at all.

---

## Attacker 2: a malicious skill file

You install a skill from somewhere, or an agent proposes one. It contains
instructions designed to make the assistant act against you.

**Contained in v0.1: partly. This is the weakest of the four.**

What contains it:

- **A skill cannot grant capability.** Skills are text. The tool catalog comes
  from connector manifests filtered by the job's scopes, so a skill that names a
  tool the job does not have gets nothing. It cannot add a connection, widen a
  scope, or bypass an approval.
- **Every effect still passes the broker.** A skill instructing "send this without
  asking" changes nothing: external sends require approval bound to the payload
  hash, and that check is in the service, not in the prompt.
- **Skills are short and readable.** The token cap is 400 and the format is plain
  Markdown with frontmatter. A malicious skill is a document you can read in under
  a minute, unlike a compiled dependency.
- **Initial selection is deterministic.** Triggers are matched by string.
  On-demand discovery can load a skill the model requests, but the broker filters
  it by the current job's scopes and withholds space skills in the public
  compartment. A requested skill never supplies its own authority.

What is not contained:

- **A skill loads into the system prompt with the same standing as the identity.**
  Within the capabilities the job already has, a malicious skill is a persistent
  instruction to misuse them. If the job may send email, a skill can shape what it
  drafts and to whom, subject to your approval.
- **There is no signing, no provenance, and no review for skills.** v0.1 has no
  marketplace, which limits the blast radius by accident rather than by design.
- **A proposed skill is a knowledge write, and knowledge writes are mediated.**
  That helps, but a person who clicks through a diff without reading it has
  approved it.

Practical advice: read a skill before installing it, the way you would read a
shell script before running it.

---

## Attacker 3: a compromised model provider

The provider serving your model is hostile, compromised, or subject to an order
you do not know about. It can read every prompt and shape every response.

**Contained in v0.1: not really, and this is inherent.**

What contains it:

- **The provider sees only what the attempt bundle contains.** Context is bounded
  by contract: an identity under 250 tokens, at most three skills, at most 2,000
  tokens of knowledge, a bounded transcript. It never sees your whole knowledge
  base, your credentials, or your database.
- **A hostile response is still just a proposal.** The provider can make the model
  ask to send anything anywhere. It cannot make the broker admit it. External
  effects need your approval against the exact payload.
- **What actually served the request is recorded.** The gateway reads the model
  from the response body, not the request, so a provider silently substituting a
  cheaper model shows up in the attempt row.
- **You can change providers.** Melete is model-agnostic on purpose. The
  recommended default is DeepSeek V4.1 Flash on Fireworks, and any
  OpenAI-compatible endpoint works, including a model running on your own machine,
  which removes this attacker entirely.

What is not contained:

- **Everything in the context is disclosed to the provider.** That is what sending
  a prompt means. If a knowledge excerpt is in the bundle, the provider has it.
- **A provider can steer the work subtly.** Slightly wrong summaries, a nudged
  recommendation, a plausible but wrong fact. Approval catches sends, not
  judgment.
- **OAuth tokens for subscription providers live in the runtime's own auth
  store** in v0.1, unlike API keys, which are held by the gateway and injected. A
  compromise of the runtime container therefore exposes an OAuth token but not an
  API key. This is a real asymmetry and it is why API keys are the recommended
  path.

Practical advice: for anything genuinely sensitive, run a local model through the
OpenAI-compatible endpoint.

---

## Attacker 4: a compromised runtime container

Assume the worst: an attacker has code execution inside the runtime container.

**Contained in v0.1: yes at the network and credential level, no at the kernel
level.**

What contains it:

- **No route out.** The container is on the internal network only. There is no
  path to the internet, to the host, or to any sibling service on the edge
  network. The conformance suite checks the internet, the Postgres port, the host
  metadata address, and a sibling path from inside the container.
- **No credentials to steal.** The runtime holds no database connection string, no
  provider API keys, and no connection secrets. Provider keys are injected by the
  gateway on the way out; connection secrets never leave the service process.
- **No standing authority.** The capability token is scoped to one job, one
  attempt, one epoch, one revision, with a budget and an expiry. When the epoch
  moves, the token is dead. It cannot create a job, widen a scope, or approve
  anything.
- **Effects still need approval.** A fully compromised runtime can propose. It
  cannot admit.
- **A small surface.** Non-root, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`, process and memory limits, and `/work` as the only
  mount.

What is not contained:

- **The kernel is shared with the host.** This is a container, not a virtual
  machine. A kernel exploit is a host compromise, and at that point every other
  boundary in this document is gone. A Firecracker microVM is the target and
  gVisor is the documented intermediate step; neither is in v0.1.
- **`/work` is a real volume.** Whatever is in the workspace is readable and
  writable, including anything a previous job put there.
- **The broker is reachable, by design.** A compromised runtime can propose
  endlessly, consume budget, and fill the ledger with noise. That is a denial of
  service against your own assistant.
- **The broker runs in the same process as the API.** A bug in the broker's
  admission path is a bug in a process that does hold the credentials. Splitting
  them into separate processes with separate database roles is planned, not
  shipped.

---

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

## Things that are nobody's fault and still your problem

- **The operator of the machine sees everything.** There is no confidential
  compute. If you do not control the host, you do not control the data.
- **The master key is the whole of encryption at rest.** Lose it and every
  credential must be re-entered. Leak it and the encryption bought you nothing.
- **v0.1 has never been installed anywhere but a development machine.** Do not
  connect it to an account you cannot afford to have misused.
