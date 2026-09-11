# Lane W16b: the web app, built from the design canvas

Append-only. Every line names a SHA, a command, a test, or a log excerpt.

## Assumptions
- The experience contract (`packages/contracts/src/experience.ts`, lane W16a) had not landed when this lane started (`git ls-remote --heads origin 'lane/w16a*'` returned nothing at 2026-09-12). The web app builds against `apps/web/src/experience/types.ts`, shaped as `docs/design/INTEGRATION.md` describes, behind one adapter (`apps/web/src/experience/adapter.ts`). When the contract lands, the adapter is the one file to change.
- The mock serves the designed surfaces under `/surfaces/*` from `apps/mock-api/src/surfaces.ts`. Those routes are validated with the mock's own zod schemas rather than `openapi.json`, because the contract paths do not exist yet. Conversations run through the real job state machine: a conversation is a job, and the trail, cards, permissions and receipts are derived from the job's persisted events, so the approval-card rule and the unknown-outcome rule hold in the new interface exactly as they did in the reference client.
- Surfaces the brief does not design (Inbox, Messages, Calendar page, Files) are not built and are not offered in the navigation. The mock reports them unavailable.
- Screenshots are taken with Playwright 1.63 (already installed on this machine) via `bun run --cwd apps/web screens`, rather than the gstack browse skill, so the run is a committed script anyone can repeat.

## Log
- 23dc3fb design system: tokens.css, base.css, primitives.tsx, icons.tsx (78 icons), logos.tsx (19 logos), face.tsx, mark.tsx, Sheet.tsx at #/design. `bun run --cwd apps/web typecheck` and `bunx biome check apps/web` clean.
- da1ffa1 mock: `apps/mock-api/src/surfaces.ts` serves `/experience/*`; scenario schema gained `say`, `card`, `draft`, `ask`, `browser` and `title`/`active_title`/`meta`/`sources` on `tool` (additive; the jump `label` field kept its name); runner gained `pauseJob`/`resumeJob`; five scenario files added (`dinner-with-friends`, `book-a-table`, `kyoto-in-october`, `passport-renewal`, `welcome`), the two original scenarios unchanged. `bun test apps/mock-api`: 30 pass, 0 fail.
- da1ffa1 smoke (node script against the running mock): dinner conversation reaches `block permission` with `title "Nova wants to add an event to Google Calendar"`, fields `[duration, place, title, when]`; `POST /experience/permissions/{id}` with `always` → 200, then `block_updated status allowed_always`, `block receipt "Added to your calendar"`, `trail_step done "Worked for 1s · calendar, web, Maps, Messages · 11 sources"`, rule `"Nova may add an event to Google Calendar without asking"` listed by `GET /experience/rules`; undo → 200; the follow-up "Perfect, book it and remind me at 6." reaches `block browser status working` then a `browser.reserve` permission.
- da1ffa1 smoke unknown-outcome: permission `"Melete wants to write one line to the test destination"` fields `[body, subject, to]`; allow once → `block unknown`, `turn_status waiting`; `POST /experience/unknown/{id}/resolve succeeded` → 200, then `trail_step done`, `turn_status done`. The done line is keyed on `job_state_changed → completed`, not on `attempt_ended`, so it never precedes a reconciliation.
- da1ffa1 smoke pause: `POST …/pause` → 200; event count unchanged over 3 s (7 → 7); resume → events advance (13); stop → `job_state_changed cancelled` mapped to `text_final` + `turn_status stopped`.
- dde5861 web app: `apps/web/src/{experience,shell,chat,screens}`; `bun run typecheck` (tsc -b + apps/web) clean; `bunx biome check .` "Checked 329 files … No fixes applied".
- 6144e39 receipts carry `attaches_to` (the card whose button decided the action) and draw under that card; card actions size to 44 px on phones; a missing card image falls back to a placeholder tile; `apps/web/scripts/screens.mjs` added, `bun run --cwd apps/web screens`.
- 8e7710a docs: `docs/CLIENT.md` gained "Rules the web app adds" and the mock's new scenarios and ports; `.agents/notes/0024-web-app.md`; `.agents/notes/proposed/2026-09-12-w16b-experience-shapes.md`; README rows for `apps/web`; `apps/web/.env.example` → `http://localhost:3210`.
- 8e7710a `node apps/web/scripts/screens.mjs` (mock on :3210 with `MOCK_PORT=3210 bun src/index.ts`, vite on :5180): "128 checks, 0 failed" — 22 surfaces × {1440, 1024, 390} × {light, dark} (the phone-only surfaces and the working state at fewer widths), each check = no horizontal overflow (`scrollWidth <= clientWidth + 1`) and zero console errors / page errors. Committed PNGs: 1440 light, 390 light, 1440 dark per surface, 39 files, 6.9 MB, captions in `apps/web/docs/screens/README.md`.
- 8e7710a `bun run --cwd apps/web build`: `✓ built in 483ms`, `dist/assets/index-DkPGgcS7.js 419.67 kB │ gzip: 122.83 kB`.
- W16a check: `git ls-remote --heads origin 'lane/w16a*'` returned nothing at 02:30, 03:40 and 04:20 local; no `packages/contracts/src/experience.ts` to adopt. The adapter stays on `apps/web/src/experience/types.ts`.

## Verification steps, exactly

1. `cd apps/mock-api && MOCK_PORT=3210 bun src/index.ts` (prints the seven scenario ids).
2. `bun run --cwd apps/web dev` (vite on :5180; `VITE_MELETE_API` defaults to :3210).
3. `bun run --cwd apps/web screens` → prints one `ok`/`FAIL` line per surface × viewport × theme and writes `apps/web/docs/screens/`.
4. In the browser: `#/`, type "Find a lovely spot for dinner with Alex and Priya tonight at 7:30." → Nova's trail runs (say, action with sources and logos), the composer shows Pause (rim travelling); after the text streams, the Luna Trattoria card appears with "Add to calendar" (= allow once; More ▾ → Always allow / Don't add it), the draft with "Send via Messages"; press Add to calendar → receipt "Added to your calendar · Tonight 7:30 PM · 1.5 hours · Google Calendar" with Undo; trail collapses to "Worked for Ns · calendar, web, Maps, Messages · 11 sources". Type "Perfect, book it and remind me at 6." → browser card + docked panel (Take control / Stop the task); Settings › Rules shows a rule after an Always.
5. Type "Write one line to the flaky test destination" → permission card built from the canonical payload (body, subject, to) with Allow once / Always allow / Deny; after allow → the unknown-outcome card ("I sent this once and never heard back…") with It arrived / It did not / I can't tell yet.
6. `#/design` for every primitive in every state. `MOCK_BROWSER=off` on the mock: the browser card, the panel and the tour's browser stage are absent. `MOCK_FRESH=1`: sign-in, then the five-step setup, ending in the welcome conversation that references an onboarding answer.

## Not done, and why

- **Save to plan** in the action bar shows a toast saying it is not available on this instance: the mock has no endpoint for it and the contract has none; inventing one would have been a lie about what the backend does.
- **Voice** and **Apple sign-in** are reported unavailable by the mock and therefore not drawn, which is the designed behaviour; both are one capability flag away.
- **Attachment upload progress** is simulated in the composer (no upload endpoint exists yet); the tile, the bar and the mid-upload cancel are real, the bytes go nowhere.
- **Inbox, Messages, a Calendar page, Files** are not built and not in the navigation (not in the brief's surface list).
- **The "Ask Melete about this plan" chat** plays the Kyoto scenario for any plan, because the mock picks scenarios by text; the plan's title is in the message, the answer is not plan-specific.
- The gstack browse skill was not used; Playwright 1.63 was already installed and a committed script is repeatable by anyone.
