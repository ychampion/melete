# Browser worker: fixture evidence and measurements

The browser connector drives a warm Chromium in a separate Node process through
the real broker, Postgres 17, and pg-boss. The controller resolves exact visible
accessibility labels and roles, stores observations as artifact handles, and
enforces each input's control epoch immediately before dispatch. Native form
commits require the existing approval, intent identity, and trust-origin gates.

## Measurement method

`apps/melete/test/integration/browser-matrix.test.ts` runs six local HTML variants
in two modes. Both use the same scripted inputs and checked visible-schema guard.
`observe_each` requests a fresh observation before each semantic step;
`checked_recipe` reuses the checked steps and captures meaningful transitions.
This comparison isolates the cost of those additional observations. It does not
measure model inference, planning quality, remote-site latency, or provider cost.
No model latency is included.

Chromium launches and the initial session observation happen before timing starts.
Each row starts after the fixture's job resume and includes navigation, schema
checking, semantic actions, local owner approval, and the receipt or refusal that
parks the job. Takeover timing ends at the verified park; subsequent handback and
fresh-observation assertions run outside that row's time. Local milliseconds are
wall-clock measurements on a shared Windows laptop, not a throughput guarantee.
Each row is one execution. The observe-every-action rows run first, followed by
the checked-recipe rows in the same warm worker; timing values are descriptive.

An observation is counted once by its capture id. Replaying a stored broker
receipt does not count as another capture. Effect counts come from the fixture's
POST destination ledger, independently of the worker's reported disposition.
Successful rows assert zero effects before approval, exactly one after approval,
and still one after the same submit is proposed again.

## Measured fixture rows

Captured on 2026-09-11 at 23:16 UTC from the final
`bun test --max-concurrency=2` run under the shared full-suite lock. All 14 tests
in `browser-matrix.test.ts` passed, including all twelve rows below. The full run
passed 1,048 tests with zero failures and 14 existing todos in 193.92 seconds;
the 180-second target remains unmet. `REPORT.md` preserves earlier fixture
failures and their fixes. The captured data is retained locally in
`.agents/w10b-measurements-final.log`; the earlier 20:41 UTC sample remains in
`.agents/w10b-measurements-verified.log`.

| Mode | Variant | Observations | Local ms | Effects | Disposition | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Observe each | Baseline | 7 | 887 | 1 | Completed | `matched_schema` |
| Observe each | Reordered | 7 | 798 | 1 | Completed | `matched_schema` |
| Observe each | Renamed label | 7 | 767 | 1 | Completed | `safe_alias` |
| Observe each | Unknown required | 2 | 227 | 0 | Stopped | `unknown_required_field` |
| Observe each | Ambiguous Save | 2 | 284 | 0 | Stopped | `ambiguous_control` |
| Observe each | Takeover | 4 | 523 | 0 | Waiting for input | `stale_control_epoch` |
| Checked recipe | Baseline | 4 | 679 | 1 | Completed | `matched_schema` |
| Checked recipe | Reordered | 4 | 578 | 1 | Completed | `matched_schema` |
| Checked recipe | Renamed label | 4 | 680 | 1 | Completed | `safe_alias` |
| Checked recipe | Unknown required | 2 | 247 | 0 | Stopped | `unknown_required_field` |
| Checked recipe | Ambiguous Save | 2 | 262 | 0 | Stopped | `ambiguous_control` |
| Checked recipe | Takeover | 2 | 367 | 0 | Waiting for input | `stale_control_epoch` |

All twelve dispositions matched the expected outcome. Completed checked recipes
used four observations versus seven, and each produced exactly one effect. Every
stopped or takeover row produced zero effects. Replayed submit receipts did not
increase either the observation count or the destination effect count.

## Defensive verification

The reordered form retains its schema, and one explicitly recorded safe alias
resolves the renamed label. An unknown required field and duplicate Save control
produce named refusals, a repair candidate, no executable steps, and zero effects.

For takeover, the fixture changes the worker epoch between two fills while
deliberately delaying the service notification. The second fill therefore reaches
the controller under its original epoch and must return `stale_control_epoch`.
The connector then parks the job as `waiting_for_input`; fresh observation proves
that the rejected text was never entered. Handback increments the epoch again,
and input before another observation returns `fresh_observation_required`.

Additional controller and broker cases refuse credential capture, unapproved
scripted POSTs, changed approved bytes, and redirected destinations that fail the
network policy. Approval receives hidden fields as well as visible ones. The
worker constructs fields and POST bytes from the same entry list; page scripts
cannot replace the serializer used for that binding. Recipes exclude filled
values and authentication factors. Episode redaction resolves browser call ids
from durable events, including after restart and late cancellation receipts.

## Deployment evidence limits

The deployment check and mutation tests inspect the separate uid, restricted
environment, one-space volume subpath, internal control network, distinct internet
network, and absence of runtime or database network membership. No Docker is
available on this Windows host, so image build, combined Compose startup, mount
ownership, and Linux packet isolation remain unexecuted. A same-user development
child is a process boundary only. Production requires an isolated worker endpoint.

Takeover exposes owner-authenticated control routes and controller fencing.
Interactive sign-in is unsupported because unbrokered networking remains closed
during takeover; a remote desktop transport is not included. The first supported
commit protocol is a native URL-encoded POST. Other protocols stop, and uncertain
commits require reconciliation without automatic replay. See
[`docs/browser-worker.md`](../../docs/browser-worker.md) and the browser section
of [`docs/THREAT-MODEL.md`](../../docs/THREAT-MODEL.md) for configuration and limits.
