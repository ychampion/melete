# Deployment operations

Start with the [README install procedure](../README.md#install-on-a-linux-docker-host),
or on a Windows machine with [Windows (Docker Desktop)](#windows-docker-desktop).
[Deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records image
sizes, build and startup times, conformance results and clean-host timing from a
measured installation. Timings depend on the host and network; the startup
timeout does not bound image builds.

## Docker Engine and Compose versions

Melete requires **Docker Engine 28.0 or newer** and **Docker Compose 2.33.1 or
newer**. The supervisor speaks Engine API 1.48, which
[Engine 28.0](https://docs.docker.com/engine/release-notes/28/) introduced
together with the `isolated` bridge gateway mode each attempt network uses.
[Compose 2.33.1](https://github.com/docker/compose/releases/tag/v2.33.1) added
`gw_priority` and needs Engine 28.0; volume `subpath` mounts are older, so
`gw_priority` sets the Compose floor.

The requirement is checked in three places, each with one message naming both
versions:

- The service, when `MELETE_RUNTIME_ADAPTER=docker`, asks the engine's
  unversioned `/version` endpoint over the mounted socket before it opens the
  database or anything else. An older engine, an engine that has dropped API
  1.48, or an unreachable socket stops startup; `docker compose logs melete`
  shows the message.
- `bun run deploy/scripts/configure.ts`, and the release's `upgrade.ts` run
  from its copy as [Upgrading](UPGRADING.md#before-you-start) shows, run
  `docker version` and `docker compose version` on the host and refuse an
  unsupported pair before writing or changing anything.
- `bun run doctor --docker` reports the same judgement on demand, and nothing
  else, so it suits a host that only runs the stack. `bun run doctor` judges
  the test prerequisites, and adds the Docker judgement whenever
  `MELETE_CONFORMANCE_COMPOSE=1` is set.

The same three places also judge the machine around the engine. An engine
running Windows containers is refused, and so, on Docker Desktop, is a VM with
less than 4 GB of memory. On Windows they add the checks in
[Windows (Docker Desktop)](#windows-docker-desktop).

The engine may also be on another machine, such as a rented Linux host reached
through `DOCKER_HOST` or a Docker context over `ssh://` or `tcp://` with TLS.
The three places then name that machine in one line. Compose mounts that
machine's `/var/run/docker.sock` and resolves bind mounts such as
`deploy/config` on it, so `configure.ts` measures the socket's group from a
container there, and the upgrade measures free space there.

## Windows (Docker Desktop)

A Windows machine running Docker Desktop hosts Melete with the same Compose
files, images and commands as a Linux host. You use it from a browser, on that
machine or, through the [Tailscale](#tailscale) override, from your other
devices.

### What the machine needs

- **Docker Desktop with the WSL 2 backend**, on a Windows version
  [Docker supports for it](https://docs.docker.com/desktop/setup/install/windows-install/),
  bringing Docker Engine 28.0 and Compose 2.33.1 or newer.
- **Linux containers**, Docker Desktop's default. Melete's images are Linux
  images; if Docker Desktop was switched to Windows containers, choose
  **Switch to Linux containers** from its menu.
- **At least 4 GB of memory for Docker Desktop's VM**, 6 GB with the browser
  worker: the warm runtime cell and each attempt may each use up to 2 GiB. Under
  the WSL 2 backend the VM's memory is set in `%UserProfile%\.wslconfig`, not in
  Docker Desktop:

  ```ini
  [wsl2]
  memory=6GB
  ```

  Run `wsl --shutdown` afterwards and start Docker Desktop again. Under the
  Hyper-V backend it is **Settings > Resources > Advanced**
  ([Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)).
- **10 GB free** on the drive that holds Docker Desktop's disk image
  (**Settings > Resources > Advanced** shows its location), 20 GB for rebuilds.
- **Git for Windows**, which includes Git Bash, and **Bun**.
- **A short path for the clone**, such as `C:\melete`. Windows limits a path to
  260 characters unless long paths are enabled, and the deepest file
  `bun install` writes sits about 175 characters below the clone's root. If the
  clone must live deeper, enable long paths from an administrator PowerShell,
  then sign out and in again:

  ```powershell
  New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem `
    -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  git config --global core.longpaths true
  ```

### Install

Run every command on these pages in **Git Bash**. They are Bash, and Git Bash
runs them unchanged, including the backup, restore and removal commands, and
provides the `mkdir`, `cp`, `sha256sum`, `chmod` and `df` programs that
`deploy/scripts/upgrade.ts` runs; started from PowerShell, the upgrade names
them and stops before changing anything. Install Bun from PowerShell once, then
open a new Git Bash window:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
git clone https://github.com/ychampion/melete.git /c/melete
cd /c/melete
bun install --frozen-lockfile
bun run doctor --docker
bun run deploy/scripts/configure.ts --fake
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 300
docker compose -f deploy/docker-compose.yml ps
```

Then open **http://localhost:3101** on the Windows machine and continue with the
README's [first run](../README.md#first-run).

`bun run doctor --docker` names anything on the list above that is missing:
Docker Desktop not running (nothing answers on its named pipe,
`//./pipe/docker_engine` by default, or the one `DOCKER_HOST` or the current
context names), Windows containers, too little memory for the VM, and a clone
too deep for the path limit, with the setting that lifts it. `configure.ts` and
`upgrade.ts` refuse on the same judgement.

Git Bash rewrites a command-line argument that starts with `/` into a Windows
path before a Windows program sees it: `/var/lib/x` reaches `docker` as
`C:/Program Files/Git/var/lib/x`. The commands on these pages pass container
paths only after a service name (`melete:/data`) or inside quotes, which it
leaves alone. For a command of your own that passes a container path on its own,
prefix it with `MSYS_NO_PATHCONV=1`.

### How the stack reaches Docker Desktop

The Compose files are unchanged. The `melete` service mounts
`/var/run/docker.sock`, and Compose passes that path to the engine as written
([compose-go](https://github.com/compose-spec/compose-go/blob/main/paths/unix.go)
keeps an absolute Unix path for a Windows client talking to a Linux engine).
Docker Desktop resolves it inside its VM, where the socket is
`srwxrw---- root root`: a process may use it when its user or one of its groups
is root ([Docker Desktop's socket permissions](https://github.com/docker/for-win/issues/13898#issuecomment-1934625891)).
The Windows host has no such file, so `configure.ts` starts one container from
the stack's pinned Postgres image, with no network, reads the socket's group and
mode as a container sees them, and writes that group as `DOCKER_GID`: `0` on
current Docker Desktop releases. The service is added to that group and
otherwise runs as its own unprivileged user. A socket only root may write to is
refused, because the service could not use it. On Linux with Docker Engine,
`configure.ts` reads the host's own socket as before.

The other host path in the Compose file, `./config`, is a Windows folder that
Docker Desktop shares into the VM; the service mounts it read-only. The
repository's `.gitattributes` keeps every script, Dockerfile and file the images
run with LF line endings on a Windows checkout, whatever `core.autocrlf` says,
and the images set the execute bit on their entrypoints when they are built, so
a Windows file system's modes never reach a container.

On Windows, `deploy/.env` takes the permissions of its folder rather than
owner-only ones. A clone under `C:\` or your user folder is readable by your
account and by administrators.

### Upgrade, backup and removal

`bun run deploy/scripts/upgrade.ts <tag> --dry-run` works as described in
[upgrading](UPGRADING.md). Its `mkdir -p -m 700 ~/melete-backups` creates the
default backup parent, `C:\Users\<you>\melete-backups`, in Git Bash as on Linux;
`--backup-dir` also takes a Windows path such as `C:/melete-backups`. Docker Desktop keeps images and
volumes on its VM's disk, so the upgrade measures the free space there, from
beside the database volume, rather than on a Windows drive.
[Backup and restore](#backup-and-restore) and the README's
[removal](../README.md#remove-it-completely) run as written in Git Bash.

## Configuration and browser access

Configuration lives in `deploy/.env`, generated once by
`bun run deploy/scripts/configure.ts --fake`. The file is private and is not
committed. Its default Compose project is `melete`; change `COMPOSE_PROJECT_NAME`
before first startup when using another project. Use that value consistently
so the supervisor finds the project's networks and work volume.

The default listeners bind to host loopback:

| Address | Service |
| --- | --- |
| `http://localhost:3101` | Web client and same-origin `/api` proxy |
| `http://localhost:3100` | Direct API |
| No host port | Postgres, broker, and runtime API |

Inside Melete, the owner API binds only to the IPv4 address resolved by
`MELETE_API_BIND=melete-api`. Compose assigns that alias only on the edge network;
the API does not listen on runtime or database interfaces. Its transport guard
also rejects requests outside the edge interface's subnet before reaching
`/setup`, `/login`, `/health`, or any other API route. The rejection is a fixed
403 without account state, based on the socket source rather than forwarded
headers. The runtime network can reach the broker/model listener on port 8788.

Sign-in and setup attempts are limited per client address, per account and per
known device; [Sign-in limits](#sign-in-limits) gives the exact rules, the one
header the API believes and from whom, and what a restart clears.

Use the SSH tunnel in the README for a remote host. For a public hostname,
terminate TLS in your reverse proxy and forward the whole site to
`http://127.0.0.1:3101`, preserving the request Host and Origin headers. Preserve
streaming responses without buffering or a short idle timeout. Set the exact
external origin in `deploy/.env`, for example:

```dotenv
MELETE_WEB_ORIGIN=https://assistant.example.net
```

Apply a changed environment with:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate web
```

`docker compose restart` does not apply changed environment values. The web
server rejects foreign Origins before proxying to its fixed upstream
`http://melete:8787`; it does not use request forwarding headers to select an
upstream or relax the origin check. Session cookies are `Secure` in production,
which browsers honour over HTTPS and on localhost, so reach a remote
installation through the SSH tunnel or a TLS proxy rather than over plain HTTP
to its address.

## Tailscale

Reach your installation from your own devices over your tailnet, with no
published port. An optional override runs one Tailscale node beside the stack.
The node joins your tailnet, answers HTTPS at its own tailnet address, and
forwards to the web client on the internal network. It publishes nothing on a
host interface, and Funnel stays off, so the address answers the devices on your
tailnet and nothing else.

The base Compose file is unchanged and the loopback ports stay published. The
tailnet address does replace the one you sign in at, though: a browser is
accepted at the address `MELETE_WEB_ORIGIN` names and at no other, so once that
holds the tailnet address, `http://localhost:3101` and the README's SSH tunnel
answer the sign-in page but refuse the requests behind it with 403
`origin_rejected`. One address at a time, and the step below chooses it. To go
back to the tunnel, empty `MELETE_WEB_ORIGIN` and recreate the web service with
the command below.

### Prerequisites

- **MagicDNS**, enabled for the tailnet. It publishes the node under a name, and
  that name is the address you open.
- **HTTPS certificates**, enabled for the tailnet. The node terminates TLS
  itself with a certificate issued for that name; without this the node joins
  but has no address to answer HTTPS on.
- **An auth key**, to join the node the first time.
- **A decision about who may reach the node**, if anyone else is on the tailnet:
  the default policy lets every member reach every device, so settle
  [restricting the node to yourself](#restricting-the-node-to-yourself) before it
  joins.

The first two settings are per tailnet and are turned on once, in the Tailscale
admin console under DNS.

### Create an auth key

In the Tailscale admin console, under Settings, generate an auth key. A reusable
key is not needed: the node stores its own key afterwards and rejoins with that.
Make the key **not ephemeral**, so the node keeps its name and its certificate
across restarts.

Paste it into `TS_AUTHKEY` in `deploy/.env`. It is a credential for joining your
tailnet, not for this installation, so treat it as you treat the other values in
that file: keep the file private, and do not paste the key into a shell where it
would be kept in history. Nothing in Melete logs or echoes it, and
`deploy/scripts/upgrade.ts` redacts it from command output like the other keys
in the file.

An OAuth client secret works in place of an auth key. It requires a tag, which
is given through `TS_EXTRA_ARGS`, for example
`TS_EXTRA_ARGS=--advertise-tags=tag:melete`.

### Configure and start

```bash
bun run deploy/scripts/configure.ts --tailscale
```

That writes `TS_HOSTNAME=melete` and leaves `TS_AUTHKEY` empty for you to fill
in. Pass `--tailscale-hostname` to choose another name; it becomes the node's
name and so the host part of the address. On an installation that already has a
`deploy/.env`, set `TS_HOSTNAME` and `TS_AUTHKEY` in that file by hand instead —
`configure.ts` never replaces an existing one.

Then start the stack with the override beside the base file:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml up -d --wait
```

Once the node reports healthy, record the address it answers on:

```bash
bun run deploy/scripts/tailscale-origin.ts
```

That asks the node for its certificate domain, writes
`MELETE_WEB_ORIGIN=https://<node>.<tailnet>.ts.net` into `deploy/.env`, and
prints the one command that gives the running web service the new value:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml up -d --no-deps --force-recreate web
```

This step is not optional. The web client accepts a browser whose `Origin` is
the address the installation is reached at and refuses any other, so until
`MELETE_WEB_ORIGIN` holds the tailnet address, signing in from that address is
refused — and once it does, signing in from `http://localhost:3101` is refused
instead. `docker compose restart` does not apply a changed environment value.

Name both files on every later Compose command for this installation, including
`deploy/scripts/upgrade.ts --tailscale`.

### From a phone or a laptop

Install Tailscale on the device and sign in to the same tailnet. Then open
`https://<node>.<tailnet>.ts.net` and sign in to Melete as usual. There is no
port to forward, no tunnel to keep open, and nothing to expose: the device
reaches the node over the tailnet, and the node reaches only the web service.

Sign-in is unchanged — a password, and a device cookie afterwards. Tailscale
identity is not a sign-in here; see [sign-in](#sign-in-limits) for what the
limits count, and [identity](#tailnet-identity) for why the tailnet name on a
request is not treated as one.

With the override in place each device on the tailnet is counted separately by
the per-address sign-in limits, rather than sharing one bucket as browsers
behind the SSH tunnel do. The node states the device's tailnet address, and the
web server believes it only on a connection from the node itself, which the
override names in `MELETE_WEB_TRUSTED_UPSTREAM`. A browser that sends the same
header from anywhere else is attributed to its own socket, as before.

### Restricting the node to yourself

A tailnet's default policy lets every member reach every device. If other people
are on the tailnet, restrict this node in the tailnet policy file. Tag the node
with `TS_EXTRA_ARGS=--advertise-tags=tag:melete`, then allow only yourself to
reach its HTTPS port:

```json
{
  "tagOwners": {
    "tag:melete": ["autogroup:owner"]
  },
  "grants": [
    {
      "src": ["autogroup:owner"],
      "dst": ["tag:melete"],
      "ip": ["tcp:443"]
    }
  ]
}
```

A tagged node is owned by the tag rather than by the person who joined it, so
the auth key or OAuth client that adds it must be allowed to use the tag.

### Kernel networking

The node runs userspace networking by default. It needs no `/dev/net/tun` and no
added capability, its root filesystem is read only, and it drops every
capability. Throughput is lower than kernel networking, which matters for large
transfers rather than for the client.

Kernel networking is a deliberate opt-in, added as a third file:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml \
  -f deploy/docker-compose.tailscale-kernel.yml up -d --wait
```

That file sets `TS_USERSPACE=false`, maps `/dev/net/tun` and adds `NET_ADMIN`.
It changes nothing else, and `bun run tailscale:compose:check` fails if it ever
grants more than those.

### What the node can reach

The node joins the `edge` network only. It cannot reach the database network or
the runtime network, and it has no Docker socket. The serve configuration in
`deploy/config/tailscale-serve.json` forwards the root of one host to
`http://web:3000` and proxies nothing else, so a device on the tailnet reaches
the sign-in page and whatever a signed-in browser can reach through it. The
[threat model](THREAT-MODEL.md) states this boundary.

`bun run tailscale:compose:check` asserts each of those properties from the
YAML: one added service, the `edge` network only, no published port, no
privilege or device outside the kernel-mode file, a pinned image, bounded logs,
sized temporary filesystems, the health endpoint on the container's own
loopback, the node key on a named volume, the auth key from the environment,
and Funnel off. It runs in the same continuous-integration job as the other
Compose checks.

### Streaming and idle connections

A transcript and a live browser view are long-lived event streams through
`/api`. Both hops keep them open: the node terminates HTTPS without a read,
write or idle timeout of its own and forwards an event-stream response as it
arrives rather than buffering it, and the web server disables its own timeout
for `/api` and passes the response through unchanged. A conversation left open
and quiet stays connected.

### Tailnet identity

Tailscale states the requesting user on a proxied request. Melete does not read
it: the sign-in is a password and a device cookie, and nothing about the tailnet
grants an account. The web server removes every `Tailscale-` header from every
request before it reaches the API, whichever socket it arrived on. Serve
rewrites the fixed set of names it owns and passes any other `Tailscale-`
header on as the browser sent it, so arriving through the node is not evidence
that the node wrote one.

Treating a tailnet identity as a sign-in is a possible later option. It would
mean deciding which tailnet user maps to which account, and what happens when a
device is shared, so it is a separate decision rather than a setting.

### Troubleshooting

**The node is healthy but there is no address.**
`bun run deploy/scripts/tailscale-origin.ts` reports no certificate domain while
the control plane has not issued one. Check that HTTPS certificates are enabled
for the tailnet, then wait for the node to finish joining and run it again. The
node's own view is:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml exec tailscale tailscale status
```

**Signing in is refused with `origin_rejected` and status 403.**
`MELETE_WEB_ORIGIN` does not match the address in the browser's address bar.
Run `tailscale-origin.ts` and recreate the web service with the command it
prints. `http://` instead of `https://`, or a short name instead of the full
tailnet name, is a mismatch; a trailing slash on the setting is not. On `http://localhost:3101`
this is the expected answer once `MELETE_WEB_ORIGIN` holds the tailnet address:
the setting names one address, and that one is now the tailnet's.

**The address resolves but nothing answers.** The node forwards to the `web`
service by name, which needs Docker's resolver, so the override sets
`TS_ACCEPT_DNS=false`. Check that both files were named on the `up` command and
that `web` is healthy.

**The node asks to authenticate again after a restart.** Its state volume is
missing. `tailscale-state` holds the node key; recreating the installation
without it means joining again with a fresh auth key. The
[upgrade](UPGRADING.md) notes that keeping it is optional.

**Funnel.** Confirm it is off with:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml exec tailscale tailscale funnel status
```

## Sign-in limits

Every limit below lives in the memory of the one Melete process. Restarting
Melete clears all of them at once: waits end, bursts are full again, and nothing
is written to Postgres. Each limiter holds at most 1024 keys; further keys share
one overflow bucket, so new keys can neither evict a live wait nor grow memory.

**Whose address counts.** The web proxy sets `X-Melete-Client-Address` on every
request it forwards to the API. The value is the proxy's own socket peer and
replaces anything the browser sent; the proxy still drops `Forwarded` and
`X-Forwarded-*`. The API believes that header only when the connection itself
comes from the peer named by `MELETE_TRUSTED_PROXY`, and only when it holds one
well-formed address. Compose sets `MELETE_TRUSTED_PROXY=web`, the web service on
the edge network, and `bun run compose:check` fails if it names anything else or
if `web` joins another network. The name is resolved when needed and remembered
for 30 seconds (5 seconds while it does not resolve, as before the web
container has started), so a recreated web container is followed without a
restart. From every other peer, including the direct API port 3100, the header
is ignored and the socket source is used; no other forwarding header is read.
Left unset, as in local development, no peer is believed. A spoofed header
therefore cannot mint fresh buckets.

With the default loopback ports, the README SSH tunnel, or a TLS reverse proxy
on the host, the web server's socket peer is the Docker gateway, so all browsers
still arrive as one address and the per-address limit below is shared between
them. The known-device rule is what keeps a sign-in available in that case.

**Per client address.** A burst of five attempts, then 1, 2, 4, up to 60
seconds between attempts. A refusal is 429 `login_rate_limited` with
`Retry-After`. For a request without a valid device cookie it is returned
before the body is read; every refusal described here comes before the database
is read or a password is checked. A successful sign-in, or 15 minutes after the
last admitted attempt, restores the burst. A refused request changes nothing: it
neither lengthens the wait nor postpones the reset.

**Per account, for browsers that are new to it.** Every browser without a known
device for the account shares one limiter per account: a burst of ten attempts,
then the same 1 to 60 second backoff and the same 15-minute reset. A successful
sign-in hands back the one attempt it reserved and clears nothing else, so the
limiter counts wrong passwords: correct sign-ins never close it, and one person
signing in does not reopen it for the rest. While it is closed, a correct
password from a new browser also receives 429; at most one attempt per 60
seconds is admitted at the cap.

**Known devices.** A successful sign-in or setup sets `melete_device`
(`HttpOnly`, `SameSite=Strict`, `Secure` in production, 90 days). It holds a
keyed digest of the email, a random identifier, an expiry and an HMAC-SHA-256
signature under a key derived from `MELETE_MASTER_KEY`. It never authenticates
anyone. A browser presenting a valid cookie for the account it is signing in to
skips the address and account limiters and spends its own budget of five
attempts with the same backoff. Requests from other browsers, at the same or any
other address and however many, cannot make that sign-in fail. A cookie for another account, an expired one, or
one that does not verify earns nothing, and the request is limited as a new
browser. Because the key comes from `MELETE_MASTER_KEY`, known devices survive a
restart; changing that key, or running without one as in development where the
key is random per process, makes every browser new again.

**Setup.** `/setup` answers 409 `already_setup` before it parses or hashes
anything once an owner exists. It has its own per-address limiter (burst of
five, the same backoff, 429 `setup_rate_limited`) that spends no sign-in budget.

**Unknown emails.** A sign-in for an email without an account, or an account
without a password, runs the same argon2id verification against a placeholder
hash and returns the same 401, so response time does not reveal which emails
have accounts.

## Providers

The `--fake` configuration is the reproducible local demonstration: no provider
key is required, and sends go to the test destination. To configure a real
provider, edit `MELETE_DEFAULT_PROVIDER`, `MELETE_DEFAULT_MODEL`, and the matching
credential in `deploy/.env`. Disable `MELETE_ENABLE_FAKE_PROVIDER` and
`MELETE_ENABLE_TEST_CONNECTOR` when those fixtures are no longer wanted.

`MELETE_DEFAULT_PROVIDER` is one of exactly these names:

| Provider | Credential | Protocol the runtime is told to speak |
| --- | --- | --- |
| `fireworks` | `FIREWORKS_API_KEY` | chat completions |
| `anthropic` | `ANTHROPIC_API_KEY` | messages |
| `openai` | `OPENAI_API_KEY` | responses |
| `google` | `GOOGLE_API_KEY` | chat completions |
| `chatgpt` | the owner's ChatGPT sign-in | responses |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY`, or OAuth sign-in | chat completions; responses for `gpt-6` models |

Any other name stops the service at start-up with a message naming the setting,
and so does `openai-compatible` without a usable `OPENAI_COMPAT_BASE_URL`. An
OpenAI-compatible endpoint is always selected as `openai-compatible`, whatever
software serves it; the name of that software is not a provider name. A selected
provider with an empty key starts with a warning on the service log, and the
gateway refuses each model call with `provider_key_unavailable` until the key is
set. `configure.ts` without `--fake` prints the same warning when it writes
`deploy/.env`, because the file it writes selects a real provider with its key
still empty.

`MELETE_DEFAULT_MODEL` is the identifier the provider serves, written exactly as
its API expects it. Fireworks identifiers are full account paths; the default is
`accounts/fireworks/models/deepseek-v4p1-flash`. The gateway admits only the
model a job was started with, so a shortened name is refused by the provider,
not corrected.

`OPENAI_COMPAT_BASE_URL` is the endpoint's version prefix, for example
`https://models.example.net/v1`. It is the only provider address that may be
plain `http://`, for a model server on your own machine or network; every
built-in provider stays HTTPS. Over `http://` the key and every prompt travel
unencrypted, so keep it to a network you trust. Inside Compose, `localhost` is
the Melete container itself, so give an address that container can reach. The
gateway refuses a provider whose key is empty: for a server that checks no key,
set `OPENAI_COMPAT_API_KEY` to any non-empty value. Left empty, an `https://`
endpoint falls back to `OPENAI_API_KEY`; a plain `http://` endpoint never
receives `OPENAI_API_KEY`.

`MELETE_DEFAULT_MAX_OUTPUT_TOKENS` (default `4096`) is the output limit the
gateway gives a model request that names none. The runtime names none unless its
own configuration sets one, so this is the usual ceiling on one reply; a few
hundred tokens truncates ordinary answers. The limit is reserved against the
job's output budget until the call settles at its real usage, and it is lowered
to what the job has left rather than refused. A limit the runtime does name is
never rewritten: it is honoured, or refused when it exceeds the job's budget.

### Signing in to a provider

A sign-in is an alternative to a key for two providers. OpenAI models are
reached either with an API key, as `openai` with `OPENAI_API_KEY` and billed per
use, or with the owner's ChatGPT account, as `chatgpt`, drawing on that
account's plan; pick one with `MELETE_DEFAULT_PROVIDER`. An OpenAI-compatible
endpoint takes either `OPENAI_COMPAT_API_KEY` or, when its OAuth settings are
given, a sign-in. Signing in needs `MELETE_MASTER_KEY`, which seals the tokens the provider
issues. Only the setup owner can sign in or out, and one sign-in serves the
whole installation.

**ChatGPT.** To use it instead of an OpenAI key, set
`MELETE_DEFAULT_PROVIDER=chatgpt` and `MELETE_DEFAULT_MODEL` to a model the
account's plan serves, then sign in. Model access and usage limits
are those of the ChatGPT plan. The sign-in follows the flow of the open-source
Codex CLI and presents its public client, which `MELETE_CHATGPT_CLIENT_ID`
replaces when set. ChatGPT sign-in works for as long as OpenAI keeps this
sign-in open to apps other than its own. It offers two methods:

- **Device code** (the default). Melete shows a short code and a link to
  `auth.openai.com`; open the link on any device, sign in and enter the code.
  Melete checks for completion at the interval the provider asks for.
- **Browser.** Melete returns an address to open. After you approve, the browser
  is sent to `http://localhost:1455/auth/callback`, which does not load, because
  that address is the only one registered for this sign-in. Copy the whole
  address from the address bar and give it to Melete to finish.

**An OpenAI-compatible provider with OAuth.** For an endpoint whose provider
issues OAuth access tokens, register a redirect address with that provider and
set:

| Setting | Value |
| --- | --- |
| `OPENAI_COMPAT_OAUTH_ISSUER` | The issuer; its authorize, token and revocation addresses are read from its metadata |
| `OPENAI_COMPAT_OAUTH_AUTHORIZE_URL`, `OPENAI_COMPAT_OAUTH_TOKEN_URL` | Both, instead of the issuer, for a provider that publishes no metadata |
| `OPENAI_COMPAT_OAUTH_REVOKE_URL` | Optional; where sign-out revokes the grant |
| `OPENAI_COMPAT_OAUTH_CLIENT_ID` | The client registered with the provider |
| `OPENAI_COMPAT_OAUTH_CLIENT_SECRET` | Only for a confidential client |
| `OPENAI_COMPAT_OAUTH_SCOPES` | Space-separated, as the provider names them |
| `OPENAI_COMPAT_OAUTH_REDIRECT_URL` | The registered redirect address |
| `OPENAI_COMPAT_OAUTH_LABEL` | The provider's name on the sign-in button |

Every sign-in uses PKCE and a one-time state. With these set, the signed-in
token is sent to `OPENAI_COMPAT_BASE_URL` in place of `OPENAI_COMPAT_API_KEY`.
Provider addresses must be `https://`, or `http://` on `localhost`. A partial
setting stops the service at start-up with the name of what is missing.

**The sign-in routes.** Each takes the owner's session:

| Route | What it does |
| --- | --- |
| `GET /model-providers/sign-in` | Each provider's name, state (`signed_out`, `pending`, `signed_in` or `sign_in_required`) and, when there is something to do, a sentence saying what |
| `POST /model-providers/{provider}/sign-in` | Starts a sign-in; `{"method": "browser"}` picks the browser method |
| `POST /model-providers/{provider}/sign-in/complete` | Finishes it: `{"sign_in_id": ...}`, plus `"callback_url"` for the browser method. A device sign-in answers `202` until the code is entered |
| `DELETE /model-providers/{provider}/sign-in` | Signs out: removes the tokens and asks the provider to revoke them |

An unfinished sign-in expires after fifteen minutes, and starting another
replaces it. Unfinished sign-ins are held in the service's memory, so a restart
ends them.

**Refresh.** The gateway refreshes the access token before it expires, five
minutes early or at half its lifetime, whichever is sooner, and once per
provider at a time across the whole service. A token the provider refuses is
refreshed on the next call. When the provider refuses the refresh itself, the
tokens are removed, the state becomes `sign_in_required` with a `reason`, the
service log names the provider and the reason, and each model call to that
provider is refused with `provider_sign_in_required` until the owner signs in
again. While the provider cannot be reached, a token that has not yet expired
keeps serving; once it expires, calls are refused with
`provider_credential_unavailable` until a refresh succeeds.

Provider secrets belong to Melete's gateway. Runtime cells receive short-lived
capabilities and surrogate credentials. Do not copy a provider key into a
runtime environment. Configuration fields are listed in
[`deploy/.env.example`](../deploy/.env.example).

After changing provider settings, recreate Melete and the warm runtime:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

### Memory model

Melete reads what each person says in chat and keeps what matters in their
memory. It uses the default provider and model through the same gateway, so the
provider key stays in the gateway. `MELETE_MEMORY_MODEL` names a different model
for this (a smaller one is usually enough), with `MELETE_MEMORY_PROVIDER` when it
is served by another provider; `MELETE_MEMORY_MODEL=off` stops model reads and
keeps structured observations only. `MELETE_MEMORY_DAILY_CALLS` (default `200`)
is how many reads one person's memory may make in a day; raise or lower it for
your provider's cost. A call the provider answers with an error does not count;
a call that was sent and timed out does. When the budget is spent, or the
provider fails, limits or times out, the conversation carries on and the message
waits unread: it is tried again 30 seconds later, then after a gap that doubles
each time, up to 30 minutes, for at most 8 tries or a day. A call that asking
again cannot fix (too large for the model, or a request the provider refuses,
such as a model name it does not serve) ends the message at once. The service
log records each of these as `memory: <reason>`, and `/health` reports
`memory.waiting` and `memory.failed` (messages given up in the last day).

## Engine limits

Three settings bound what one attempt's engine may do. All have working
defaults; change them only for a reason you can name. Set them in `deploy/.env`
and recreate the service with
`docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete`;
each applies from the next attempt started.

`MELETE_ENGINE_MAX_TURNS` (default `150`) is how many iterations one run may
take before the engine stops it. It is a runaway stop, not a cost control: what
an attempt may spend is decided by the job's budget, and a run that has taken
150 turns is looping. Lower it and long legitimate work is cut off in the
middle; raise it and a loop runs longer before anything notices.

`MELETE_COMPACTION_MAX_TOKENS` (default `200000`) is the largest conversation,
in tokens, that may build up before the engine summarises it and carries on with
the summary. The engine would otherwise wait for half the model's context
window, which on a million-token model means every request carries half a
million tokens before the first summary is written. The trigger actually used is
the lowest of this number, the engine's own trigger for that model's window, and
what keeps a request inside the body the gateway accepts — so a number larger
than the model allows changes nothing. Each compaction costs one extra model
call, and a summary is lossy by nature: every durable fact stays on the job's
ledger, not in the conversation.

`MELETE_MODEL_CONTEXT_WINDOW` (no default) is the context window, in tokens, of
the models this deployment serves. Set it when a model is smaller than the
128,000-token figure Melete assumes for a model it does not know: a model with a
32,000-token window would otherwise be told to compact at 96,000, never get
there, and have every request past its own window refused by the provider with
nothing summarised. For a model Melete does know, this may lower the window and
not raise it, because the same catalog figure is what the model gateway's
accounting is keyed on.

## Memory extraction

Deployment memory can extract structured observations without a model. If
unstructured work has no extraction gateway, it stops at the third total claim
with status `rejected` and error `no_extraction_gateway` in `memory_work`.
Queue repair and duplicate deliveries do not restart that terminal work, and an
extraction gateway configured afterwards applies to new work only: evidence
already rejected stays rejected.

## Isolation and image provenance

The trusted `melete` service has the Docker socket so it can supervise attempt
containers. Possession of that socket belongs inside the trusted host boundary.
The runtime cells have no socket, run as UID 10001, and use a read-only root
filesystem, dropped capabilities, and resource limits.

Each attempt mounts only its job's subdirectory from the work volume at `/work`.
It has a separate internal network whose only service peer is Melete's broker
and model proxy, and retains Hermes state on a named volume. The warm `runtime`
service uses the `_probe` subdirectory and has no valid job capability.
Linux's isolated bridge mode removes the bridge's host address; live probes,
not the Compose configuration checker alone, establish the network result.
Those probes cover a Linux Docker host, which is the host this page describes;
macOS, Windows and rootless Docker hosts are outside them, as is a kernel
exploit. See the [threat model](THREAT-MODEL.md) for the boundary and what
rests on it.

Plugins and other stdio MCP servers run in containers the same service starts
through the same socket, one per connection, with a volume of their own and no
network unless their owner named a destination; [CONNECTORS](CONNECTORS.md#where-a-server-runs)
describes each restriction. The service pulls their images on first use, so
the host needs to reach the registries the catalog names. These settings
change them; the defaults need none:

| Setting | Default | What it chooses |
| --- | --- | --- |
| `MELETE_MCP_NODE_IMAGE` | `node:22-alpine`, pinned by digest | The image `npx` plugins run in |
| `MELETE_MCP_PYTHON_IMAGE` | `ghcr.io/astral-sh/uv:0.12.17-python3.12-alpine`, pinned by digest | The image `uvx` plugins run in |
| `MELETE_MCP_EGRESS_PORT` | `8789` | The port, inside the service container, of the proxy a plugin with named destinations uses |
| `MELETE_MCP_IDLE_MS` | `600000` | How long a plugin may sit unused before it is stopped |

The runtime build asserts that Hermes tag `v2026.9.7` resolves to commit
`2237be355906fbe6065ce1815711eee52b2d646e`. It also asserts the plugin content
SHA-256, installs the locked Python dependencies, and records both values in
image labels and `/opt/melete-runtime/build-info.json`. Base images and the uv
binary are pinned by digest. Read the built image's labels and copy its inventory:

```bash
docker image inspect melete-runtime:local --format '{{json .Config.Labels}}'
docker compose -f deploy/docker-compose.yml cp runtime:/opt/melete-runtime/sbom.cdx.json ./runtime-sbom.cdx.json
```

The SBOM is a CycloneDX inventory of the Python and OS packages in that image.
These checks reproduce source identity and enforce dependency locks. Image
digests can differ between builds, because OS package repositories, build
timestamps and build tooling change the resulting bytes; compare the recorded
labels and inventories when rebuilding.

## Upgrading

[Upgrading between releases](UPGRADING.md) is its own page: the target
release's `deploy/scripts/upgrade.ts`, taken out of its tag, prints the whole
plan with `--dry-run`. The service migrates its database at every boot under an advisory lock, so the
procedure is a consistent backup, a checkout, a rebuild and a wait for health;
the backup below is its first half.

## Logs

Docker's default `json-file` log has no size limit. Every Compose service, and
every attempt container the supervisor starts, instead rotates a `json-file` log
at 10 MB and keeps five files, so one container holds at most about 50 MB of
log on the host. Read them with Compose:

```bash
docker compose -f deploy/docker-compose.yml logs --since 1h melete
```

The limits live in the `x-logging` anchor at the top of
`deploy/docker-compose.yml`; a changed limit applies when a container is
recreated, not on restart. `bun run compose:check` and
`bun run browser:compose:check` refuse a service without the bound. Logs that
must outlive rotation belong in a log collector you run beside the stack.

## Backup and restore

Back up `deploy/.env`, Postgres, and the named volumes containing knowledge,
artifacts, workspaces, and restrictions. Preserve ownership and permissions.
Stop Melete and runtime work before taking the database and volume snapshot so
their durable state is consistent. An installation started with an override
names the same files on each Compose command below, and one running the browser
worker stops `browser` with the others, since it writes into a space. From the
repository root:

```bash
backup_dir="$HOME/melete-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup_dir"
docker compose -f deploy/docker-compose.yml stop melete runtime web
docker compose -f deploy/docker-compose.yml exec -T postgres sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$backup_dir/database.dump"
cp -p deploy/.env "$backup_dir/deploy.env"
docker compose -f deploy/docker-compose.yml cp -a melete:/data - > "$backup_dir/data.tar"
docker compose -f deploy/docker-compose.yml cp -a melete:/work - > "$backup_dir/work.tar"
chmod 600 "$backup_dir"/*
docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 180
```

The [Compose copy command](https://docs.docker.com/reference/cli/docker/compose/cp/)
uses archive mode to retain ownership. The `/data` archive includes spaces,
artifacts, and the current restriction
journal. Keep a current independent journal copy as described below. Runtime
attempt homes are disposable; jobs recover from Postgres into fresh attempts.

The `restrictions` volume must be retained **independently of older database
snapshots**. It contains the append-only removal journal. When restoring an old
database, pair it with the newest retained journal; restoring an old journal
alongside the old database would also roll back later removals.

Melete's normal startup replays the retained restrictions before opening memory
serving and starting job workers. Missing or invalid retained restrictions keep
the restore gate closed. A health failure is an error to investigate, not a
reason to recreate an empty journal.

Restore the database archive into an **empty database volume**, while retaining
the other volumes and the original `.env`. Do not use `pg_restore --clean` over
the running queue schema: pg-boss partition foreign keys make that a different,
unsupported restore path. Start the normal Compose service only after the
database restore finishes, then verify its health and any waiting job's approval
before deciding it.

To exercise that restore boundary on the disposable `--fake` installation used
for conformance, run:

```bash
MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-restore.ts
```

This creates a waiting approval and two memory facts, takes a `pg_dump`, forgets
one fact after the snapshot, stops the stack, and replaces only its verified
Postgres volume. It restores the dump into an empty database while keeping the
other volumes, including the newer restriction journal. Before startup, its
verification command rejects the database because replay is missing. It then
starts Melete normally and verifies that the
forgotten fact stays absent, the unrelated fact remains, and the waiting job
finishes with exactly one destination receipt.

Each run writes a private directory under `/tmp/melete-compose-restore` containing
`database.dump` and `evidence.json`. Use `--output-dir /path/to/private-backups`
to choose another parent directory. [Deployment note 0020](../.agents/notes/0020-deployment-evidence.md)
records a measured run and its evidence.

## Removing a space

The owner of a space removes it over the API, with the owner's session cookie.
The request carries the space's name, typed exactly as it is shown, and a
member of the space receives `403`. The request and response types are in
`openapi.json` and the typed client.

| Request | Answer |
|---|---|
| `GET /spaces/{id}/removal/preview` | What the space holds, the services whose keys it uses, and the sentence to confirm |
| `DELETE /spaces/{id}` with `{"confirm_name": "<name>"}` | `202` and the removal; `400` when the name does not match; `409` for the browser worker's space |
| `GET /spaces/{id}/removal` | How far the removal has got, while the space is there |
| `GET /removals/{id}` | The removal and its account, including after the space is gone, for the person who asked |

The space closes inside the request: its work is cancelled, its triggers stop
and its memory stops serving. The rest runs in the background, one phase at a
time: access for every member ends, the removal is written to the restriction
journal, then the space's files go (the space directory with its repository and
history, and each job's workspace), then its rows (work, artifacts, knowledge
records, skills, the companies map, connections and their sealed keys, and
memory). A final count then checks every table, every path and every provider
the space used. The removal reads `complete` only when that count finds nothing
left, and only then is the space row deleted. The runtime removes each attempt's
home volume when the attempt ends, so a removal finds none of those to clear.

A personal space is emptied rather than removed. It keeps its id, its owner
stays signed in, and it comes back with a fresh, empty repository.

Asking again while a removal runs returns the same removal.

The space named by `MELETE_BROWSER_SPACE` cannot be removed while the browser
worker uses it, because the worker mounts that space's directory. Point the
setting at another space and restart the browser worker first.

The job queue can keep the ids of a removed space's jobs and triggers, with no
content, until its own retention clears them; trigger schedules are resynced
within about a minute.

### A blocked removal

When a phase cannot finish, or the final count finds something left, the removal
reads `blocked`, and `blocked_reason` names the provider, path or table. The space
stays closed. Melete tries again a few seconds later, then at growing intervals of
up to a few minutes, going through the whole sweep again, so a removal finishes by
itself once its cause is gone. Before it removes a job's workspace it stops that
job and waits for it to let go. A path named in the reason is usually held open by
another process; stop that process and the next pass removes it.

A personal space opens again as soon as everything in it has gone, even while a
job that was running still holds its workspace open. The removal then reads
`cleaning`, names that workspace, and removes it once the job lets go; it touches
nothing else, so the space can be used in the meantime.

### Removal and backups

The removal is written to the restriction journal before anything is deleted.
Restoring a database snapshot from before the removal, with the current journal,
brings the space's rows back only until startup: the replay closes the space
again, cancels the work that came back with it, and the removal runs to the end.
This holds for every removed space, and for a personal space emptied after the
snapshot was taken; a personal space emptied before it, and used since, is left
as it is. This is one more reason to keep the journal apart from database
snapshots, as described in [Backup and restore](#backup-and-restore).

### What stays at other services

Messages that were sent, files copied elsewhere and pages published to another
service stay where they went. App passwords and connection keys keep working at
the service that issued them until they are revoked there; the preview names
each of those services.
