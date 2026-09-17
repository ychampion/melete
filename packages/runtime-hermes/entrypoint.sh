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
set -eu

: "${HERMES_HOME:?HERMES_HOME must be set}"
: "${MELETE_ATTEMPT_TOKEN:?MELETE_ATTEMPT_TOKEN must be set}"
: "${MELETE_JOB_ID:?MELETE_JOB_ID must be set}"

mkdir -p "$HERMES_HOME/plugins"
rm -rf "$HERMES_HOME/plugins/melete"
cp -R /opt/melete-runtime/melete_plugin "$HERMES_HOME/plugins/melete"

python - "$HERMES_HOME/config.yaml" <<'PY'
import os, sys, yaml

config = yaml.safe_load(open("/opt/melete-runtime/config.yaml", encoding="utf-8"))
provider = config.setdefault("providers", {}).setdefault("melete-gateway", {})
name = os.environ.get("MELETE_MODEL_PROVIDER", "fireworks")
model = os.environ.get("MELETE_MODEL_NAME", "accounts/fireworks/models/deepseek-v4p1-flash")
if not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in name):
    raise SystemExit("Invalid model provider name")
# The pinned resolver reads model.provider, not a top-level provider field.
config.pop("provider", None)
model_config = config.get("model")
config["model"] = {**(model_config if isinstance(model_config, dict) else {}), "provider": "melete-gateway", "default": model}
provider["default_model"] = model
provider["base_url"] = os.environ["MELETE_BROKER_URL"].rstrip("/") + "/providers/" + name + "/v1"
api_mode = os.environ.get("MELETE_MODEL_API_MODE")
if api_mode:
    provider["api_mode"] = api_mode
# The capability is a per-attempt secret and is never written into the image.
provider.setdefault("extra_headers", {})["x-melete-capability"] = os.environ["MELETE_ATTEMPT_TOKEN"]
with open(sys.argv[1], "w", encoding="utf-8") as out:
    yaml.safe_dump(config, out, sort_keys=False)
PY

exec "$@"
