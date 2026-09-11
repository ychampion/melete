# Proposed: the experience shapes the web app needs

The web app in `apps/web` builds against `apps/web/src/experience/types.ts`,
shaped as `docs/design/INTEGRATION.md` describes, and the mock serves them
under `/experience/*` (`apps/mock-api/src/experience.ts`). No contract file was
changed: the experience contract is being defined separately, and these are
the shapes it needs to carry for the designed surfaces to run against a real
service. Everything here is additive.

## Conversations

- `GET /experience/conversations` → summaries: `id, title, agent_id, preview, updated_at, pinned`.
- `GET /experience/conversations/{id}` → the summary plus durable `events`.
- `GET /experience/conversations/{id}/events` → SSE with `id: seq`, honouring `after` and `Last-Event-ID`; text deltas are live-only.
- `POST /experience/conversations` `{ text, agent_id, plan_id? }`; `POST …/{id}/messages` `{ text }`.
- `POST …/{id}/pause | resume | stop`; `POST …/{id}/agent`, `/reactions`, `/rename`, `/pin`; `DELETE …/{id}`.

Event types: `user_message`, `turn_started`, `turn_status`
(`queued | running | streaming | paused | waiting | done | failed | stopped`),
`trail_step`, `trail_step_updated`, `text_delta`, `text_final`, `block`,
`block_updated`, `reaction`.

Trail steps: `say {text}`, `action {label, meta, sources[{app,label,url?}], status}`,
`note {text}`, `done {summary}`. No `thought`.

Blocks: `card`, `receipt` (`what, where, when, undo{until}|null, undone, attaches_to`),
`draft` (`recipient, channel, channel_label, body, status`), `permission`
(`title, detail, connection{app,label}, rule_text, fields, payload_hash, status`),
`question` (`title, options[≤4], answered`), `unknown` (`what, resolution`),
`browser` (`status, url, task, preview, attention`), `notice`, `error {what, done_about_it}`.

## Decisions and receipts

- `POST /experience/permissions/{id}` `{ decision: allow_once | always | deny, payload_hash }` → 409 with a plain sentence on a hash mismatch; `always` creates a rule.
- `POST /experience/receipts/{id}/undo`; `POST /experience/drafts/{id}/send`; `POST /experience/drafts/{id}` `{ body }`.
- `POST /experience/questions/{id}/answer` `{ text }`; `POST /experience/unknown/{id}/resolve` `{ resolution, note }`.
- `POST /experience/browser/{id}/take-control | hand-back | stop`.

## Everything else

`capabilities`, `session` (+ `sign-in`, `complete`, `oauth`, `sign-out`, `profile`),
`onboarding/answers` and `onboarding/complete`, `home`, `day` (+ tasks), `plans`
(+ milestones, complete), `agents` (create, update, delete), `automations`
(toggle, test-run, retry), `memory` (update, delete), `connections` (connect,
disconnect), `rules` (revoke), `search?q=`.

Field names and states are in `apps/web/src/experience/types.ts`.
