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

- Bash, coreutils, curl, git, jq, procps, unzip and xz; Python 3.12 with pip; Node.js 24
  with npm; GitHub's `gh` 2.83.2, AWS's `aws` 2.37.8 and GitLab's `glab` 1.120.0. Node.js,
  `gh`, `aws` and `glab` are pinned by checksum
  ([COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#github), [AWS](COMMAND-LINE-ACCESS.md#aws)).
  `pip install` falls back to the user's own directory, and `npm install -g` installs
  there too; both persist.
- 1024x768 virtual displays with a light window manager and Chromium, the same
  size as the live view: one for each conversation or run using the computer
  (see "A display for each conversation" below).
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
- `connected_hosts_only`: the same way out, through the same guard, to the
  hosts listed in `MELETE_SANDBOX_EGRESS_EXTRA_HOSTS` (for example a package
  registry or a code host), and nothing else. Entries are names, or
  `.example.com` for every name below one; a suffix needs at least two labels.
  With the list empty, the computer reaches nothing. The list is read at each
  connection.
- `deny_all`: no network at all.

An allow-list of address ranges is not offered by this provider; asking for one
is refused rather than widened.

`open` and `connected_hosts_only` need the service to run in a container on the
same engine, as it does in the Compose deployment, so that it can be the one way
out. Where it does not, the default Computer connection is created with
`deny_all` instead.

### Where each command reached

Each command the agent runs gets its own proxy address, carrying a token that
names that command. The guard accepts the token only from the computer it was
made for, and only while the command runs. Every connection the computer opens,
or tries to open, is recorded: the host and port, whether it was tunnelled or
refused and why, the bytes each way, and the command it belonged to. Each
command's result lists the hosts it reached. When a command sends something to
a site the computer had not reached before, the conversation shows a quiet row
under the command, such as "Sent 2 KB to example.com from its computer". The
count includes the connection's own setup. Nothing is held or asked for this.

A connection that carries no live token, such as one from a background process
a command left running, goes out under the same rules and is recorded as
unattributed. Processes inside one computer run as the same user, so one can
borrow another's token; that only changes which of that computer's commands a
connection is recorded against.

The same refusal repeated within a minute is one record with a count. One
computer adds at most 120 records a minute; past that, its further connections
are counted on a single record for that minute, so a computer that loops cannot
fill the database. Each command's result still counts every connection.

Records are kept for `MELETE_EGRESS_RECORD_DAYS` (30 by default) and are removed
with their space.

The sandbox browser starts with a clean profile and none of your sessions. If
you take over and sign in to a site there, the agent can use that session after
you hand the computer back; sign in only where you would let it act. The
browser saves no passwords, payment cards or addresses, and signs in to no
browser account.

A command that looks for or reads the places programs keep saved passwords,
cards, sign-in cookies or keys (browser profiles, key and token files) asks you
first, with that reason, whatever your settings let the agent do in its own
computer. This is judged from the command's text, so it is a signal rather
than a wall; the computer holds none of your own browser profiles or keys.

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
  the pointer and keyboard, and `computer.batch` runs up to five of those steps
  in one call, stopping at the first that fails. Each of them ends with a
  screenshot stored the same way, which a model that reads images is shown
  with the result. While a person holds control, every one of them is refused,
  and a batch stops at the step where a person took over.

Opening a public `http` or `https` page in the agent's own browser runs without
asking, wherever the address came from: it reads the page in the sandbox and
sends nothing. Private and local addresses, and addresses carrying a sign-in or
key, are treated like any other unvouched destination.

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

### Previewing a server

A process started with a `port` is a server the person can look at. In the
computer view, the Processes list shows each background process with its
state, how long it has run, its port and the last line it printed, and lets
the person whose job started it read the end of its output, stop it, or open
**Preview**. The preview is the page the server answers on that port, framed
inside Melete.

- The server must listen on all addresses (`0.0.0.0`), not only on
  `localhost`: the service reaches it at the computer's own address on its
  private network. Most development servers take a `--host 0.0.0.0` option.
- Only computers with network access (`open`) can be previewed. A `deny_all`
  computer has no network the preview could use, and opening one says so.
- Pages are framed with the same isolation as a published app: an opaque
  origin, no Melete session, and nothing fetched from anywhere, including the
  server's own API. Pages, scripts and styles that link the server's own
  files from the root (`/src/main.js`) have those links kept inside the
  preview, up to 5 MiB per answer; larger ones are passed on unchanged. Live
  reload connections are not passed on, so reload the preview to see a change.
- One answer may be up to 50 MiB, and the server has 30 seconds to give it.
- A preview lasts half an hour. While it is on screen the computer view opens
  a new one shortly before then and reloads the page. It ends at once when the
  process stops or the browser session that opened it signs out.

## A display for each conversation

An agent's computer is shared by the agent's conversations and runs. Each one
works on a display of its own, with its own browser window, at the same time
as the others: a run checking prices overnight and a conversation planning a
trip each see only their own page. Files in `/work` and `/home/agent` are the
same for all of them, and so are the sites you signed in to: display 0 uses
the computer's browser profile, and each other display starts its browser from
a copy of it, since one browser profile is open in one browser at a time.

- A display is made the first time a conversation or run uses the computer,
  and stays with it between turns.
- It ends when its conversation or run ends, or when nothing has used it for
  half an hour. Stopping a conversation ends its display and leaves the others
  running.
- `MELETE_SANDBOX_MAX_DISPLAYS` (6 by default, up to 64) is how many run on one
  computer at once. One more is told plainly that the computer is full, and
  nothing runs; the agent says so and carries on without the computer, or
  tries again once one has finished.
- The computer is suspended, or made again from a new image, only when no
  conversation or run is using any of its displays.

## Watching and taking over

The service exposes the desktop with the same wire shapes as the browser
worker's live view:

| Route | Purpose |
|---|---|
| `GET /sandbox/computers?job_id=` | the conversation's display of the computer, who controls it, and whether it is running |
| `POST /sandbox/sessions/{id}/takeover` | take control; the job waits for you |
| `POST /sandbox/sessions/{id}/handback` | give control back |
| `POST /sandbox/sessions/{id}/live` | open a live view |
| `GET /sandbox/sessions/{id}/live/frames` | the desktop as a stream of frames |
| `POST /sandbox/sessions/{id}/live/input` | pointer and keyboard input, only while you hold control |
| `POST /sandbox/sessions/{id}/live/close` | close the live view |

Each display is watched and taken over on its own: `{id}` is the
`session_id` the list gives, which names the conversation's display. Taking
over one conversation's display parks that conversation only, and the others
keep working on theirs.

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
