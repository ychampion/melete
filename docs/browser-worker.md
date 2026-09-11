# Browser worker

The `browser` connector sends semantic actions to a separate Node 24 process that
owns Chromium. The runtime receives broker tools and artifact handles. It receives
neither a Playwright connection nor the worker token. The service owns the lease,
approval, action identity, trust-origin checks, and job state; the worker enforces
the control epoch immediately before input dispatch.

## Install and configure

From the repository root, install the pinned dependencies and Chromium:

```sh
bun install
bunx playwright install chromium
```

Playwright 1.63.0 is a development dependency at the root and a runtime dependency
of the service. `deploy/Dockerfile.browser` installs the same pinned version with
Node 24.14.0 and Linux browser dependencies using
`playwright install --with-deps chromium`. The browser version must match the
library version. See the [Playwright image instructions](https://playwright.dev/docs/docker).

Create an active `web` connection in the intended space, then add its id to the
owner-controlled `connections.json` configured by `MELETE_CONNECTIONS_FILE`:

```json
[
  {
    "kind": "browser",
    "id": "conn_replace_with_your_connection_id"
  }
]
```

The existing `web` provider contract is reused; this entry selects the `browser`
manifest and its `browser.*` scopes. An ordinary `web` connection without this
entry keeps its existing behavior. Set these service variables for one space:

```dotenv
MELETE_BROWSER_URL=http://browser:3132
MELETE_BROWSER_SPACE=sp_replace_with_your_space_id
MELETE_BROWSER_TOKEN=replace_with_a_random_token_of_at_least_32_characters
```

The token belongs only in service and worker configuration. `connections.json`
can instead select an endpoint with `worker_url` and the name of a token variable
with `worker_token_env`; it never contains the token itself. Use a distinct worker,
token, and control network for each space. Production refuses a browser connection
without an isolated endpoint. A configured URL is operator-controlled: the service
does not inspect the remote host's uid, container, or mounts.

For development, `NODE_ENV=development` or `test` may start a local Node child
automatically. Its environment is restricted to OS essentials and browser
configuration, and shutdown terminates it. On Windows it still runs as the same
OS user as the service. This is a development process boundary, not filesystem or
network isolation from that user's other files and processes.

## Container deployment

Use the browser override together with the base file:

```sh
bun run deploy/scripts/browser-compose-check.ts
docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.browser.yml config --quiet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml -f deploy/docker-compose.browser.yml up --build
```

Set `MELETE_BROWSER_SPACE` and `MELETE_BROWSER_TOKEN` in `deploy/.env` alongside
the existing base configuration. These commands run from the repository root.

The worker has uid/gid `10003:10003`, distinct from the runtime's uid 10001 and
the service image's uid 10002. Its only persistent mount is the named `spaces`
volume's `MELETE_BROWSER_SPACE` subdirectory at `/space`; it cannot enumerate
the volume's root or mount a sibling space. The profile and session record live
under `/space/browser`. The [Compose volume subpath option](https://docs.docker.com/reference/compose-file/services/#volumes)
requires that the subdirectory already exist. Before starting the worker, create
the space through the service and provision its `browser` subdirectory as
uid/gid 10003 with mode 0700. Keep the space root traversable by that uid and
preserve its existing service ownership. Do not change ownership recursively or
mount the entire volume to work around a permission error. This setup is a host
operator task; the worker does not receive the Docker socket or a root setup step.

The root filesystem is read-only, capabilities are dropped, and new privileges
are denied. Chromium uses bounded private `/tmp` and `/dev/shm` storage, a pid
limit, a memory limit, and an init process. The worker receives only its space id,
`/space`, control token, listener address, port, and Chromium installation path.
It receives no database URL, vault key, provider key, runtime token, global
artifacts mount, or runtime work volume.

`browser-control` is an internal network shared only by Melete and this worker.
The worker also joins its own `browser-egress` network for internet access. It
does not join `internal` or `edge`, and it publishes no ports. Docker networking
does not make the shared control network directional: a compromised worker can
connect to the Melete service ports on that network. The worker token authenticates
the worker listener only; it is not an owner session or a broker capability.
The service's API and broker authentication remain necessary boundaries.

The service health-checks the endpoint before leasing it and releases its session
on shutdown. Compose owns the isolated process lifetime. Chromium remains warm
until its idle deadline, five minutes by default; a new session invalidates the
previous epoch. `MELETE_BROWSER_IDLE_MS` adjusts the development child timeout.
Private-context sessions can reuse the signed-in profile, while the public-web
compartment uses a separate disposable context without those cookies.

## Tools and control

| Broker tool | Effect | Behavior |
| --- | --- | --- |
| `browser.observe` | `read` | Obtain the session and epoch, an accessibility tree, and a downscaled screenshot as artifact handles. |
| `browser.open` | `read` | Navigate to an allowed public HTTP(S) destination. |
| `browser.fill` | `write_reversible` | Fill one exact visible accessible label. |
| `browser.click` | `write_reversible` | Click one exact role and name; consequential controls require `submit`. |
| `browser.select` | `write_reversible` | Select one exact labeled control. |
| `browser.read` | `read` | Read a visible selector or role/name. |
| `browser.submit` | `write_external` | Commit the exact approved form intent once. |

Initially call `browser.observe` with `{}`. Subsequent inputs include `session_id`
and the `control_epoch` under which they were planned. A refresh uses
`after_observation` equal to the last observation id, so the broker can distinguish
a new observation from a retry of the same read. `open`, `fill`, `click`, and
`select` require that marker too; observe before repeating an earlier edit.
`browser.read` accepts the same refresh marker. Meaningful transitions, including
accessible label changes, produce another observation; ordinary
fills do not require an observation after every keystroke.

An observed submit intent contains `url`, `method`, `role`, `name`, `form_hash`,
`body_sha256`, and the complete `fields`. Admission uses the existing approval,
intent-key, and trust-origin rules, including values in hidden form fields. The
worker constructs the approved fields and outgoing bytes from the same form
entries so page scripts cannot substitute their own serializer. The controller
checks the current form against that intent again before dispatch. This version supports one native URL-encoded
POST form submission. Other submission protocols stop; arbitrary JavaScript,
uploads, remote CDP, and a general HTTP proxy are not exposed as tools. A lost
commit acknowledgement remains unknown and requires reconciliation; it is not
retried as a fresh submit.

An owner-authenticated `POST /browser/sessions/{id}/takeover` increments the
controller's epoch immediately and parks the job as `waiting_for_input`.
Queued inputs keep their original epoch and are refused after the bump. The
controller checks again after locator waits, adjacent to each dispatched input;
the model cannot opt out. `POST /browser/sessions/{id}/handback` increments the
epoch again and requires a fresh observation. The job stays parked until the
person supplies input. An operator-owned worker display can run headed Chromium
with `MELETE_BROWSER_HEADLESS=false`; the person can use that display to enter
credentials while automation is fenced. The supplied Compose worker remains
headless. The network guard also refuses unbrokered requests during takeover;
interactive sign-in remains unsupported. Takeover enforces control fencing.
A remote desktop transport or login UI is not included.

Recipes store ordered semantic steps and their visible schema, not filled values.
A version must be checked before reuse. Reordering controls preserves schema
identity; one reviewed safe label alias may resolve a rename. An unexpected
required field or ambiguous submit control stops before any effect. Other schema
mismatches fall back to observing each action and produce a repair candidate.
Authentication fields and factors are rejected from recipes and episode records.
The signed-in Chromium profile may still contain session cookies; it is private
space data and is not a recipe.

## Network and evidence limits

Chromium uses a fail-closed proxy configuration. The worker relay applies the web
connector's public-address rules to every destination and redirect and pins the
checked DNS address for transport. Private context additionally requires an
allowed domain. Reversible inputs cannot send network requests; an approved
submit permits one matching mutation. Service workers and WebSockets are blocked.
Document GET redirects and POST 302/303 redirects are followed through fresh,
guarded navigation. Redirected subresources and mutation-preserving redirects
stop rather than replaying an unapproved request.
These are checks in trusted worker code, not an OS firewall for a compromised
worker. Internet access is intentional, and a compromised worker can use its
own sockets. See the [browser threat boundary](THREAT-MODEL.md#browser-worker-boundary).

Run the checks without Docker:

```sh
bun test --max-concurrency=2 deploy/scripts/browser-compose-check.test.ts
bun test --max-concurrency=2 apps/melete/src/workers/browser
bun test --max-concurrency=2 apps/melete/test/integration
```

Browser-dependent tests become `todo` with an install reason when Chromium is
absent, including CI. The integration fixture uses `DATABASE_URL` when supplied
or a throwaway embedded Postgres 17 otherwise; a failed binary download retains
the existing skip fallback. The six local form variants and both observation
modes are measured in [note 0017](../.agents/notes/0017-browser-worker.md), excluding
browser launch and model latency.

The Compose check parses YAML and rejects mutations that broaden networks,
mounts, credentials, uids, or privileges. It does not prove Linux packet filtering,
volume ownership, Chromium startup, or container escape resistance. Docker was
unavailable on the Windows machine for this lane, so the image and combined stack
have not been built or run there. Those deployment checks remain for a Linux host.
