# The Melete runtime: a pinned, unmodified Hermes release configured thin.
#
# Nothing in this image is patched. Everything that makes it thin is
# configuration: built-in toolsets off, memory and context files off, one
# trusted plugin that registers the broker's tools and nothing else.
#
# The container has no route to the internet. docker-compose attaches it only
# to the `internal` network, whose sole reachable peer is the Melete broker.
# The conformance suite asserts that, and this file assumes it.

FROM python:3.12-slim AS base

ARG HERMES_TAG=v2026.9.7
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HERMES_HOME=/opt/hermes-home \
    UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv \
    PATH=/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin

# git to fetch the pinned tag; ca-certificates for the clone; nothing else.
# No shell tooling the agent could reach for, no package manager left behind.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv

WORKDIR /opt/hermes

# The upstream container install path, followed exactly: resolve the locked
# dependency set, then link the project itself. --frozen means the build fails
# if uv.lock and pyproject.toml disagree, rather than resolving something new.
RUN git clone --depth 1 --branch "${HERMES_TAG}" "${HERMES_REPO}" /opt/hermes \
    && git -C /opt/hermes rev-parse HEAD > /opt/hermes/.melete-hermes-commit \
    && uv sync --frozen --no-install-project \
    && uv pip install --no-cache-dir --no-deps -e "."

# The only plugin that loads. It registers the broker's tools; the built-in
# toolsets stay off, so this is the whole of what the model can do.
COPY melete_plugin/ /opt/hermes-home/plugins/melete/
COPY config/config.yaml /opt/hermes-home/config.yaml

# Approvals must surface over HTTP. Without this flag the api_server platform
# is treated as unattended and dangerous commands are refused with no event, so
# the owner never sees a question they could answer. With it, the gateway
# notifier fires with a request_id and both "once" and "deny" resolve.
ENV HERMES_EXEC_ASK=1 \
    MELETE_BROKER_URL=http://melete:8788

# Non-root, and the writable surface is exactly the workspace and the Hermes
# home. compose mounts /work and adds read_only, cap_drop, and no-new-privileges.
RUN useradd --uid 10001 --create-home --home-dir /home/runtime runtime \
    && mkdir -p /work /opt/hermes-home \
    && chown -R runtime:runtime /work /opt/hermes-home

USER runtime
WORKDIR /work

# The internal port the broker side of compose reaches. Never published.
EXPOSE 8790

ENTRYPOINT ["hermes", "gateway", "run", "--platform", "api_server", \
            "--host", "0.0.0.0", "--port", "8790"]
