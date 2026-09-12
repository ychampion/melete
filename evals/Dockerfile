# Reuse the installed pinned engine and add only the repository's checked observer bridge.
ARG EVALS_RUNTIME_BASE=melete-runtime:local
FROM ${EVALS_RUNTIME_BASE}
USER root
COPY runtime_support/ /opt/melete-runtime/runtime_support/
COPY patches/ /opt/melete-runtime/patches/
RUN python /opt/melete-runtime/patches/observer_bridge.py /opt/hermes
USER runtime
