# Lane W16b: the web app, built from the design canvas

Append-only. Every line names a SHA, a command, a test, or a log excerpt.

## Assumptions
- The experience contract (`packages/contracts/src/experience.ts`, lane W16a) had not landed when this lane started (`git ls-remote --heads origin 'lane/w16a*'` returned nothing at 2026-09-12). The web app builds against `apps/web/src/experience/types.ts`, shaped as `docs/design/INTEGRATION.md` describes, behind one adapter (`apps/web/src/experience/adapter.ts`). When the contract lands, the adapter is the one file to change.
- The mock serves the designed surfaces under `/experience/*` from `apps/mock-api/src/experience.ts`. Those routes are validated with the mock's own zod schemas rather than `openapi.json`, because the contract paths do not exist yet. Conversations run through the real job state machine: a conversation is a job, and the trail, cards, permissions and receipts are derived from the job's persisted events, so the approval-card rule and the unknown-outcome rule hold in the new interface exactly as they did in the reference client.
- Surfaces the brief does not design (Inbox, Messages, Calendar page, Files) are not built and are not offered in the navigation. The mock reports them unavailable.
- Screenshots are taken with Playwright 1.63 (already installed on this machine) via `bun run --cwd apps/web screens`, rather than the gstack browse skill, so the run is a committed script anyone can repeat.

## Log
