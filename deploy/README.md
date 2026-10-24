# Docker deployment

Use the [install procedure](../docs/DEPLOYMENT.md#install-on-a-linux-docker-host)
from the repository root. It requires Docker Engine 28 or newer for the isolated
bridge gateway and Compose 2.33.1 or newer for volume subpaths and gateway
priority. `bun run deploy/scripts/configure.ts` generates `deploy/.env` for a
real model provider whose key is in the environment, including independent
secrets and the socket group, and `--fake` configures a scripted provider for a
demo that needs no model key instead. It refuses to overwrite an
existing file. Start with
`docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 300`.
The README explains provider configuration and the first sign-in.

Compose files of your own go in `compose_files` in `deploy/melete.deploy.json`,
as paths relative to this folder (for example `"../private/compose.extra.yml"`).
The melete command reads them after its own overlays, in the order listed, and
refuses a contract that names one that is missing
([the deploy file](../docs/DEPLOYMENT.md#the-deploy-file)).
`docker-compose.brand.yml` is one: it mounts a brand folder for the
installation's icons, logo and colours
([names and look](../docs/DEPLOYMENT.md#names-and-look)).

`melete-cells` receives `/var/run/docker.sock`, and no other service does. The
socket grants **host-root equivalent** authority, so `melete-cells` holds no
database address and no service key, answers only the `melete` service on a
private network with its key, and starts only the fixed attempt, computer and
MCP server profiles (`apps/melete/src/cells/policy.ts`). The `melete` service
has no socket, and its database role cannot read the `secret` table of
connected accounts' credentials;
`database-roles` sets the roles up and migrates before it starts
([docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md#database-roles)). Attempt containers
receive no Docker socket and are launched with the separately tested isolation
flags.

The static Compose checks and launch argument tests run without Docker. A live
image build and runtime network test still require a Docker host; neither is
claimed as verified by those checks.
