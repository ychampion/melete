# Verification results

Code baseline: `9484023cabd32b786cb4d336dec818f441cd0cc1`.
Durations are observed elapsed times, not limits. “Not recorded” means no total
duration is available; “—” means a test count is not applicable.

| Command | Exit | Counts | Duration |
| --- | --- | --- | --- |
| `bun install` | 0 | 372 packages installed | 32.01 s |
| `bun run typecheck` | 0 | — | Not recorded |
| `bun run lint` | 0 | 307 files checked | 0.894 s |
| `bun test --max-concurrency=2 --timeout=15000` | 0 | 901 pass, 14 todo, 0 fail, 0 skip | 454.72 s |
| `bun run openapi` | 0 | 1 document generated | Not recorded |
| `bun run client:generate` | 0 | 1 declaration file generated | Not recorded |
| `bun run compose:check` | 0 | 12 static checks passed | Not recorded |
| `bun test --max-concurrency=2 --timeout=15000 conformance/scenarios` | 0 | 26 pass, 14 todo, 0 fail, 0 skip | 67.54 s |
| `bun run conformance:memory` | 0 | 10 pass, 10 expected withheld-memory failures, 1 todo | Not recorded |
| `bun test packages/client/src` | 0 | 30 pass, 0 fail | 12.04 s |
| `bun test packages/runtime-hermes/src` | 0 | 42 pass, 0 fail | 1.16 s |
| `bun test apps/mock-api/src/app.test.ts` | 0 | 30 pass, 0 fail | 3.11 s |
| `bun test apps/melete/src/connectors` | 0 | 36 pass, 0 fail | 2.91 s |
| `bun test apps/melete/test/integration/memory.test.ts` | 0 | 42 pass, 0 fail | 60.26 s |
| `bun test apps/melete/test/integration/effects.test.ts` | 0 | 10 pass, 0 fail | 15.03 s |
| `bun test apps/melete/test/integration/attention.test.ts` | 0 | 4 pass, 0 fail | 30.14 s |
| `bun test conformance/memory/breaks.test.ts` | 0 | 4 pass, 0 fail | 22.41 s |

The shorter timeout produced two fixture-hook timeouts and one fixture error:

| Command | Exit | Counts | Duration |
| --- | --- | --- | --- |
| `bun test --max-concurrency=2` | 1 | 900 pass, 14 todo, 2 fail, 1 error | 628.07 s |

Service scenarios 6–8 (14 todos), procedure transfer (1 todo), Python plugin
tests, the container build and live container probes remain **written, not run**.
Static Compose checks do not establish live containment.
