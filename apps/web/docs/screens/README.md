# Screens

Written by `bun run --cwd apps/web screens` against the mock serving the experience contract. Every surface is checked at 1440, 1024 and 390 px in light and dark for horizontal overflow and console errors; the committed images are 1440 light, 390 light and 1440 dark.

- `design-sheet` — The living component sheet at #/design: every primitive in every state.
- `sign-in` — Sign-in: the magic link; OAuth buttons only when the service says they work, and the honest reason when it does not.
- `home` — Home with the day panel from the contract: composer first, then active plans and recent chats.
- `chat-working` — The dinner conversation while Nova works: say and action steps with app-named sources, Stop in the composer.
- `chat-decide` — The permission card with its result-card preview, the draft with explicit send, the trail collapsed.
- `chat-done` — The finished turn: the receipt with undo, the draft still unsent, the collapsed trail.
- `chat-sent` — After the person pressed send on the draft: the sent receipt, nothing recalled.
- `chat-unknown` — An effect the connector never confirmed: the unknown-outcome card from the broker’s ledger, nothing repeated, the person decides.
- `chat-resolved` — After the person said it arrived: the card settled, the note in the transcript, the turn done.
- `chat-question` — A question with keyboard answers (1–4) waiting for the person.
- `chat-plain` — A plain answer with its one source; nothing to decide.
- `command-palette` — The command palette (⌘K) with typed results across chats, plans, tasks, connections and actions.
- `plans` — Plans with the sheet open on Japan: milestones with assignees, the linked chat, Ask Melete about this plan.
- `plans-new` — The New plan dialog after typing a full title: focus stays in the field and every keystroke lands.
- `agents` — Agents with Nova open in the editor: look, the nine states, the face wall, templates.
- `automations` — Automations: schedule sentences, run history, test run, and a new routine.
- `settings-memory` — Settings › Memory in plain language with edit, forget and why.
- `settings-connections` — Settings › Connections: status and what each may do.
- `settings-rules` — Settings › Rules: standing grants with their limits and revoke.
- `onboarding-welcome` — Setup step 1: welcome, name, and the morning brief.
- `onboarding-tour` — Setup step 2: the tour, only the stages this instance can do.
- `onboarding-connect` — Setup step 3: what Melete may look at.
- `onboarding-agent` — Setup step 4: meet your first agent.
- `phone-drawer` — The phone layout with the sidebar drawer open.
- `phone-day` — The phone layout with the day panel sheet open.

## Last run

| surface | viewport | overflow | console errors |
|---|---|---|---|
| design-sheet | 1440-light | no | 0 |
| design-sheet | 1440-dark | no | 0 |
| design-sheet | 1024-light | no | 0 |
| design-sheet | 1024-dark | no | 0 |
| design-sheet | 390-light | no | 0 |
| design-sheet | 390-dark | no | 0 |
| sign-in | 1440-light | no | 0 |
| sign-in | 1440-dark | no | 0 |
| sign-in | 1024-light | no | 0 |
| sign-in | 1024-dark | no | 0 |
| sign-in | 390-light | no | 0 |
| sign-in | 390-dark | no | 0 |
| home | 1440-light | no | 0 |
| home | 1440-dark | no | 0 |
| home | 1024-light | no | 0 |
| home | 1024-dark | no | 0 |
| home | 390-light | no | 0 |
| home | 390-dark | no | 0 |
| chat-working | 1440-light | no | 0 |
| chat-working | 1440-dark | no | 0 |
| chat-working | 390-light | no | 0 |
| chat-working | 390-dark | no | 0 |
| chat-decide | 1440-light | no | 0 |
| chat-decide | 1440-dark | no | 0 |
| chat-decide | 1024-light | no | 0 |
| chat-decide | 1024-dark | no | 0 |
| chat-decide | 390-light | no | 0 |
| chat-decide | 390-dark | no | 0 |
| chat-done | 1440-light | no | 0 |
| chat-done | 1440-dark | no | 0 |
| chat-done | 1024-light | no | 0 |
| chat-done | 1024-dark | no | 0 |
| chat-done | 390-light | no | 0 |
| chat-done | 390-dark | no | 0 |
| chat-sent | 1440-light | no | 0 |
| chat-sent | 1440-dark | no | 0 |
| chat-unknown | 1440-light | no | 0 |
| chat-unknown | 1440-dark | no | 0 |
| chat-unknown | 390-light | no | 0 |
| chat-unknown | 390-dark | no | 0 |
| chat-resolved | 1440-light | no | 0 |
| chat-resolved | 1440-dark | no | 0 |
| chat-question | 1440-light | no | 0 |
| chat-question | 1440-dark | no | 0 |
| chat-question | 1024-light | no | 0 |
| chat-question | 1024-dark | no | 0 |
| chat-question | 390-light | no | 0 |
| chat-question | 390-dark | no | 0 |
| chat-plain | 1440-light | no | 0 |
| chat-plain | 1440-dark | no | 0 |
| chat-plain | 1024-light | no | 0 |
| chat-plain | 1024-dark | no | 0 |
| chat-plain | 390-light | no | 0 |
| chat-plain | 390-dark | no | 0 |
| command-palette | 1440-light | no | 0 |
| command-palette | 1440-dark | no | 0 |
| command-palette | 1024-light | no | 0 |
| command-palette | 1024-dark | no | 0 |
| command-palette | 390-light | no | 0 |
| command-palette | 390-dark | no | 0 |
| plans | 1440-light | no | 0 |
| plans | 1440-dark | no | 0 |
| plans | 1024-light | no | 0 |
| plans | 1024-dark | no | 0 |
| plans | 390-light | no | 0 |
| plans | 390-dark | no | 0 |
| plans-new | 1440-light | no | 0 |
| plans-new | 1440-dark | no | 0 |
| agents | 1440-light | no | 0 |
| agents | 1440-dark | no | 0 |
| agents | 1024-light | no | 0 |
| agents | 1024-dark | no | 0 |
| agents | 390-light | no | 0 |
| agents | 390-dark | no | 0 |
| automations | 1440-light | no | 0 |
| automations | 1440-dark | no | 0 |
| automations | 1024-light | no | 0 |
| automations | 1024-dark | no | 0 |
| automations | 390-light | no | 0 |
| automations | 390-dark | no | 0 |
| settings-memory | 1440-light | no | 0 |
| settings-memory | 1440-dark | no | 0 |
| settings-memory | 1024-light | no | 0 |
| settings-memory | 1024-dark | no | 0 |
| settings-memory | 390-light | no | 0 |
| settings-memory | 390-dark | no | 0 |
| settings-connections | 1440-light | no | 0 |
| settings-connections | 1440-dark | no | 0 |
| settings-connections | 1024-light | no | 0 |
| settings-connections | 1024-dark | no | 0 |
| settings-connections | 390-light | no | 0 |
| settings-connections | 390-dark | no | 0 |
| settings-rules | 1440-light | no | 0 |
| settings-rules | 1440-dark | no | 0 |
| settings-rules | 1024-light | no | 0 |
| settings-rules | 1024-dark | no | 0 |
| settings-rules | 390-light | no | 0 |
| settings-rules | 390-dark | no | 0 |
| onboarding-welcome | 1440-light | no | 0 |
| onboarding-welcome | 1440-dark | no | 0 |
| onboarding-welcome | 1024-light | no | 0 |
| onboarding-welcome | 1024-dark | no | 0 |
| onboarding-welcome | 390-light | no | 0 |
| onboarding-welcome | 390-dark | no | 0 |
| onboarding-tour | 1440-light | no | 0 |
| onboarding-tour | 1440-dark | no | 0 |
| onboarding-tour | 1024-light | no | 0 |
| onboarding-tour | 1024-dark | no | 0 |
| onboarding-tour | 390-light | no | 0 |
| onboarding-tour | 390-dark | no | 0 |
| onboarding-connect | 1440-light | no | 0 |
| onboarding-connect | 1440-dark | no | 0 |
| onboarding-connect | 1024-light | no | 0 |
| onboarding-connect | 1024-dark | no | 0 |
| onboarding-connect | 390-light | no | 0 |
| onboarding-connect | 390-dark | no | 0 |
| onboarding-agent | 1440-light | no | 0 |
| onboarding-agent | 1440-dark | no | 0 |
| onboarding-agent | 1024-light | no | 0 |
| onboarding-agent | 1024-dark | no | 0 |
| onboarding-agent | 390-light | no | 0 |
| onboarding-agent | 390-dark | no | 0 |
| phone-drawer | 390-light | no | 0 |
| phone-drawer | 390-dark | no | 0 |
| phone-day | 390-light | no | 0 |
| phone-day | 390-dark | no | 0 |
