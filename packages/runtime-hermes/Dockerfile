# The Melete runtime: pinned Hermes configured thin with an observer-only bridge.
#
# The three source seams in patches/observer_bridge.py are checked against the
# audited pin before application. They add compaction observation and bind the
# plugin's observers to the HTTP run queue. They change no broker decision.
# Thin configuration keys are cited in .agents/notes/0009-hermes-surface.md.
#
# The container has no route to the internet. docker-compose attaches it only to
# the `internal` network, whose sole reachable peer is the Melete broker.
# Conformance scenario 6 asserts that from inside the container, and this file
# assumes it.
#
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS base

ARG HERMES_TAG=v2026.9.7
ARG HERMES_REPO=https://github.com/NousResearch/hermes-agent.git

# The commit the tag resolved to on 2026-09-11. Recorded so a rebuild that
# produces something else is visible rather than silent: a moved tag is the one
# way a "pinned, unmodified release" stops being either.
ARG HERMES_COMMIT=2237be355906fbe6065ce1815711eee52b2d646e
# The digest over melete_plugin/, asserted by build-metadata.py during the
# build. `bun run compose:check` recomputes it from the tracked files and names
# the value to paste here, so a plugin change without a new pin fails before an
# image is built.
ARG MELETE_PLUGIN_SHA=4f5895586551028fff54484d8822509e65bc2b7832b10d97e8208a67f37a8066

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HERMES_HOME=/var/lib/hermes \
    UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# git fetches the pinned tag; ca-certificates verifies the clone. The cell's
# network, filesystem and tool boundaries are enforced separately below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /usr/local/bin/uv

WORKDIR /opt/hermes

# The upstream container install path, followed exactly: resolve the locked
# dependency set, then link the project itself. --frozen means the build fails
# if uv.lock and pyproject.toml disagree rather than resolving something new.
# The commit check turns a moved tag into a failed build.
RUN git clone --depth 1 --branch "${HERMES_TAG}" "${HERMES_REPO}" /opt/hermes \
    && test "$(git -C /opt/hermes rev-parse HEAD)" = "${HERMES_COMMIT}" \
    && git -C /opt/hermes rev-parse HEAD > /opt/hermes/.melete-hermes-commit \
    && uv sync --frozen --no-install-project --extra messaging \
    && uv pip install --python /opt/hermes/.venv/bin/python --no-cache-dir --no-deps -e "." \
    && test -x /opt/hermes/.venv/bin/hermes \
    && /opt/hermes/.venv/bin/python -c "import aiohttp, yaml" \
    && rm -rf /root/.cache/uv

# The plugin and the config, staged where the entrypoint can sync them into the
# writable HERMES_HOME. They are not copied straight there because that path is
# a volume at run time and a volume mount would hide whatever the image put
# underneath it.
COPY melete_plugin/ /opt/melete-runtime/melete_plugin/
COPY runtime_support/ /opt/melete-runtime/runtime_support/
COPY patches/ /opt/melete-runtime/patches/
RUN python /opt/melete-runtime/patches/observer_bridge.py /opt/hermes
COPY config/config.yaml /opt/melete-runtime/config.yaml
COPY config/SOUL.md /opt/melete-runtime/SOUL.md
COPY entrypoint.sh /usr/local/bin/melete-runtime-entrypoint
COPY build-metadata.py /opt/melete-runtime/build-metadata.py
COPY healthcheck.py /opt/melete-runtime/healthcheck.py
RUN python /opt/melete-runtime/build-metadata.py "${HERMES_COMMIT}" "${MELETE_PLUGIN_SHA}"
RUN chmod +x /usr/local/bin/melete-runtime-entrypoint

# Approvals for the shell-command guard must surface over HTTP rather than
# hard-denying with nobody asked. Melete's own tool approvals never come through
# this path: a broker tool returns a structured needs-approval result and the
# job parks on Melete's ledger. This is a safety net for a command that should
# not exist in this toolset at all.
#
# HERMES_BUNDLED_SKILLS names a directory that does not exist and is never
# created. The engine copies its own bundled skills into the writable home on
# every start; pointing the source at nothing makes that copy do nothing, so the
# only skills an attempt can ever see are the ones Melete authorised.
ENV HERMES_EXEC_ASK=1 \
    HERMES_ACCEPT_HOOKS=1 \
    HERMES_BUNDLED_SKILLS=/opt/melete-runtime/no-bundled-skills \
    API_SERVER_ENABLED=1 \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8790 \
    MELETE_BROKER_URL=http://melete:8788 \
    HTTP_PROXY=http://melete:8788 \
    HTTPS_PROXY=http://melete:8788 \
    NO_PROXY=melete,localhost,127.0.0.1

# MELETE_ATTEMPT_TOKEN, MELETE_ATTEMPT_ID, MELETE_JOB_ID and MELETE_MODEL_KEY
# are set per attempt by whatever starts the container. The entrypoint refuses
# to start without the token and the job id, because a runtime that cannot name
# its attempt cannot be metered or fenced.

# Non-root. compose adds read_only, cap_drop, no-new-privileges and the limits;
# /work and HERMES_HOME are the only writable paths, plus a small tmpfs on /tmp.
RUN useradd --uid 10001 --create-home --home-dir /home/runtime runtime \
    && mkdir -p /work /var/lib/hermes \
    && chown -R runtime:runtime /work /var/lib/hermes

LABEL org.opencontainers.image.title="melete-runtime" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Pinned Hermes release configured thin behind Melete's RuntimeAdapter" \
      com.melete.hermes.tag="${HERMES_TAG}" \
      com.melete.hermes.commit="${HERMES_COMMIT}" \
      com.melete.plugin.sha256="${MELETE_PLUGIN_SHA}" \
      com.melete.hermes.repository="${HERMES_REPO}"

USER runtime
WORKDIR /work

# The internal port the broker side of compose reaches. Never published.
EXPOSE 8790

ENTRYPOINT ["/usr/local/bin/melete-runtime-entrypoint"]
CMD ["hermes", "gateway", "run"]
