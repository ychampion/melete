# Docker deployment

Copy `.env.example` to `.env` and fill in the required keys and database settings.
Set `DOCKER_GID` to `stat -c %g /var/run/docker.sock` on the Docker host. There is
no default group; Compose refuses an unset or empty value. From this directory,
run `docker compose up --build`. Docker 27 or later is required for job volume
subpaths. See the root README for provider configuration and local development.

The service receives `/var/run/docker.sock`. This grants **host-root equivalent**
authority: it can instruct Docker to start privileged containers or mount host
filesystems. The service and its trusted supervisor are inside the host trust
boundary. Running the service as a non-root user with the socket's group does not
contain a compromised service. Attempt containers receive no Docker socket and
are launched with the separately tested isolation flags.

The static Compose checks and launch argument tests run without Docker. A live
image build and runtime network test still require a Docker host; neither is
claimed as verified by those checks.
