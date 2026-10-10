# Setting up Melete: a guide for coding agents

This page is written for a coding agent, such as Claude Code, Codex or Cursor,
that a person has asked to install Melete for them. Follow it from the top. The
person types their own passwords and keys; you do everything else.

Every step says what to run, how to tell that it worked, what to do when it
did not, and when to stop and ask. Every step is safe to run again: each one
checks what is already there first, so after an interruption, start again from
the top. The repository's checks run steps 2 to 5 on a clean machine, from the
commands on this page.

## Rules for the whole setup

- **Never ask for a password or a key in the chat.** Keys go into Melete's
  Settings in the browser, or the person types them into their own terminal or
  editor. Never put one in a command line, a shell history, a log, or any file
  other than `deploy/.env`.
- **Never print `deploy/.env`.** It holds the installation's secrets. To read a
  setting, read only that line, for example
  `grep '^WEB_PORT=' deploy/.env`. Never read a line whose name ends in `KEY`,
  `TOKEN`, `SECRET` or `PASSWORD`, nor `DATABASE_URL`.
- **Never delete data.** Don't run `docker compose down -v`, `docker volume rm`
  or `docker system prune`, and never delete `deploy/.env`: it holds the key
  that unlocks everything stored. If something seems to need one of these,
  stop and ask.
- **Ask before anything that needs administrator rights**, such as installing
  Docker, or that costs money, such as creating a server.
- **Change a setting with `set-env.ts`**, never by rewriting the file:
  `bun run deploy/scripts/set-env.ts NAME=value`. It edits `deploy/.env` in
  place on every platform, and refuses a secret on the command line.
- Run the commands from the repository root, in Bash. On Windows, use Git Bash.
- `bun run deploy/scripts/status.ts` prints a readable report of the whole
  installation at any point, with what to do next for anything that is not
  ready. It changes nothing and prints no secrets. Use it whenever you are
  unsure where things stand.

## 1. Choose where it runs

Ask the person one question if they haven't said: **this computer, or a
server?**

- **This computer** suits trying it out. Melete runs while the computer is on,
  at `http://localhost:3101`.
- **A server** (a small Linux machine with 2 CPUs, 4 GB of memory and 30 GB of
  disk) keeps it running all the time. Creating one costs money, so the person
  creates it or tells you to. Then connect over SSH and run every step below
  on the server.

## 2. Check the machine

```bash setup
docker version --format '{{.Server.Version}}'
docker compose version --short
docker info --format '{{.Architecture}} {{.OperatingSystem}}'
git --version
bun --version
```

Melete needs:

- **Docker Engine 28.0 or newer and Docker Compose 2.33.1 or newer.**
  - If `docker` is missing, stop and ask the person before installing it. On a
    Linux server, follow
    [Docker's instructions](https://docs.docker.com/engine/install/) for the
    distribution, with the Compose plugin. On Windows or macOS, the person
    installs [Docker Desktop](https://docs.docker.com/desktop/) and starts it.
  - If `docker version` answers `permission denied` on Linux, this account
    cannot reach the Docker socket. Stop and ask: the fix, adding the account
    to the `docker` group or running as root, is the person's choice.
  - On Windows, Docker Desktop needs the WSL 2 backend, Linux containers and at
    least 4 GB of memory for its VM. The
    [Windows section](docs/DEPLOYMENT.md#windows-docker-desktop) shows how to
    change each.
- **Bun.** If it is missing, install it for the current user:
  `curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"`
  on Linux and macOS, or `powershell -c "irm bun.sh/install.ps1 | iex"` on
  Windows, then open a new Git Bash window.
- **Git.** On a minimal Debian or Ubuntu server, `apt-get install -y git curl unzip ca-certificates` as root.
- **At least 10 GB free** where Docker keeps its images. On Linux,
  `df -h "$(docker info --format '{{.DockerRootDir}}')"` shows it. Docker
  Desktop shows its disk under **Settings > Resources**. Below 10 GB, stop and
  tell the person how much is free.
- **Ports 3100 and 3101 free** on the machine:

  ```bash setup
  bun -e "for (const port of [3100, 3101]) { try { Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true); console.log(port, 'free'); } catch { console.log(port, 'in use'); } }"
  ```

  If either is in use and `docker compose ls` shows a project named `melete`,
  Melete is probably installed already: go to step 3 and look for that
  checkout before going further. If something else holds the port, choose two
  other ports in step 4.

**Prebuilt images or a build here.** If the architecture printed above is
`x86_64`, use the published images, which need no build. On `aarch64` or
`arm64` (Apple silicon, ARM servers), the images are built on the machine
instead, which takes longer and needs 20 GB free. Step 5 shows both.

## 3. Get the code

Use a short path. On Windows, `C:\melete` (`/c/melete` in Git Bash) avoids the
Windows path-length limit.

```bash
if [ -d melete/.git ]; then git -C melete pull --ff-only; else git clone https://github.com/ychampion/melete.git melete; fi
cd melete
```

Then, inside `melete`:

```bash setup
bun install --frozen-lockfile
bun run doctor --docker
```

**Worked when** `doctor` prints
`doctor: every Docker Engine and Compose requirement is met.` If it lists
missing prerequisites, fix each one it names, or stop and show them to the
person.

If `git pull --ff-only` refuses because the checkout has local changes, stop and
ask: someone edited it, and those edits are theirs.

## 4. Configure

Skip this step if `deploy/.env` already exists: it is written once, and running
`configure.ts` again is refused rather than replacing it.

```bash setup
test -f deploy/.env || bun run deploy/scripts/configure.ts --connect-in-app
```

This writes `deploy/.env` with fresh secrets for this installation and no model
key: the person adds their key in the app in step 7, so it never passes through
a shell. It prints `Created deploy/.env` and a line about connecting a model.

If it refuses, the message names the reason, usually Docker. Fix that and run it
again; nothing was written.

**If the person would rather keep the key in the configuration file**, for
example on a server, ask them to run these lines **in their own terminal**, not
through you. The first line waits, hidden, for them to paste the key:

```bash
read -rs FIREWORKS_API_KEY && export FIREWORKS_API_KEY
bun run deploy/scripts/configure.ts
unset FIREWORKS_API_KEY
```

For another provider, they export its key and add `--provider` and `--model`,
as [Connect your model](README.md#connect-your-model) lists, for example
`ANTHROPIC_API_KEY` with `--provider anthropic --model <model id>`.

**Other ports or a second installation.** Before the first start, and only
then, you can change the ports and the project name. Use them consistently from
here on:

```bash
bun run deploy/scripts/set-env.ts WEB_PORT=3201 MELETE_PORT=3200
bun run deploy/scripts/set-env.ts COMPOSE_PROJECT_NAME=melete2
```

The rest of this page writes `3101`; use your `WEB_PORT` instead.

## 5. Start it

With published images (on `x86_64`):

```bash setup
bun run deploy/scripts/set-env.ts MELETE_IMAGE_TAG=main
bun run compose:check
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d --no-build --wait --wait-timeout 300
```

When building here instead (on ARM, or when the person asks for it), leave
`MELETE_IMAGE_TAG` empty and run:

```bash
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 900
```

Then check:

```bash setup
bun run deploy/scripts/status.ts
```

**Worked when** Docker, Configuration, Images, Services and API read `ok`. Before
the person has an account, Account reads `warn` and Model reads `warn`: that is
expected, and steps 6 and 7 finish them.

**If it fails:**

- A pull that answers `denied` or `unauthorized`: the published images are not
  public yet. Build here instead, as above.
- A service that is unhealthy or exited:
  `docker compose -f deploy/docker-compose.yml logs --tail=100 <service>` names
  the reason. Fix what it names and run the `up` line again.
- A timeout while starting: run the `up` line again once. The first start
  creates the database and can be slow.
- Out of disk: stop and tell the person what `status.ts` reports.

Try each fix once. If the same failure comes back, stop and show the person the
last 30 lines of the log, after checking they hold no secret.

## 6. The person creates their account

Don't create the account yourself: its password is the person's.

- **On this computer**, tell them to open http://localhost:3101 and create their
  account.
- **On a server**, Melete listens only on the server itself. Tell them to run
  this on their own computer, keep it open, and then open
  http://localhost:3101 there:

  ```bash
  ssh -N -L 3101:127.0.0.1:3101 <user>@<server address>
  ```

**Worked when** `status.ts` reports Account `ok`. Wait for the person to say
they are done, then run it.

Then give the agent its own browser, for reading pages and filling in forms:

```bash
bun run melete browser enable
```

It sets up the [browser worker](docs/browser-worker.md) for the person's space,
builds it and starts the stack with it; the first build takes a few minutes.
**Worked when** it ends with `The browser worker is on.` and
`bun run melete check` reports `browser.worker` as `ok`. It is safe to run
again. If it says there is no account yet, wait for step 6. From here on, every
`docker compose` command on this page also takes
`-f deploy/docker-compose.browser.yml` right after `-f deploy/docker-compose.yml`.

## 7. The person connects a model

Tell the person to open **Settings › Models** in Melete (it also opens by
itself while no model works), choose their provider, paste their API key,
choose **Test connection**, pick a model and save. It applies straight away, with no
restart. With a ChatGPT plan instead of a key, they choose **Sign in with
ChatGPT** there.

Remind them to paste the key only into Melete, never into this chat.

**Worked when** the person starts a new chat, says hello, and gets a reply.
`status.ts` cannot see a key saved in the app, so its Model line stays `warn`
when the key lives there; that is expected. If they chose to keep the key in
`deploy/.env` in step 4, Model reads `ok`.

If the test in Settings fails, its message says why: a refused key means the
person pastes it again; a model name the provider does not serve means
choosing one from the list.

The basic setup is done here. Tell the person, and offer the optional parts
below. Do each only when the person wants it.

## 8. Optional: a computer for the agent

This gives every agent its own Linux computer, a container on this Docker
engine with a shell, files and a desktop with a browser. It needs no account
and adds about 1 GB of disk.

```bash
bun run deploy/scripts/set-env.ts MELETE_SANDBOX_PROVIDER=docker
```

Then, with published images:

```bash
docker compose -f deploy/docker-compose.yml --profile sandbox pull
docker compose -f deploy/docker-compose.yml --profile sandbox up -d --no-build --wait --wait-timeout 300
```

or, building here:

```bash
docker compose -f deploy/docker-compose.yml --profile sandbox up -d --build --wait --wait-timeout 900
```

**Worked when** `status.ts` reports Computer `ok`, and **Settings → Connections**
lists a sandbox connection called **Computer**. From now on, pass
`--profile sandbox` to every `docker compose` line and to
`deploy/scripts/update.sh`. A cloud sandbox (E2B, Modal or Daytona) is the other
choice: the person adds it in **Settings → Connections → Sandbox** with their
own key. Details: [sandbox-docker.md](docs/sandbox-docker.md).

## 9. Optional: voice

Voice needs an ElevenLabs API key. Ask the person to run these lines **in their
own terminal**, from the `melete` folder. The first waits, hidden, for them to
paste the key:

```bash
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
bun run deploy/scripts/set-env.ts --from-env ELEVENLABS_API_KEY
unset ELEVENLABS_API_KEY
```

It prints `Set ELEVENLABS_API_KEY.` Then restart the service:

```bash
docker compose -f deploy/docker-compose.yml up -d --wait melete
```

**Worked when** `status.ts` reports Voice `On.` and a microphone button appears
in the chat box. The microphone needs `localhost` or `https://`. Details:
[VOICE.md](docs/VOICE.md).

## 10. Optional: mail and calendar

The person connects these in **Settings → Connections**. Gmail and iCloud take
an app password, and other mailboxes and calendars take their IMAP or CalDAV
password. Walk them through creating an app password if they need it:

- Gmail: turn on 2-Step Verification, then create an app password named Melete
  at https://myaccount.google.com/apppasswords.
- iCloud: create an app-specific password at https://account.apple.com under
  **Sign-In and Security**.

They paste it into Melete, not into the chat. Signing in with Google or
Microsoft instead needs the person's own OAuth app, which
[mail-calendar.md](docs/mail-calendar.md) sets up.

**Worked when** the connection shows as connected in Settings.

## 11. Optional: a public address and other assistants

To reach Melete from a phone, or to let other assistants (Claude, ChatGPT,
Claude Code) use it as an MCP server, it needs an HTTPS address. Ask the person
which they want:

- **Tailscale**, for their own devices only, with no open port. Follow
  [Tailscale](docs/DEPLOYMENT.md#tailscale). The person creates the auth key in
  the Tailscale admin console and sets it themselves, the way step 9 sets a
  key, with `--from-env TS_AUTHKEY`.
- **A domain of their own**, behind a reverse proxy that serves HTTPS. Follow
  [Configuration and browser access](docs/DEPLOYMENT.md#configuration-and-browser-access).
  The person owns the domain and its DNS, so ask before changing either.

Once it answers over HTTPS, set both addresses and recreate the two services
that read them:

```bash
bun run deploy/scripts/set-env.ts MELETE_PUBLIC_URL=https://melete.example.net MELETE_WEB_ORIGIN=https://melete.example.net
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete web
```

**Worked when** `status.ts` reports the public address and its MCP endpoint, and
the person can sign in at that address. To add Melete to Claude Code:

```bash
claude mcp add --transport http melete https://melete.example.net/api/mcp
```

then `/mcp` in Claude Code to sign in. Other assistants:
[MCP-SERVER.md](docs/MCP-SERVER.md).

## 12. Optional: a browser worker for another space

Step 6 gave the person's own space its browser. One worker serves one space; a
second space gets a worker of its own only when the person asks, following
[browser-worker.md](docs/browser-worker.md#by-hand).

## Later: updating and removing

- **Update**, with published images: `bun run melete init --adopt` once (the
  browser step already wrote `deploy/melete.deploy.json`, so skip it then), then
  `bun run melete deploy --checkout --dry-run` to show the person the plan, and
  `bun run melete deploy --checkout`. It sizes the update against the disk,
  backs up the database and the files when the release adds migrations, pulls
  one image at a time, and leaves the running stack alone if anything fails
  before the switch.
  `bun run melete rollback` goes back.
- **Back up**: `bun run melete backup --estimate`, then `bun run melete backup`
  ([Backup and restore](docs/DEPLOYMENT.md#backup-and-restore)).
- **Remove**: [Remove it completely](docs/DEPLOYMENT.md#remove-it-completely).
  It deletes everything Melete stored, so confirm with the person first.

## When to stop and ask

Stop, say what you found, and wait for the person when:

- Docker is missing or too old, or installing anything needs administrator
  rights;
- there is less than 10 GB free;
- an installation already exists and you were not asked to change it;
- a fix from this page did not work the second time;
- a step needs a password, a key, a domain, money or a choice only the person
  can make.
