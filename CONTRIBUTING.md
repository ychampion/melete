# Contributing

For a substantial change, open an issue or a draft pull request first that says
what should happen and why. Report a security problem privately, as described in
[SECURITY](SECURITY.md), rather than in an issue.

## Set up and verify

Use Bun 1.3 or newer. From the repository root:

```bash
bun install --frozen-lockfile
bun run doctor
bun run typecheck
bun run lint
bun run test
bun run openapi
bun run client:generate
bun run compose:check
bun run browser:compose:check
bun run tailscale:compose:check
bun run conformance
bun run conformance:memory
bun run test:plugin
```

Run `bun run doctor` first: it names each missing test prerequisite. Tests use
scripted providers, so no model key is needed.

Database tests use disposable Postgres 17: embedded when `DATABASE_URL` is
unset, otherwise disposable databases created on the server you supply, which
needs permission to create databases. On Linux, point `DATABASE_URL` at a
Postgres 17 you control: the embedded build needs `libpq5` and an ICU 60
runtime that current Debian and Ubuntu ship without. Run tests as a non-root
user with a writable `TMPDIR`; embedded Postgres refuses to start as root. On
Windows, clone to a short path such as `C:\m`: the embedded server's own files
sit about 145 characters below the clone, and once a path passes Windows'
260-character limit its `initdb` says `pg_ident.conf.sample` is missing when the
file is there.

`bun run test:plugin` needs `uv` on `PATH`. The two integration tests that start
an interpreter use `MELETE_PYTHON`, then `python3`, then `python`. Install
Chromium with `bunx playwright install chromium` for the browser fixtures, and
run the suites one at a time on small machines.

`bun run lint` is Biome over the whole tree followed by `bun run scrub:check`,
which refuses local paths and internal work codes in tracked files. The OpenAPI
document and the client declarations are generated: run `bun run openapi` and
`bun run client:generate` when you change a contract, and commit the result.

### Work on the interface

Run the scripted mock and the web app:

```bash
MOCK_PORT=3210 bun run dev:mock
bun run dev:web
```

Then open http://localhost:5180. Set `MELETE_MOCK_SETUP=needed` to start the
mock as a fresh install that asks for its first account.
[Building a client](docs/CLIENT.md) describes the scenarios the mock plays.

### Run the agent runtime locally

Install the runtime and select the process supervisor; the service then starts
memory, the broker and one engine per attempt on this machine:

```bash
git clone --depth 1 --branch v2026.9.7 https://github.com/NousResearch/hermes-agent.git .hermes-src
uv venv .hermes-venv --python 3.12
# Windows: replace .hermes-venv/bin/python with .hermes-venv/Scripts/python.exe.
uv pip install --python .hermes-venv/bin/python -e ./.hermes-src aiohttp==3.14.3
export MELETE_RUNTIME_ADAPTER=hermes MELETE_RUNTIME_SUPERVISOR=process
export MELETE_SPACES_DIR="$PWD/spaces" MELETE_WORK_DIR="$PWD/work"
export MELETE_BROKER_BIND=127.0.0.1:3172 MELETE_BROKER_URL=http://127.0.0.1:3172 PORT=3170
# Configure DATABASE_URL, MELETE_CAPABILITY_KEY, MELETE_APPROVAL_KEY and a provider key.
bun run apps/melete/src/index.ts
```

The process supervisor runs with your own user's access, for development; the
sandboxed path is the Docker install. The scripted end-to-end run needs no
provider key:

```bash
bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=1
```

[Service conformance](conformance/README.md) and
[memory conformance](conformance/memory/README.md) describe each scenario and
how to run the deployment scenarios against a Compose stack.

## Where things live

| Path | What it holds |
| --- | --- |
| `apps/melete` | The service: jobs, broker, memory, connectors and model metering |
| `apps/web` | The web app |
| `apps/mock-api` | The scripted mock the web app can run against |
| `packages/contracts` | Schemas, state transitions and the generated OpenAPI document |
| `packages/client` | The typed client |
| `packages/runtime-hermes` | Runtime configuration, the Melete plugin, the HTTP adapter and the runtime image |
| `packages/knowledge`, `packages/skills` | File-view utilities and skill files |
| `deploy` | Compose files, `.env.example`, the configuration generator and the deployment checks |
| `conformance` | Service scenarios and [memory scenario families](conformance/memory/README.md) |
| `docs` | The documentation |
| `.agents/notes` | Engineering decisions and the evidence behind them |

## Sending a change

- Test behaviour at its boundaries: a stale attempt, an approval spent on
  changed content, a send whose outcome is unknown.
- Explain a change to the tool surface, prompts or budgets with what you
  measured.
- Record an architectural decision as a new note under `.agents/notes`; leave
  earlier notes as they are.
- Keep static configuration checks and inside-container probes apart: the
  container scenarios run against a real Compose stack.

Write commit messages as plain sentences. In the pull request, say what changed,
how it behaves, and which suites you ran.

## Licence

Contributions are licensed under Apache-2.0, as described in [LICENSE](LICENSE).
