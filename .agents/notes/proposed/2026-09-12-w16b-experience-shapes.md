# Proposed: what the web app still needs from the experience contract

The web app in `apps/web` reads `packages/contracts/src/experience.ts`
through the generated client, and nothing else. The retarget is done:
`apps/web/src/experience/types.ts` is derived from the generated `paths`, the
adapter is the one file that talks to the service, and the mock serves the
same routes seeded with the designed scenarios. This note started as the
shapes the interface was built against before the contract landed; what
remains is the list of surfaces the design draws that the contract does not
carry. Each is hidden today under the same rule as any `not_available`
answer, and each is proposed here as an additive change. Nothing is faked.

## What the interface reads from the contract today

| Surface | Contract |
|---|---|
| Sign-in, profile | `POST /signin/magic-link`, `…/consume`, `POST /signin/google`, `POST /signin/apple` (probed: a `not_available` answer hides the button), `GET/PATCH /profile` |
| Home, day panel | `GET /home` (greeting, upcoming events), `GET/POST/PATCH/DELETE /tasks`, `GET /experience/connections` |
| Chat | `GET/POST /conversations`, `GET …/{id}`, `GET …/{id}/messages`, `POST …/{id}/messages` with `Idempotency-Key`, `POST …/{id}/pause\|resume\|stop`, `PATCH …/{id}/agent`, SSE `GET …/{id}/events?since=` with `Last-Event-ID`; `GET …/{id}/cards\|receipts\|drafts` |
| Decisions | `POST /permissions/{id}` `{option, version, bounds?}`, `POST /receipts/{id}/undo`, `POST /drafts/{id}/send`, `POST /quick-answers/{id}` |
| Plans | `GET/POST /plans`, `GET /plans/{id}`, `PATCH …/milestones/{id}`, `POST /plans/{id}/conversations`, `POST /plans/{id}/share` |
| Agents | `GET/POST /agents`, `PATCH /agents/{id}`, `GET /agents/templates` |
| Automations | `GET/POST /automations`, `POST …/{id}/test`, `POST /automations/morning-brief` |
| Settings | `GET/PATCH/DELETE /memory/items`, `GET …/{id}/why`, `GET /experience/connections`, `GET /rules`, `DELETE /rules/{id}` |
| Search | `GET /search?q=` |

Capabilities are not a contract listing; the interface probes them: the
calendar from `home.upcoming`, the browser from `GET /browser/sessions/{id}`,
the OAuth buttons from the sign-in routes.

## Remaining gaps, proposed as additive changes

Each row is a surface the design draws and the interface currently hides or
narrows. None changes an existing field.

| Designed surface | What the interface does today | Proposed addition |
|---|---|---|
| Browser task card and docked panel (sandboxed browsing with take control / hand back / stop) | not drawn; the `browser` scenario step is skipped | an event item `browser { session_id, url, task, attention }` so a conversation can announce its browser session, and a `preview` field on `browserSession` (image URL or data) for the card |
| A permission decided elsewhere (another device, the same person earlier) | the card is closed with a plain "Decided" badge once the turn's status leaves `needs_you`; the option is unknown | an event item `permission_decided { permission_id, option, rule_id? }` so every client can show which way it went |
| A question answered elsewhere | the options are disabled once the turn moves on; none is highlighted | an event item `question_answered { question_id, option_id }` |
| Action step while it runs (spinner, then done) | action steps are drawn only when done | optional `status: running \| done` and `id` on the `action` item, with a second emission updating it |
| Reactions on a turn, either direction | implemented through `packages/contracts/src/reactions.ts`: taps target identified text events; glyphs resolve to exact message records from the job stream and are read from `GET /jobs/{conversation_id}/reactions` when a turn settles. Unknown or ambiguous targets are omitted | a `reaction { message_seq, emoji, by }` item on the experience stream would show a glyph immediately rather than waiting for a settled turn |
| Rename, pin, delete, share a chat | not offered (the row menu is not drawn) | `PATCH /conversations/{id}` `{ title?, pinned? }`, `DELETE /conversations/{id}`, `POST …/share` |
| Save a conversation or card to a plan | not offered | `POST /plans/{id}/items` `{ conversation_id \| card_id }` |
| Add a milestone, complete a plan, plan templates | milestones are updated only; no add, no complete, no templates | `POST /plans/{id}/milestones`, `POST /plans/{id}/complete`, `GET /plans/templates` |
| Milestone assignee's name | the kind (person/agent) is drawn, no name for a person | `assignee.name?` |
| Connect and disconnect a connection | status and access only | `POST /experience/connections/{id}/connect` (returns a URL to open) and `…/disconnect` |
| Enable/disable, retry, edit an automation | enabled is drawn as a badge | `PATCH /automations/{id}` `{ enabled?, schedule?, agent_id? }`, `POST …/runs/{id}/retry` |
| Automation run notes | the run's status and time only | `note?` on `automationRun` |
| Delete an agent; import a face image | not offered; `face_image` is a URL field | `DELETE /agents/{id}`; allow a data URL in `face_image` or add `POST /agents/{id}/face` |
| Unknown outcome resolve ("It arrived" / "It did not" / "I can't tell yet") | closed through the broker: the card is read from `GET /actions?job_id={conversation_id}` (status `unknown` or `unresolved`, or settled with `reconciliation.decided_by = owner`) and settled with `POST /actions/{id}/resolve` `{ resolution }`; the transcript carries the notes | one addition so the card is live rather than fetched when the turn settles: an `unknown { action_id, what }` item on the experience stream |
| "Example" badge on a result card | not drawn | `example?: boolean` on `resultCard` |
| Rule text with the agent it applies to | rule text and bounds only | `agent_id?` on `rule` |
| The day panel's week strip | today only | `GET /home?days=7` or `range` on the upcoming query |
| Capabilities listing | probed per surface | `GET /capabilities` `{ calendar, browser, google_sign_in, apple_sign_in, magic_link }` so a client does not probe with writes |

## The original mapping (kept for the record)

The table below is what the retarget translated. Names on the left were the
interface's shapes before the contract landed; they no longer exist in the code.

| Original interface (`types.ts`) | Contract (`experience.ts`) | Note |
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

Not in the contract at all (the original interface mock only): browser preview content
(`preview_frame` is a URL there), automation runs' notes and retry, plan
templates, plan `needs_you`, connection `connect`/`disconnect`, rule text with
an agent, the day panel's week strip.
