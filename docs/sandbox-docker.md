# A computer for every agent, on your own Docker engine

The `docker` sandbox provider gives each agent a Linux computer of its own: a
container on the same Docker engine that runs the rest of Melete, with a shell,
Python, git, the usual command-line tools, and a desktop with a browser on it.
The agent runs commands there, reads and writes files there, and looks at and
drives the desktop. You can watch the desktop while it works and take it over.

It needs no account and no key. Commands, files and screenshots stay on your
machine. Every command and every desktop action is still a brokered action with
a receipt, and anything that reaches outside through a connector, such as
sending mail, still asks you first.

## Turn it on

With the Compose deployment from [DEPLOYMENT.md](DEPLOYMENT.md), add one line to
`deploy/.env` (`configure.ts` has already written `MELETE_SANDBOX_PROJECT`):

```sh
MELETE_SANDBOX_PROVIDER=docker
```

Then build the image and recreate the service:

```sh
docker compose -f deploy/docker-compose.yml --profile sandbox up -d --build --wait --wait-timeout 300
```

`--profile sandbox` builds `melete-sandbox:local` from `deploy/Dockerfile.sandbox`.
An installation on [prebuilt images](DEPLOYMENT.md#using-prebuilt-images) pulls
the published `melete-sandbox` image instead: run `pull` and `up -d --no-build`
with the same `--profile sandbox`, or `deploy/scripts/update.sh --profile sandbox`.
It starts from the runtime image's own base, so it adds about 1 GB of disk for
the desktop and the browser. Every space then has a sandbox connection called
**Computer**, and every agent in it gets its own container the first time it
needs one.

To use another image, build it and set `MELETE_SANDBOX_DOCKER_IMAGE`; it must
already be on the engine. A space's owner can also add a docker sandbox by hand
in Settings → Connections → Sandbox, choosing "This server (Docker)" and leaving
the key empty.

## One container per agent

A container belongs to one agent in one space. Its files persist between that
agent's jobs, so work carries on where it stopped. Two agents never share
processes, files, a desktop or a browser profile, and two jobs never fight over
one mouse. A second job for the same agent that asks while the first still
holds the container is refused it until the first lets go; the two never share
it. A job with no agent
gets a container for that one attempt, removed when it ends.

Removing a space, or the connection, removes its containers and their volumes.

## What is in the container

- Bash, coreutils, curl, git, jq, procps, unzip and xz; Python 3.12 with pip.
  `pip install` falls back to the user's own directory, which persists.
- A 1024x768 virtual display with a light window manager and Chromium, the same
  size as the live view.
- `/work`, the job's workspace. Files the agent writes with its file tools are
  copied in before each command and copied back after it, so the shell and the
  file tools see the same files.
- `/home/agent`, the agent's home, which also persists.

It holds no Melete configuration, credential, token or client.

## Isolation and limits

Each container:

- runs as an unprivileged user (uid 10004), never root;
- drops every Linux capability, sets `no-new-privileges`, keeps the engine's
  default seccomp profile, and is never privileged;
- has a read-only root filesystem; only its two volumes, `/tmp`, `/var/tmp`
  and `/dev/shm` are writable, the last three in memory with fixed sizes;
- mounts nothing from the host: no bind mount, no device and no Docker socket;
- is bounded in CPU, memory (with no swap beyond it), processes and log size.

| Setting | Default | What it bounds |
|---|---|---|
| `MELETE_SANDBOX_DOCKER_CPUS` | `1` | CPUs one container may use |
| `MELETE_SANDBOX_DOCKER_MEMORY_MB` | `2048` | memory, swap included |
| `MELETE_SANDBOX_DOCKER_PIDS` | `512` | processes at once |
| `MELETE_SANDBOX_DOCKER_DISK_MB` | `4096` | what its files may hold |

Docker's local volume driver cannot cap a volume's size on an ordinary
filesystem, so disk is bounded two ways. No single file may grow past the whole
allowance; the kernel stops the write. And before each command the two volumes
are measured: past the allowance, commands still run, so files can be removed,
but no file may grow past 2 MiB until usage is back under it.

A container is a hardened boundary, not a virtual machine: it shares the host's
kernel. If you want each agent in a microVM, connect E2B, Modal or Daytona
instead.

## What it may reach

`MELETE_SANDBOX_DOCKER_EGRESS` sets it for the default Computer connection.

- `open` (the default): public HTTPS sites, and nothing else. The container sits
  alone on an internal network whose only other member is the Melete service,
  and its only way out is an egress guard in the service. The guard tunnels
  HTTPS to port 443 of a name only when every address the name resolves to is
  public, and connects to the address it checked. Plain HTTP, other ports,
  private and loopback addresses, cloud metadata, other containers and the host
  are refused, and there is no DNS inside the container. Commands and the
  browser are pointed at the guard. These are the same rules the browser worker
  follows.
- `deny_all`: no network at all.

An allow-list of address ranges is not offered by this provider; asking for one
is refused rather than widened.

`open` needs the service to run in a container on the same engine, as it does
in the Compose deployment, so that it can be the one way out. Where it does not,
the default Computer connection is created with `deny_all` instead.

The sandbox browser starts with a clean profile and none of your sessions. If
you take over and sign in to a site there, the agent can use that session after
you hand the computer back; sign in only where you would let it act.

## Idle stop and resume

A container nobody has used for `MELETE_SANDBOX_DOCKER_IDLE_SECONDS` (15 minutes
by default) is stopped. The next command, file operation, desktop action or
live view starts it again. Files on its volumes persist; running processes and
the open browser do not. Watching the desktop counts as use, and so does a
background process that is still running (see "Long-running work" below): the
idle stop reads which containers have running processes from the service's
records, so such a container is never stopped for idleness, and its idle clock
starts when its last process ends. The container's own lifetime still applies;
when it runs out, the container stops with its processes, and the conversations
see them ended with that reason.

Each command's record (its output and exit status) is kept under
`/home/agent/.melete/exec`, on the home volume, so a command whose answer was
lost is still reported from that record after an idle stop.

A suspended workspace nobody resumes is removed after
`MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS`, as with the other providers.

## The agent's tools

- **Shell.** The engine's terminal runs every command in the container, one
  brokered action each, with a timeout of up to 120 seconds, the first 16 KiB of
  output in the conversation and up to 1 MiB stored with the job.
- **Background processes.** `process.start`, `process.list`, `process.read`,
  `process.write`, `process.signal`, `process.stop`, `process.extend` and
  `process.wait`, for work longer than a command (see "Long-running work"
  below).
- **Files.** The file tools write the job's workspace, which the container
  sees as `/work`.
- **Computer.** `computer.screenshot` captures the desktop and stores the PNG
  with the job. `computer.open` opens an address in the browser;
  `computer.click`, `computer.type`, `computer.key` and `computer.scroll` drive
  the pointer and keyboard. While a person holds control, every one of them is
  refused.

Commands and desktop actions change only the sandbox, like a command in any
other sandbox. They run without asking unless the agent is set to ask before
acting (new agents are) or your approval settings ask for every change; then
each one waits for you like any other change. What leaves the sandbox is
bounded by the egress setting above. Actions through connectors that hold your
accounts keep their approvals.

The engine also refuses, before the command reaches Melete, a shell command
that matches its dangerous-command rules (writing under `/etc`, piping a
download into a shell, and the like). Nothing runs and there is no approval to
give. The conversation shows a short note that a command was blocked, and the
agent is told plainly that it was refused by a safety rule, so it does not ask
you to approve it.

## Long-running work

A shell command ends within two minutes. A test suite, a build or a dev server
runs as a background process instead: the agent starts it with
`process.start`, the turn ends, and the process keeps running in the
container. A later conversation with the same agent finds it with
`process.list`, reads its output with `process.read`, types into it with
`process.write`, and ends it with `process.signal` or `process.stop` (TERM,
then KILL ten seconds later). `process.extend` gives it more time. Each of
these is one brokered action with a receipt, like a command, and a start runs
once: starting the same command again starts a second process.

A process belongs to the agent's computer, not to the conversation that
started it, so every conversation with that agent can see and stop it. Another
agent's conversations cannot. A process keeps running when the job that
started it finishes, and is stopped when that job is cancelled or deleted.

`melete-proc`, in the sandbox image, keeps each process under
`/home/agent/.melete/proc`: its output in a ring of two files that together
hold `MELETE_PROCESS_OUTPUT_MAX_BYTES` (8 MiB by default), so a chatty process
never fills the disk, a pipe for its input and its exit status. Each read the
agent makes is also kept in the job's workspace under `.melete/proc/` with its
digest on the receipt. A computer whose image has no `melete-proc` is sent it
on first use; it needs `python3`.

Limits, each set in the service's environment:

| Setting | Default | What it bounds |
|---|---|---|
| `MELETE_PROCESS_MAX_PER_COMPUTER` | 4 | processes one agent's computer runs at once |
| `MELETE_PROCESS_MAX_PER_SPACE` | 8 | processes one space runs at once, over its computers |
| `MELETE_PROCESS_DEFAULT_TTL_MINUTES` | 120 | a process's time limit when none is given |
| `MELETE_PROCESS_MAX_TTL_MINUTES` | 720 | the longest time limit, at start or extended |
| `MELETE_PROCESS_OUTPUT_MAX_BYTES` | 8388608 | the output ring of one process |
| `MELETE_SANDBOX_AWAKE_SECONDS_PER_DAY` | 21600 | how long a space's processes may keep its computers running each day (UTC) |

When a conversation's turn ends with processes still running in the agent's
computer, the computer is not suspended: the processes keep it running, and
the next conversation with that agent takes it over as it is, with them still
in it. Once the last one ends, the computer is suspended as usual. A computer
kept running this way counts toward `MELETE_SANDBOX_MAX_CONCURRENT`, like one a
conversation is using.

The awake allowance counts only that time: how long a space's computers were
kept running by their processes alone, after the turns that used them ended,
added up over its computers for the day (UTC). Time a conversation is using
the computer does not count.

Every minute the service checks each computer with running processes. It
stops a process past its time limit, stops a space's processes once the day's
allowance is used, and records a process as lost when its container restarted
or stopped, since that ends every process in it. When the allowance stops
processes, the conversation that started them says so: "Your computer's awake
time for today is used up (6 of 6 hours). Processes stopped at 14:02 UTC." A
start over a limit is refused with the reason, which the agent passes on: "This
computer is already running 4 processes. Stop one first."

### Picking the conversation up when a process finishes

An agent that starts the test suite says so and ends its turn; the
conversation picks up again when the suite finishes, with its exit code and
last lines. It asks for this when it starts the process
(`process.start` with `notify`), or later for a process already running
(`process.wait` with `later`), on one of three things:

| On | Wakes the job |
|---|---|
| `exit` | when the process ends, with its exit code, the reason it ended and the end of its output |
| `output` | on a line it prints, or a line matching a regular expression (RE2), at most once a minute; lines printed meanwhile are covered by that wake |
| `listening` | once, when the process opens its port |

The agent then ends its turn waiting on `process:<process id>`. The service
asks each computer with watched processes how they are, every 5 seconds on
Docker and every 30 seconds on remote providers, in one call per computer, and
only what the job asked for wakes it: until then no attempt runs and no model
is called. A process that ends before the line or port it was watched for
wakes the job with how it ended. A job watches at most four processes at once,
and each watch goes when its process has ended.

For a short wait inside the turn, `process.wait` holds the turn for up to 100
seconds until the process ends, prints a matching line or opens its port, and
returns what it saw.

A wake never reaches a computer while it is being suspended: the woken
conversation waits for the suspend to finish and then resumes the computer as
usual.

## Watching and taking over

The service exposes the desktop with the same wire shapes as the browser
worker's live view:

| Route | Purpose |
|---|---|
| `GET /sandbox/computers?job_id=` | the job's computer, who controls it, and whether it is running |
| `POST /sandbox/sessions/{id}/takeover` | take control; the job waits for you |
| `POST /sandbox/sessions/{id}/handback` | give control back |
| `POST /sandbox/sessions/{id}/live` | open a live view |
| `GET /sandbox/sessions/{id}/live/frames` | the desktop as a stream of frames |
| `POST /sandbox/sessions/{id}/live/input` | pointer and keyboard input, only while you hold control |
| `POST /sandbox/sessions/{id}/live/close` | close the live view |

Only the job's owner may watch or take over. Taking over parks the job until
you hand the computer back and answer it. Frames are never stored, and nothing you type
is logged or kept.

## Checking it on your engine

The adapter's live suite runs the shared sandbox conformance scenarios, the
container's limits, a real task, the idle stop and the desktop against your
engine:

```sh
docker build -t melete-sandbox:local -f deploy/Dockerfile.sandbox .
MELETE_SANDBOX_LIVE=docker bun test apps/melete/src/sandbox/adapters/docker.live.test.ts --timeout=300000
```

Set `DATABASE_URL` to also run the workspace scenarios. The open-egress checks
run when the suite itself runs in a container on the engine with the socket
mounted, as CI does.

## Troubleshooting

- *"the image melete-sandbox:local is not on this Docker engine"*: build it with
  `--profile sandbox`, or with the `docker build` line above.
- *"open egress needs the service to run in a container on the same engine"*:
  the service runs outside Docker; use `deny_all`, or run it with Compose.
- The Computer connection is missing: check that `MELETE_SANDBOX_PROVIDER=docker`
  and `MELETE_SANDBOX_PROJECT` are both set, then recreate the service.
- Containers, volumes and networks are named `melete-sbx-<project>-<session>`
  and labelled with the project, connection and session. The service removes
  the ones no session owns when it starts.
