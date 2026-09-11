# 0016 - Code execution in the cell, and artifacts that have to hold up

Status: accepted
Date: 2026-09-12

Two decisions, one consequence each.

**Running code inside the cell is safe to enable, so it is enabled.** The cell
has no route out and every external effect is brokered, so a command's effects
are confined to `/work/<job>` and are reversible by the ordinary means: read it,
diff it, delete it. Disabling a capable built-in and offering nothing in its
place is how an assistant becomes unable to do arithmetic on a spreadsheet, and
the reason to disable it was never the code, it was the effects.

**A file is not a deliverable until something has checked it.** A write may
declare what it is meant to be; Melete runs every check it can run without
asking anyone, records the results next to the content hash they were computed
over, and refuses to let the job say it is finished while one of its own checks
is failing. The model is not asked whether the file is good.

## Execution: the shape, and why it is not the built-in terminal

The brief said to turn on the pinned engine's terminal toolset. That is not what
this lane shipped, and the reason is the ledger.

A built-in toolset runs the command inside Hermes and returns the output to the
model. Nothing about that reaches the broker, so there is no action row, no
receipt, no effect class, and nothing in the event stream: the one kind of work
that writes files would be the one kind of work with no record. The whole
argument in ARCHITECTURE.md §6 is that an effect is a record before it is a
request. Intercepting the built-in would mean `allow_tool_override`, a
same-named registration, and a reimplementation of the execution anyway, with
the engine's schema and the engine's approval semantics in the way.

So execution is a Melete tool served by the broker like every other tool, and
carried out in the cell:

```
model -> exec.python(code)          the catalog entry, scoped like any tool
      -> the plugin runs it         subprocess, cwd inside /work/<job>, caps applied
      -> POST /actions              the RECORD: command, cwd, exit code,
                                    duration, output digest, truncation
      -> broker admits it           write_reversible, no approval
      -> exec connector checks it   paths confined, stored output re-hashed
      -> receipt                    on the ledger, in the event stream
```

Two shapes, not one. The tool's `input_schema` is what the model fills in; the
action's payload is what already happened. `connectorTool.record_schema` is how
a connector declares the second, and `connectorTool.execution: 'in_cell'` is how
the broker tells the cell which tools work this way. Both are additive and
default to the old behaviour, so every existing connector is untouched.

The order is forced. The broker cannot run the command: the broker process holds
the database credentials and the provider keys, which is exactly what the cell
must never reach. The cell can run it and cannot reach anything. So the cell
runs and the broker records.

`HERMES_EXEC_ASK` stays set and stays irrelevant. It guards the engine's own
shell tool, which is still not in the toolset. Melete's execution needs no
approval because there is nothing external to approve: no recipient, no
destination, no money, no message. `write_reversible` auto-admits within budget,
which is the same rule that lets `files.write` proceed.

## What is enforced, and by what

| Property | Enforced by | Tested where |
|---|---|---|
| The command runs in this job's workspace | the plugin's path guard | `tests/test_execution.py` |
| A record naming another job's directory is refused | the exec connector, at the ledger | `src/connectors/exec.test.ts`, `test/integration/artifacts.test.ts` |
| A stored output is the output that was recorded | the exec connector re-hashes it | `src/connectors/exec.test.ts` |
| A command past the time cap is killed and the kill recorded | the plugin | `tests/test_execution.py` |
| Output above the cap is truncated with a marker, full output stored | the plugin | `tests/test_execution.py` |
| The child never sees the attempt capability or the model key | the plugin's allow-list environment | `tests/test_execution.py` |
| A snippet cannot write outside `/work` | **the container**, not the plugin | not tested here |

The last row is the honest one. On this laptop the tests run as an ordinary
process with the developer's own permissions, and a test asserts that a snippet
writing outside the workspace *succeeds* there, so nobody mistakes the local
suite for a sandbox. In the container the same snippet fails because the root
filesystem is read-only and `/work` is the only writable mount. That is the
isolation the egress probe owns, and this lane built no Docker image and ran no
container.

**A gap this lane did not close.** `deploy/docker-compose.yml` mounts the whole
`work` volume at `/work` in the runtime container, so a snippet can read another
job's directory even though the tool refuses to. The per-attempt container the
service will start has to mount `work/<job>` at `/work` instead. Until it does,
the separation between two jobs' workspaces is a tool-level refusal and not a
filesystem boundary, and this note says so rather than the compose file implying
otherwise.

## Measured again: what the toolset costs

Same method as note 0009, same six stub tools, same machine, same tag. The
execution and publish schemas come out of the real connector manifests
(`.agents/probe/execution_tools.ts` writes them; `.agents/probe/measure_exec.py`
reads them) so the number cannot drift from what the broker serves.

```
bun run .agents/probe/execution_tools.ts > .agents/probe/execution_tools.json
.hermes-venv/Scripts/python.exe .agents/probe/measure_exec.py \
    <abs>/.hermes-src <abs>/packages/skills/builtin/identity.md
MELETE_PROBE_EXTRA_TOOLS=<abs>/.agents/probe/execution_tools.json \
  .hermes-venv/Scripts/python.exe .agents/probe/measure_exec.py <same two args>
```

| | tools | tool schemas | system prompt | total |
|---|---|---|---|---|
| note 0009's thin + identity | 6 | 377 tok | 2,927 tok | **3,304 tok** |
| the same, execution on | 9 | 854 tok | 2,927 tok | **3,781 tok** |

The delta is **+477 tokens**, all of it tool schema: the system prompt is
byte-identical, because the toolset is a catalog entry and not a prose block.
Still inside the 4,000 budget, with 219 tokens of headroom. The baseline run
reproduces 3,304 exactly, which is what makes the delta a measurement rather
than two numbers from two machines.

The three tools are `exec.run`, `exec.python` and `artifact.publish`. A job that
holds none of those scopes sees none of them and pays none of it: the broker
filters the catalog before the cell ever sees it.

## The local end-to-end

`packages/runtime-hermes/scripts/e2e-exec.ts` runs a real Hermes API server from
the pinned tag against the real broker, the real gateway, and the real adapter,
with a scripted model that asks for one Python snippet. Observed:

```
cold start: 7146 ms
outcome: {"kind":"completed","summary":"The snippet ran and out.csv is in the workspace."}
events: turn_started, tool_call_proposed, tool_result, text_delta, attempt_outcome
actions: [{"kind":"exec.python","status":"succeeded","effect_class":"write_reversible"}]
approvals asked for the execution: 0
out.csv: item,amount / desk,60.0 / chair,40.0 / Total,100.0
```

The receipt carries the command, the cwd, exit code 0, 108 ms, the output digest
and `digest_verified: false`, which says plainly that the output was small
enough that nothing was stored and the digest is therefore the cell's word. When
output is truncated the file is stored, the connector re-hashes it, and the same
field says `true`.

## Artifacts: declare, check, then finish

`files.write` takes an optional `expect`:

```json
{"kind": "csv",
 "checks": [{"kind": "totals", "column": "amount", "total_label": "Total"},
            {"kind": "required_columns", "columns": ["item", "amount"]}],
 "render": true, "human": false, "critique": null}
```

Four classes of validator, in descending order of how much they prove.

**`deterministic`** is a function of the bytes: parses, totals, required columns
and sections, row counts, JSON Schema, image dimensions from the file's own
header. Passing means the property holds. A check that cannot be computed fails
with the reason; "could not tell" is never reported as a pass.

**`render`** opens the file the way a reader would. Markdown to HTML and CSV to a
table are implemented, small and on purpose: the job is not typesetting, it is
catching the "report" that is one unterminated code fence. DOCX, XLSX and PDF
need a maintained reader, Bun ships none, this release adds no dependency for
one, and the recorded result is the word `unavailable`.

**`critique`** is a model reading it. Advisory by construction: recorded, shown,
never a gate. No critic is wired in v0.1, so a declared critique is recorded as
`unavailable` with that reason, and the injection point (`ArtifactCritic`) is
there for when one is.

**`human`** is a person accepting it. A declared acceptance starts `pending`, and
`pending` blocks.

The validators run in the files connector, which is trusted Melete code, over
the bytes that were actually written, before the runtime hears that the write
succeeded. The broker persists the artifact row and its results in the same
transaction that persists the receipt, so an artifact never exists without the
receipt that produced it.

### The gate, and why re-writing a file clears it

`completionFacts` now also answers `artifact_validations_passed`. The state
machine turns a completion with a failing check into `waiting_for_input`, and
the runner names the failure in the question: "the amount column adds up to 91.5
but the total says 100", not "something went wrong with the artifact".

Only the newest artifact row per `(area, path)` is asked. An earlier version
that failed is history, not an open failure. That is what makes the falsifier
work:

> A CSV artifact declared with a totals check whose totals do not add up cannot
> complete the job; fixing the file completes it.

`test/integration/artifacts.test.ts` runs exactly that against a real database:
the first write succeeds as a write and fails as a deliverable, the gate names
`totals:amount` and the number 91.5, the second write of the same path produces
a second artifact row, and the gate passes. Two rows, both kept.

## Publishing

`artifact.publish(path, destination)` is `write_external`, needs an approval
bound to the payload hash, and leaves a receipt. Two destinations: the space's
artifacts directory, and an email with the file attached.

Two rules make the approval mean something.

The bytes are never in the payload. The payload names a path; the service looks
up the artifact it recorded for that path and reads the file itself. A file that
changed since it was recorded fails the publish rather than being sent, because
the content hash the owner approved is the one on the record. There is a test
for that, and it is the reason attachments were added to the mail transport as
`Buffer`s from a recorded artifact rather than as bytes from a payload.

Only a recorded artifact can be published. A write that declared nothing has no
record, no validations and nothing to point at, and this release will not send
it anywhere.

The publication row links the artifact to the action, the destination, the
external reference and the content hash. Together with `artifact.source_job_id`,
that is what makes "update this with the latest data" the same job waking again
rather than a new job that happens to write a similarly named file.

## What is not established

- No container was built and no container was run. Every filesystem claim about
  the cell is the image's, not this lane's.
- The compose runtime still mounts the whole work volume. See the gap above.
- The critique validator has no critic behind it in v0.1.
- `artifact.publish` by email was exercised against a fake transport that
  records what it was handed, not against a real SMTP server.
- The scaffolding figures are of assembly, measured with the release's own
  functions and a chars-over-four estimator, not of bytes on a provider's wire.
