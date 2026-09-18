# Engineering notes

One file per decision. The format is deliberately small, because a note nobody
writes is worth nothing:

```
# NNNN - Title

Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Problem
What forced a decision. The constraint, not the wish.

## Decision
What we are doing, in the present tense.

## Alternatives
What else was on the table and why it lost. One line each is fine.

## Evidence
What we actually observed. Commands, versions, probe output, measurements.
"Seemed better" is not evidence.
```

Two rules:

1. **Supersede, never edit history.** A decision that turns out to be wrong gets
   a new note saying so, and the old note gets a `superseded by` line. The record
   of what we believed on a given day is the point.
2. **Evidence or nothing.** If a note has no evidence section worth reading, the
   decision was probably a preference, and preferences do not need notes.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-thin-harness.md) | The harness is thin and the boundary is thick | accepted |
| [0002](0002-pinned-hermes-engine.md) | The v0.1 engine is a pinned, unmodified Hermes release | accepted |
| [0003](0003-postgres-bounded-state-machine.md) | Job state lives in Postgres as a bounded state machine | accepted |
| [0004](0004-compose-internal-network-sandbox.md) | v0.1 isolation is a compose internal network, and we say so | accepted |
| [0005](0005-markdown-knowledge-git-fts.md) | Knowledge is Markdown in git with a per-space FTS5 index | accepted |
| [0006](0006-skill-md-skills.md) | Skills are short Markdown files with triggers | accepted |
| [0007](0007-brokered-typed-effects.md) | Every effect is brokered, hash-bound, and may end unknown | accepted |
| [0008](0008-api-first-client-surface.md) | The product is an API; the UI is a client | accepted |
| [0011](0011-attention-contract.md) | Attention is a contract, not a feed | accepted |
| [0012](0012-provable-memory-properties.md) | Four memory properties the service enforces | accepted |
| [0014](0014-memory-conformance-runner.md) | Memory quality is a suite with a counterfactual arm | accepted |
| [0015](0015-typed-repair.md) | Failures are classified and repaired, not retried | accepted |
| [0016](0016-execution-and-artifacts.md) | Code execution in the cell and artifact validation | accepted |
| [0017](0017-agentic-and-natural.md) | Reply style, reactions, delta briefs, watch predicates, capabilities | accepted |
| [0018](0018-discovery-and-mcp.md) | Discovery over a small core, with MCP and composition behind the broker | accepted |
| [0019](0019-learning-loop.md) | Corrections become episodes and audited procedure candidates | accepted |
| [0020](0020-deployment-evidence.md) | Deployment claims require a running Linux stack | accepted |
| [0021](0021-hermes-capability-audit.md) | What the pinned engine is proven to do, and what awaits proof | accepted |
| [0022](0022-wired-assistant.md) | The ordinary HTTP job runs one pinned engine per attempt | accepted |
| [0023](0023-experience-adapter.md) | The experience API is an adapter over saved work, never a second truth | accepted |
| [0024](0024-browser-worker.md) | A browser worker outside the cell, with recipes and takeover | accepted |
| [0025](0025-web-app.md) | The web app is built from the design canvas, behind one adapter | accepted |
| [0026](0026-engine-forward.md) | Engine surface probes: what the pinned engine actually does | recorded |
