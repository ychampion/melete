"""Boot configuration must select the gateway in the pinned resolver's model section."""
import builtins
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("provider,model", [
    ("scripted", "scripted"),
    ("fireworks", "accounts/fireworks/models/deepseek-v4p1-flash"),
])
def test_boot_config_selects_only_the_scoped_gateway(tmp_path, monkeypatch, provider, model):
    script = (Path(__file__).parents[1] / "entrypoint.sh").read_text()
    source = script.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    template = tmp_path / "template.json"
    target = tmp_path / "config.json"
    template.write_text(json.dumps({"model": {"max_tokens": 4096}, "providers": {"melete-gateway": {"key_env": "MELETE_MODEL_KEY"}}}))
    native_open = builtins.open

    def scoped_open(path, *args, **kwargs):
        if str(path) == "/opt/melete-runtime/config.yaml":
            path = template
        return native_open(path, *args, **kwargs)

    # JSON is sufficient here: exercise the actual boot program independently of YAML's codec.
    monkeypatch.setitem(sys.modules, "yaml", SimpleNamespace(
        safe_load=json.load,
        safe_dump=lambda value, stream, **kwargs: json.dump(value, stream),
    ))
    monkeypatch.setattr(builtins, "open", scoped_open)
    monkeypatch.setattr(sys, "argv", ["-", str(target)])
    monkeypatch.setenv("MELETE_MODEL_PROVIDER", provider)
    monkeypatch.setenv("MELETE_MODEL_NAME", model)
    monkeypatch.setenv("MELETE_MODEL_API_MODE", "chat_completions")
    monkeypatch.setenv("MELETE_ATTEMPT_TOKEN", "fixture-capability")
    monkeypatch.setenv("MELETE_BROKER_URL", "http://broker:19188")
    exec(compile(source, "entrypoint.sh", "exec"), {})
    config = json.loads(target.read_text())
    assert config["model"] == {"provider": "melete-gateway", "default": model, "max_tokens": 4096}
    assert config["providers"]["melete-gateway"]["base_url"] == f"http://broker:19188/providers/{provider}/v1"
    assert config["providers"]["melete-gateway"]["key_env"] == "MELETE_MODEL_KEY"
    assert config["providers"]["melete-gateway"]["extra_headers"] == {"x-melete-capability": "fixture-capability"}
