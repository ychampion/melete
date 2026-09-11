# Proposed: the experience shapes the web app needs

The web app in `apps/web` builds against `apps/web/src/experience/types.ts`,
shaped as `docs/design/INTEGRATION.md` describes, and the mock serves them
under `/surfaces/*` (`apps/mock-api/src/surfaces.ts`). No contract file was
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

## Now that the contract has landed: the mapping

`packages/contracts/src/experience.ts` (lane W16a, merged into this branch at
e639b22) carries the same ideas under different names. The web app still runs
against its own shapes in `apps/web/src/experience/types.ts` and the mock's
`/surfaces/*`; the adapter (`apps/web/src/experience/adapter.ts`) is the one
file to retarget, and this table is what that retargeting has to translate.

| This lane (`types.ts`) | Contract (`experience.ts`) | Note |
|---|---|---|
| `TurnStatus` `running` / `waiting` | `turnStatus` `working` / `needs_you` | rename; `idle` is new |
| `UserMessage.delivery` `sending` / `queued` / `failed` | `deliveryState` `sending` / `queued_offline` / `failed_retry` | rename |
| `TrailStep.action` `{ id, label, meta, sources, status }` | `trailStep.action` `{ label, meta, sources }` | the contract has no running state or step id; the interface would draw the action only when it is done, or the contract would gain an optional `status` |
| `Source` `{ app, label, url? }` | `experienceSource` `{ app, title, url?, kind, connection_id }` | `label` → `title`; the logo comes from `connection_id` |
| `TrailStep.done` `{ summary }` | `done` `{ summary, elapsed_ms, apps, source_count }` | the contract carries the parts; the interface composes the line |
| `ResultCardData` `{ overline, rating, facts[], description, chips[], image{src,alt}, primary{effect}, example }` | `resultCard` `{ title, meta, image?, facts[{label,value}], primary_action{kind,handle}, secondary_actions, source_connection }` | the card's decision is `primary_action.kind` (`open/download/send/undo`) with a `handle`, not a permission id; "Example" has no field |
| `ReceiptData` `{ what, where, when, undo{until}, undone, attaches_to }` | `experienceReceipt` `{ what, where, when, undo{handle, valid_until}? }` | undo is a handle; an undone receipt is a new receipt, not a flag |
| `DraftData` `{ recipient{name,initials}, channel, channel_label, body, status }` | `experienceDraft` `{ recipient, cc, bcc, channel: email\|message, body, subject?, connection_id, status }` | `POST /drafts/{id}/send` may answer with a `permission` first |
| `PermissionData` `{ title, detail, connection, rule_text, fields, payload_hash, status }` | `permissionCard` `{ what, why[], options[], version, preview, draft? }` + `POST /permissions/{id}` `{ option, version, bounds? }` | `payload_hash` → `version`; "always" requires `bounds` (count cap, expiry, re-consent days); the canonical fields are shown through `preview` / `draft`, not as rows |
| `QuestionData` `{ title, options[{label,description}], answered }` | `experienceQuestion` `{ text, why[], if_ignored, options[{id,label}] }` + `POST /quick-answers/{id}` `{ option_id }` | answers are option ids; "type your own" goes through `POST /conversations/{id}/messages` |
| `ConversationEvent` (`user_message`, `turn_started`, `turn_status`, `trail_step`, `trail_step_updated`, `text_delta`, `text_final`, `block`, `block_updated`, `reaction`) | `experienceEvent.item` (`say/action/note/done`, `text_delta`, `card`, `receipt`, `permission`, `question`, `status{status, composer}`) | the contract's `status` item carries the composer state; user messages come from `GET /conversations/{id}/messages`; there is no reaction event |
| `Agent.look {color, eyes, shape, image}` | `agentInput {colour, eye_colour, surface, face_image}` | `shape: square` → `surface: rounded`; eyes are a colour, not white/black |
| `MemoryItem.why` | `GET /memory/items/{id}/why` → `memoryExplanation` | a separate call |
| `Plan.milestones[].assignee.name` | `milestoneInput.assignee {kind: person}` | no name for the person |
| `ConnectionData.access` `read/write/draft` | `experienceConnection.access` `read_only/draft_only/asks_before_acting` | rename |
| `Capabilities` | none; each response may be `{ status: 'not_available', reason }` | the interface hides a surface when its call answers `not_available` |
| `/surfaces/session*`, `/surfaces/onboarding/*` | `POST /signin/magic-link`, `…/consume` `{ token }`, `GET/PATCH /profile` | onboarding answers become memory items through the service's own path |

Not in the contract at all (this lane's mock only): browser preview content
(`preview_frame` is a URL there), automation runs' notes and retry, plan
templates, plan `needs_you`, connection `connect`/`disconnect`, rule text with
an agent, the day panel's week strip.
