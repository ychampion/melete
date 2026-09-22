# Service conformance

The runner lists nine scenarios, then executes the tests in
`conformance/scenarios`. Scenarios 1–5 run anywhere with disposable Postgres;
6–8 run against the Compose stack when `MELETE_CONFORMANCE_COMPOSE=1` is set;
9 runs against a Docker engine when `MELETE_CONFORMANCE_DOCKER=1` is set.

## Run

From the repository root:

```bash
bun run conformance
```

Install dependencies with the command in [README](../README.md) first. The
runner prints the catalog, then runs `bun test --max-concurrency=1
conformance/scenarios`; each slow fixture declares its own timeout.
The fixtures create isolated databases and use scripted runtimes and test
effects. Without `DATABASE_URL`, they start disposable embedded Postgres 17.
With a URL, they create disposable databases on that server; the supplied user
needs database-creation permission. pg-boss uses those fixture databases.

Without the opt-in the command starts no Compose stack, and no scenario calls a
real model. The catalog states each scenario's intended assertions; the
executable test bodies and the reported results are the evidence.

## Executable scenarios

| Scenario and file | What the tests exercise | Named assertion |
| --- | --- | --- |
| 1: [durable wakes](scenarios/01-durable-wakes.test.ts) | Rollback after a child-process transition fault, deliberately deleted wake, recovery scan and duplicate timers | `exactly one attempt is admitted for the duplicated timer` |
| 2: [lease fencing](scenarios/02-lease-fencing.test.ts) | Stalled stub, expired lease, replacement attempt and late receipt | `A cannot admit an action: the broker refuses it with stale_epoch` |
| 3: [unknown outcomes](scenarios/03-unknown-outcomes.test.ts) | Durable destination acceptance followed by lost acknowledgement, broker reconstruction and verification | `the action is never dispatched a second time, including after broker restart` |
| 4: [approval binding](scenarios/04-approval-binding.test.ts) | Changed payload/revision and cancellation while dispatch is in flight | `admission is rejected when the payload hash no longer matches the approval` |
| 5: [runtime death](scenarios/05-runtime-death.test.ts) | Child-process faults during streaming and after a completed tool result | `no action is duplicated: the completed tool call is not run twice` |

The fixture tests also check recorded receipts, recovery events and uncertainty
messages. An assertion mentioning UI text checks the returned message, not a
rendered browser.

Scenario 1 kills the child inside the transition transaction before enqueue, so
the transaction rolls back; it separately deletes queued wakes to exercise the
recovery scan. Scenario 5 also checks the stored text-delta rows, which the
current runner persists even though the contract helper labels text deltas
non-durable.

## Deployment scenarios (Compose opt-in)

These run against a disposable Compose installation on a Linux Docker host, as
the [README](../README.md#install-on-a-linux-docker-host) describes. They
restart shared services, so run them sequentially, and use a fresh installation
**before creating an owner account in the browser**: the runner creates its own
account and test data, kills test processes, and restarts the stack.

```bash
MELETE_CONFORMANCE_COMPOSE=1 bun -e '
import { databaseUrl } from "./conformance/helpers/compose.ts";
const env = { ...process.env, DATABASE_URL: await databaseUrl() };
for (const script of ["conformance", "conformance:memory"]) {
  const run = Bun.spawn([process.execPath, "run", script], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await run.exited;
  if (code !== 0) process.exit(code);
}
'
```

This passes the database connection privately to the runners. Scenarios 1–5 use
disposable databases on the Compose Postgres server; scenarios 6–8 use the
running services and runtime containers.

| Scenario | What runs | Named assertions |
| --- | --- | --- |
| 6: [no route out](scenarios/06-no-route-out.test.ts) | Python standard-library probes from a real claimed Hermes cell and the warm cell; ten tests | `Postgres is unreachable by DNS and its actual container IP`; `another job is absent from the mounted filesystem`; `only the broker/gateway peer is attached and both routes answer`; `non-root, read-only, no capabilities, no privilege escalation or Docker socket`; `the warm cell cannot reach owner setup, login or health`; `a claimed attempt cannot reach the owner control plane and retains its job boundary` |
| 7: [retraction](scenarios/07-retraction.test.ts) | Retract a knowledge record while a job is running, then restart the whole stack; four tests | `the record is absent from the FTS index, not merely filtered out of results`; `after a restart, retrieval still does not return it`; `the retraction and its reason remain readable in git` |
| 8: [model agnosticism](scenarios/08-model-agnostic.test.ts) | One scripted job through the stack with the fake provider; the same job against a real provider when a key is present | `the fake provider reaches approval and one receipt through the Compose stack`; `fake-provider approval binds the canonical payload hash`; `enforcement never depends on the model agreeing to be enforced` (a cell capability reads the catalog but cannot approve) |

Scenario 8's second-provider comparison runs when a second credential is
configured; without one it reports itself as skipped.

## Stdio MCP servers on a Docker engine (Docker opt-in)

Scenario 9 starts stdio MCP servers through the service's Docker launcher on a
real engine. It needs no stack and no database, but it runs inside a container
holding the Docker socket, as the service does, because a server with named
destinations reaches them through the proxy in that container. CI runs it on
every pull request; by hand, on a Linux Docker host:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/repo -w /repo   -e MELETE_CONFORMANCE_DOCKER=1 oven/bun:$(cat .bun-version)   bun test conformance/scenarios/09-stdio-mcp.test.ts --timeout=300000
```

| Scenario | What runs | Named assertions |
| --- | --- | --- |
| 9: [stdio MCP](scenarios/09-stdio-mcp.test.ts) | A probe MCP server in `node:22-alpine` with no destinations and with one, a server that exits on its own, and `@modelcontextprotocol/server-filesystem` fetched by `npx`; four tests | `with no destination named it is unprivileged, alone with its volume, and reaches nothing`; `with one destination named it reaches that one through the proxy and nothing else`; `a server that exits leaves no container, and removal takes its volume`; `an npm package is fetched through the registry grant, then runs with no network` |

The probe reports from inside its container: its uid, its effective
capabilities, `NoNewPrivs`, the seccomp mode, whether the root and its volume
are writable, whether the Docker socket exists, its network interfaces, a TCP
connection to a public address, its environment and its cgroup limits. The
test also reads the engine's own record of each container and network.

## Static configuration checks

```bash
bun run compose:check
```

This reads YAML and checks 23 declarations. Its test `passes every boundary
check` and its mutation tests exercise the checker. The label printed as “no
route out” means the internal-network flag was found; scenario 6 is what
establishes live enforcement, on the host where it runs.

The [memory runner](memory/README.md) is a separate suite with a withheld-memory
arm.
