# W3 — runtime on pinned Hermes

Append-only. Each slice adds a section; nothing above is edited afterwards.

Machine: Windows 11, bun 1.3.13, node 24.14.0, python 3.12.6, uv 0.9.21,
git 2.33.0. **No Docker.** Everything marked unverified stayed unverified.

## Slice 1 — the Hermes surface at the pin

Tag `v2026.9.7` resolves to commit `2237be355906fbe6065ce1815711eee52b2d646e`
(`chore: release v0.21.1 (2026.9.7)`). Installed into `.hermes-venv` with
`uv pip install -e ./.hermes-src`; both directories are gitignored.

Tripwire: **not fired.** Built-ins can be disabled, every route exists, and the
thin scaffolding measures 3,275 tokens against a 4,000 budget.

Measured by `.agents/probe/measure_thin.py` through the release's own
`_get_platform_tools`, `model_tools.get_tool_definitions` and
`agent.system_prompt.build_system_prompt`. Tokens are chars/4.

| configuration | tools | tool schemas | system prompt | total |
|---|---|---|---|---|
| default `hermes-api-server` here | 23 | 8,737 | 3,154 | 11,891 |
| thin, no identity | 6 | 349 | 2,719 | 3,068 |
| thin + Melete identity | 6 | 349 | 2,926 | 3,275 |

Two corrections to what the skeleton assumed, both in
`.agents/notes/0009-hermes-surface.md` with citations: the plugin allow-list key
is `plugins.enabled` (a list, not `plugins.allow` and not a boolean), and
`tools.tool_search.enabled: "off"` is required or the six broker tools are
collapsed behind a `tool_search`/`tool_describe`/`tool_call` bridge.

Checks:

```
$ bun run lint
Checked 171 files in 223ms. No fixes applied.
$ bun run typecheck
tsc -b && tsc -p apps/web/tsconfig.json --noEmit   (clean)
```

## Slice 2 — the Melete plugin

`packages/runtime-hermes/melete_plugin/` is three modules: `broker.py` (the one
socket), `results.py` (the three shapes a broker answer can take), and
`__init__.py` (`register(ctx)`). It imports nothing from Hermes beyond the `ctx`
object, so the compatibility-path removal on 2026-09-14 cannot reach it.

A needs-approval result carries an instruction to stop, because Hermes cannot
suspend a run for days and resume it. A broker that never answered is reported
as `unknown`, not `failed`: a request with no answer may still have been
received, and retrying it is how one approved send becomes two.

Corrected the slice 1 measurement. The probe had registered its stubs with a
bare JSON Schema, but `tools/registry.py:774` builds the definition as
`{**entry.schema, "name": entry.name}`, so what goes in `schema=` is the OpenAI
function body. The corrected numbers are thin 3,093 tokens, thin + identity
3,304, default 11,916. Still under the 4,000 budget. `melete_plugin.tool_schema`
produces the right shape and a test pins it.

`config/config.yaml`, the README and `src/client.ts` were rewritten against what
the tag actually reads. The skeleton's `POST /v1/runs` body carried
`skip_memory`, `skip_context_files`, `toolsets: []`, `max_turns` and `provider`;
none of those are fields on that route, and `_create_agent` takes all of them
from config. The body now carries `input`, `instructions`, `session_id` and
`model`, which is what the engine reads.

Checks:

```
$ bun run test:plugin
18 passed in 9.16s
$ bun test packages/runtime-hermes --max-concurrency=2
24 pass, 0 fail, 45 expect() calls
$ bun run typecheck
(clean)
```
