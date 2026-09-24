#!/bin/sh
# Two things the image cannot bake in, done at boot because the container is one
# attempt and both values belong to that attempt.
#
# 1. HERMES_HOME has to be writable. The API server's run-idempotency
#    reservations are a SQLite file under it; without a writable path the store
#    falls back to process memory, /v1/capabilities reports
#    runs_idempotency.durable=false, and the Melete adapter refuses to start. A
#    retried POST /v1/runs on a non-durable store is a second run, and a second
#    run is a second set of effects. The image's copy of the config and the
#    plugin is the source of truth and is synced in on every boot, so an
#    upgraded image wins over whatever an older container left behind.
#
# 2. The model gateway meters per attempt, so every inference request has to
#    carry the attempt capability as well as the surrogate. Hermes sends a
#    provider's `extra_headers` on each request, and that is a config value, so
#    the capability is written into the config here rather than shipped in it.
#    It goes into the model section as well, because the auxiliary client that
#    makes the compaction summary call reads only that one: with the provider
#    copy alone the summary request arrives unauthenticated and the compaction
#    aborts.
#
# 3. The window and the compaction trigger follow the model the attempt was
#    granted, which the image cannot know. Whatever starts the container works
#    them out from the one configuration renderer and passes them in.
#
# Everything else the engine is configured to do is in the image's own copy of
# the rendered configuration. This script adds the attempt to it and nothing more.
set -eu

: "${HERMES_HOME:?HERMES_HOME must be set}"
: "${MELETE_ATTEMPT_TOKEN:?MELETE_ATTEMPT_TOKEN must be set}"
: "${MELETE_JOB_ID:?MELETE_JOB_ID must be set}"

mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/melete"
cp -R /opt/melete-runtime/melete_plugin "$HERMES_HOME/plugins/melete"
# Melete's identity is the engine's identity slot. Written on every start, so
# the engine never seeds its own stock persona into a fresh home.
cp /opt/melete-runtime/SOUL.md "$HERMES_HOME/SOUL.md"

python - "$HERMES_HOME/config.yaml" <<'PY'
import os, sys, yaml

config = yaml.safe_load(open("/opt/melete-runtime/config.yaml", encoding="utf-8"))
provider = config.setdefault("providers", {}).setdefault("melete-gateway", {})
name = os.environ.get("MELETE_MODEL_PROVIDER", "fireworks")
model = os.environ.get("MELETE_MODEL_NAME", "accounts/fireworks/models/deepseek-v4p1-flash")
if not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in name):
    raise SystemExit("Invalid model provider name")


def whole(variable):
    """A positive whole number the caller stated, or nothing. A malformed value
    is refused rather than silently ignored: it would leave the engine running
    on the image's default window while the attempt is metered on another."""
    raw = os.environ.get(variable)
    if raw is None or raw == "":
        return None
    if not raw.isdigit() or int(raw) <= 0:
        raise SystemExit(variable + " must be a positive whole number")
    return int(raw)


# The pinned resolver reads model.provider, not a top-level provider field.
config.pop("provider", None)
model_config = config.get("model")
model_section = {**(model_config if isinstance(model_config, dict) else {}), "provider": "melete-gateway", "default": model}
context_length = whole("MELETE_ENGINE_CONTEXT_LENGTH")
if context_length:
    model_section["context_length"] = context_length
threshold = whole("MELETE_ENGINE_COMPACTION_THRESHOLD")
if threshold:
    config.setdefault("compression", {})["threshold_tokens"] = threshold
max_turns = whole("MELETE_ENGINE_MAX_TURNS")
if max_turns:
    config.setdefault("agent", {})["max_turns"] = max_turns
config["model"] = model_section
provider["default_model"] = model
provider["base_url"] = os.environ["MELETE_BROKER_URL"].rstrip("/") + "/providers/" + name + "/v1"
api_mode = os.environ.get("MELETE_MODEL_API_MODE")
if api_mode:
    provider["api_mode"] = api_mode
# The capability is a per-attempt secret and is never written into the image.
# The main agent reads the provider entry; the auxiliary client that makes the
# compaction summary call reads the model section. Both get a copy.
capability = os.environ["MELETE_ATTEMPT_TOKEN"]
provider.setdefault("extra_headers", {})["x-melete-capability"] = capability
model_section.setdefault("extra_headers", {})["x-melete-capability"] = capability
with open(sys.argv[1], "w", encoding="utf-8") as out:
    yaml.safe_dump(config, out, sort_keys=False)
PY

exec "$@"
