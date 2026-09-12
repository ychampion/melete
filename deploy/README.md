# Docker deployment

Use the [root README install procedure](../README.md#install-on-a-linux-docker-host)
from the repository root. It requires Docker Engine 28 or newer for the isolated
bridge gateway and Compose 2.33.1 or newer for volume subpaths and gateway
priority. `bun run deploy/scripts/configure.ts --fake` generates `deploy/.env`,
including independent secrets and the socket group. It refuses to overwrite an
existing file. Start with
`docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 180`.
The README explains provider configuration and the first sign-in.

The service receives `/var/run/docker.sock`. This grants **host-root equivalent**
authority: it can instruct Docker to start privileged containers or mount host
filesystems. The service and its trusted supervisor are inside the host trust
boundary. Running the service as a non-root user with the socket's group does not
contain a compromised service. Attempt containers receive no Docker socket and
are launched with the separately tested isolation flags.

The static Compose checks and launch argument tests run without Docker. A live
image build and runtime network test still require a Docker host; neither is
claimed as verified by those checks.
