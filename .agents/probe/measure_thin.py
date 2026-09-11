"""Measure the thin Hermes configuration at tag v2026.9.7 using the real
prompt-assembly and tool-definition functions. Writes JSON to stdout."""
import json, os, sys, tempfile, textwrap
from pathlib import Path

SRC = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(SRC))
os.chdir(SRC)

HOME = Path(tempfile.mkdtemp(prefix="melete-probe-home-"))
(HOME / "plugins" / "melete").mkdir(parents=True, exist_ok=True)
(HOME / "plugins" / "melete" / "plugin.yaml").write_text(
    "name: melete\nversion: 0.1.0\ndescription: Melete broker tool bridge (probe stub)\n", encoding="utf-8")
(HOME / "plugins" / "melete" / "__init__.py").write_text(textwrap.dedent('''
    TOOLS = [
      ("email.send", "Send an email through the owner's configured mailbox.",
       {"type":"object","properties":{"to":{"type":"array","items":{"type":"string"}},
        "subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]}),
      ("email.search", "Search the owner's mailbox.",
       {"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}),
      ("calendar.create_event", "Create a calendar event.",
       {"type":"object","properties":{"title":{"type":"string"},"start":{"type":"string"},
        "end":{"type":"string"},"attendees":{"type":"array","items":{"type":"string"}}},"required":["title","start","end"]}),
      ("files.write", "Write a file in the job workspace.",
       {"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}),
      ("knowledge.search", "Search what Melete already knows.",
       {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}),
      ("job.finish", "End this attempt with an outcome.",
       {"type":"object","properties":{"kind":{"type":"string"},"summary":{"type":"string"}},"required":["kind","summary"]}),
    ]

    def register(ctx):
        # Hermes merges {"name": entry.name} over `schema`, so the value passed
        # here is the OpenAI function body: description + parameters. This is
        # the same shape melete_plugin.tool_schema produces.
        for name, description, schema in TOOLS:
            ctx.register_tool(name=name, toolset="melete",
                              schema={"description": description, "parameters": schema},
                              handler=lambda **kw: {"ok": True}, description=description, emoji="")
'''), encoding="utf-8")

CONFIG = {
    "platform_toolsets": {"api_server": ["melete"]},
    "plugins": {"enabled": ["melete"], "entries": {"melete": {"enabled": True}}},
    "memory": {"enabled": False},
    "skills": {"enabled": False},
    "tools": {"tool_search": {"enabled": "off"}},
    "agent": {"disabled_toolsets": []},
}
import yaml
(HOME / "config.yaml").write_text(yaml.safe_dump(CONFIG), encoding="utf-8")

os.environ["HERMES_HOME"] = str(HOME)
os.environ["HERMES_SESSION_PLATFORM"] = "api_server"
os.environ.setdefault("OPENAI_API_KEY", "sk-probe-not-a-real-key")
os.environ["HERMES_SKIP_UPDATE_CHECK"] = "1"
os.environ["HERMES_DISABLE_TELEMETRY"] = "1"

result = {"hermes_home": str(HOME)}

import model_tools  # imports trigger discover_plugins()
from hermes_cli.plugins import discover_plugins
discover_plugins()

from hermes_cli.tools_config import _get_platform_tools
from hermes_cli.config import load_config_readonly
cfg = load_config_readonly() or {}
result["config_seen"] = {k: cfg.get(k) for k in ("platform_toolsets", "plugins")}
enabled = sorted(_get_platform_tools(cfg, "api_server"))
result["enabled_toolsets_thin"] = enabled

from tools.registry import registry
result["registered_melete_tools"] = sorted(registry.get_tool_names_for_toolset("melete"))

# --- baseline: the default api_server surface -------------------------------
baseline_tools = model_tools.get_tool_definitions(
    enabled_toolsets=sorted(_get_platform_tools({}, "api_server")), disabled_toolsets=None, quiet_mode=True)
baseline_json = json.dumps(baseline_tools, separators=(",", ":"))
result["baseline"] = {
    "toolsets": sorted(_get_platform_tools({}, "api_server")),
    "tool_count": len(baseline_tools),
    "schema_chars": len(baseline_json),
    "schema_tokens_est": len(baseline_json) // 4,
}

# --- thin: only the plugin toolset ------------------------------------------
thin_tools = model_tools.get_tool_definitions(
    enabled_toolsets=enabled, disabled_toolsets=None, quiet_mode=True)
thin_json = json.dumps(thin_tools, separators=(",", ":"))
result["thin_tools"] = {
    "names": sorted(t["function"]["name"] for t in thin_tools),
    "tool_count": len(thin_tools),
    "schema_chars": len(thin_json),
    "schema_tokens_est": len(thin_json) // 4,
}

# --- system prompt, assembled by the real builder ---------------------------
from agent.system_prompt import build_system_prompt, build_system_prompt_parts

def make_agent(**over):
    from run_agent import AIAgent
    kw = dict(model="gpt-4o-mini", quiet_mode=True, verbose_logging=False,
              platform="api_server", enabled_toolsets=enabled, session_id=None,
              max_iterations=8)
    kw.update(over)
    return AIAgent(**kw)

def measure_prompt(label, **over):
    agent = make_agent(**over)
    prompt = build_system_prompt(agent)
    parts = build_system_prompt_parts(agent)
    tools_json = json.dumps(agent.tools, separators=(",", ":"))
    return {
        "label": label,
        "prompt_chars": len(prompt),
        "prompt_tokens_est": len(prompt) // 4,
        "tool_count": len(agent.tools),
        "tool_names": sorted(t["function"]["name"] for t in agent.tools),
        "tool_schema_chars": len(tools_json),
        "tool_schema_tokens_est": len(tools_json) // 4,
        "total_tokens_est": (len(prompt) + len(tools_json)) // 4,
        "prompt_part_chars": {k: len(v) for k, v in parts.items() if isinstance(v, str)},
        "prompt_head": prompt[:600],
    }

try:
    result["thin_run"] = measure_prompt("thin", skip_memory=True, skip_context_files=True)
except Exception as exc:
    import traceback; result["thin_run_error"] = traceback.format_exc()[-3000:]

try:
    result["default_run"] = measure_prompt(
        "default-api_server", enabled_toolsets=sorted(_get_platform_tools({}, "api_server")))
except Exception as exc:
    import traceback; result["default_run_error"] = traceback.format_exc()[-3000:]

# The same thin toolset with the tool-search bridge left at its default, to show
# what the "off" line in config.yaml is actually buying.
CONFIG_BRIDGE = dict(CONFIG, tools={"tool_search": {"enabled": "auto"}})
(HOME / "config.yaml").write_text(yaml.safe_dump(CONFIG_BRIDGE), encoding="utf-8")
try:
    from hermes_cli import config as _config_mod
    _config_mod._CONFIG_CACHE = None
except Exception:
    pass
model_tools._tool_defs_cache.clear()
bridge = model_tools.get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=None, quiet_mode=True)
bridge_json = json.dumps(bridge, separators=(",", ":"))
result["thin_tools_bridge_on"] = {
    "names": sorted(t["function"]["name"] for t in bridge),
    "tool_count": len(bridge),
    "schema_chars": len(bridge_json),
    "schema_tokens_est": len(bridge_json) // 4,
}
(HOME / "config.yaml").write_text(yaml.safe_dump(CONFIG), encoding="utf-8")
try:
    _config_mod._CONFIG_CACHE = None
except Exception:
    pass
model_tools._tool_defs_cache.clear()

IDENTITY = Path(sys.argv[2]).read_text(encoding="utf-8") if len(sys.argv) > 2 else ""
try:
    agent = make_agent(skip_memory=True, skip_context_files=True, ephemeral_system_prompt=IDENTITY)
    prompt = build_system_prompt(agent, IDENTITY)
    tools_json = json.dumps(agent.tools, separators=(",", ":"))
    result["thin_with_identity"] = {
        "identity_chars": len(IDENTITY), "identity_tokens_est": len(IDENTITY) // 4,
        "prompt_chars": len(prompt), "prompt_tokens_est": len(prompt) // 4,
        "tool_count": len(agent.tools),
        "tool_schema_chars": len(tools_json), "tool_schema_tokens_est": len(tools_json) // 4,
        "total_tokens_est": (len(prompt) + len(tools_json)) // 4,
        "parts": {k: len(v) for k, v in build_system_prompt_parts(agent, IDENTITY).items()},
    }
except Exception:
    import traceback; result["thin_with_identity_error"] = traceback.format_exc()[-2000:]

json.dump(result, sys.stdout, indent=2)
