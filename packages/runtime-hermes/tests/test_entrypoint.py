"""Boot configuration must select the gateway in the pinned resolver's model section."""
import builtins
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


def boot(tmp_path, monkeypatch, template_config, environment):
    """Run the boot program from entrypoint.sh over a template and return what it wrote.

    JSON is sufficient here: it exercises the actual boot program independently
    of YAML's codec.
    """
    script = (Path(__file__).parents[1] / "entrypoint.sh").read_text()
    source = script.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    template = tmp_path / "template.json"
    target = tmp_path / "config.json"
    template.write_text(json.dumps(template_config))
    native_open = builtins.open

    def scoped_open(path, *args, **kwargs):
        if str(path) == "/opt/melete-runtime/config.yaml":
            path = template
        return native_open(path, *args, **kwargs)

    monkeypatch.setitem(sys.modules, "yaml", SimpleNamespace(
        safe_load=json.load,
        safe_dump=lambda value, stream, **kwargs: json.dump(value, stream),
    ))
    monkeypatch.setattr(builtins, "open", scoped_open)
    monkeypatch.setattr(sys, "argv", ["-", str(target)])
    for variable in (
        "MELETE_ENGINE_CONTEXT_LENGTH",
        "MELETE_ENGINE_COMPACTION_THRESHOLD",
        "MELETE_ENGINE_MAX_TURNS",
        "MELETE_MODEL_API_MODE",
    ):
        monkeypatch.delenv(variable, raising=False)
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    exec(compile(source, "entrypoint.sh", "exec"), {})
    return json.loads(target.read_text())


BASE_ENVIRONMENT = {
    "MELETE_ATTEMPT_TOKEN": "fixture-capability",
    "MELETE_BROKER_URL": "http://broker:19188",
}

TEMPLATE = {
    "model": {"max_tokens": 4096, "context_length": 1000000},
    "compression": {"enabled": True, "threshold_tokens": 200000},
    "agent": {"max_turns": 150},
    "providers": {"melete-gateway": {"key_env": "MELETE_MODEL_KEY"}},
}


@pytest.mark.parametrize("provider,model", [
    ("scripted", "scripted"),
    ("fireworks", "accounts/fireworks/models/deepseek-v4p1-flash"),
])
def test_boot_config_selects_only_the_scoped_gateway(tmp_path, monkeypatch, provider, model):
    config = boot(tmp_path, monkeypatch, TEMPLATE, {
        **BASE_ENVIRONMENT,
        "MELETE_MODEL_PROVIDER": provider,
        "MELETE_MODEL_NAME": model,
        "MELETE_MODEL_API_MODE": "chat_completions",
    })
    assert config["model"]["provider"] == "melete-gateway"
    assert config["model"]["default"] == model
    assert config["model"]["max_tokens"] == 4096
    assert config["providers"]["melete-gateway"]["base_url"] == f"http://broker:19188/providers/{provider}/v1"
    assert config["providers"]["melete-gateway"]["key_env"] == "MELETE_MODEL_KEY"
    assert config["providers"]["melete-gateway"]["extra_headers"] == {"x-melete-capability": "fixture-capability"}


def test_boot_config_carries_capability_in_model_headers(tmp_path, monkeypatch):
    """The compaction summary call is built by an auxiliary client that reads
    `model.extra_headers` and never the provider entry, so a capability written
    only under the provider reaches the gateway without one and is refused."""
    config = boot(tmp_path, monkeypatch, TEMPLATE, {
        **BASE_ENVIRONMENT,
        "MELETE_MODEL_PROVIDER": "fireworks",
        "MELETE_MODEL_NAME": "accounts/fireworks/models/deepseek-v4p1-flash",
    })
    header = {"x-melete-capability": "fixture-capability"}
    assert config["model"]["extra_headers"] == header
    assert config["providers"]["melete-gateway"]["extra_headers"] == header


def test_boot_config_takes_the_window_and_trigger_it_is_given(tmp_path, monkeypatch):
    """The model an attempt is granted decides its window, and the window decides
    the compaction trigger. Whatever starts the container renders both and passes
    them in; the image's own copy is only the default."""
    config = boot(tmp_path, monkeypatch, TEMPLATE, {
        **BASE_ENVIRONMENT,
        "MELETE_MODEL_PROVIDER": "fireworks",
        "MELETE_MODEL_NAME": "a-smaller-model",
        "MELETE_ENGINE_CONTEXT_LENGTH": "128000",
        "MELETE_ENGINE_COMPACTION_THRESHOLD": "96000",
        "MELETE_ENGINE_MAX_TURNS": "150",
    })
    assert config["model"]["context_length"] == 128000
    assert config["compression"]["threshold_tokens"] == 96000
    assert config["compression"]["enabled"] is True
    assert config["agent"]["max_turns"] == 150


def test_boot_config_keeps_the_image_defaults_when_nothing_is_passed(tmp_path, monkeypatch):
    config = boot(tmp_path, monkeypatch, TEMPLATE, {
        **BASE_ENVIRONMENT,
        "MELETE_MODEL_PROVIDER": "fireworks",
        "MELETE_MODEL_NAME": "accounts/fireworks/models/deepseek-v4p1-flash",
    })
    assert config["model"]["context_length"] == 1000000
    assert config["compression"]["threshold_tokens"] == 200000
    assert config["agent"]["max_turns"] == 150


@pytest.mark.parametrize("variable", [
    "MELETE_ENGINE_CONTEXT_LENGTH",
    "MELETE_ENGINE_COMPACTION_THRESHOLD",
    "MELETE_ENGINE_MAX_TURNS",
])
def test_boot_refuses_a_number_it_cannot_read(tmp_path, monkeypatch, variable):
    """Ignoring a malformed number would leave the engine compacting against one
    window while the attempt is metered against another."""
    with pytest.raises(SystemExit):
        boot(tmp_path, monkeypatch, TEMPLATE, {
            **BASE_ENVIRONMENT,
            "MELETE_MODEL_PROVIDER": "fireworks",
            "MELETE_MODEL_NAME": "accounts/fireworks/models/deepseek-v4p1-flash",
            variable: "many",
        })
