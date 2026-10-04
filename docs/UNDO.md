# Undo

Every change Melete makes says how it is taken back. Undo on a change's receipt
runs that through the broker as a change of its own, under the same approval
rules, and it gets a receipt of its own that names the change it took back.

## How each change is taken back

| Change | Undo | Window |
|---|---|---|
| An event Melete added (`calendar.create`) | removes it | a day |
| An event Melete moved or edited (`calendar.update`) | puts back what it replaced | a day |
| An event Melete removed (`calendar.delete`) | adds it back, as a new event with the same details | a day |
| A draft (`email.draft`) | discards it | a day |
| A file or folder deleted into the trash (`files.delete`) | restores it | while the trash keeps it (7 days by default) |
| A new version of an app, or going back to an earlier one (`apps.publish`, `apps.rollback`) | shows people the version they saw before | a day |
| A message (`email.send`) | waits before it is sent; Undo in that time cancels it and nothing leaves | `MELETE_SEND_HOLD_SECONDS`, 20 by default |

An event change is put back only when the calendar still has it exactly as
Melete left it (the same ETag), so an edit someone made since is never lost.
A message that has been sent stays sent. A change with no way back shows no
Undo on its receipt.

Connected apps can declare how their own tools are taken back
(`Connector.reversalDeclared` and `Connector.reversal`), which is how a task
or booking tool takes part. The registry is `apps/melete/src/broker/reversals.ts`.

## Where Undo appears

- On the change's receipt in the chat, for as long as its window lasts. A held
  message shows when it will be sent.
- In Settings → Activity, for changes made by chats that were deleted since. An
  event change and an app version stay undoable there for their window
  (`POST /activity/{id}/undo`).

## Events on your own calendar

An event Melete puts on your own calendar with no guests, and removing an event
Melete made, go ahead without asking when they can be undone and touch nothing
important. Before each one, Melete reads your calendar over the time it touches.
It asks first, with the reason on the card, when the change:

- starts within the next 4 hours, or has passed;
- overlaps a repeating meeting;
- overlaps an event with guests;
- overlaps an event marked important or high priority;
- overlaps an event of yours that blocks the time (anything not marked free);
- or when the calendar could not be read in full.

An event counts as Melete's own only when Melete created it; an event you made
stays yours even after Melete changed it, so removing it always asks.

Melete's own events with no guests, and your events marked free, may be
overlapped. This is the **Its own events on your calendar** switch in
Settings → Approvals (`own_calendar`), on by default; a space whose settings
were saved before it follows its sandbox switch. "Ask me for everything", an
agent set to ask before acting, a room's own rule, and a calendar that cannot
be read all ask. The reviewer-backed **Events on your own calendar** switch
(`calendar`) stays off by default.

Undo approves its own reversal only when it acts on something Melete made in
your own accounts and reaches nobody else. Removing or changing an event that
has guests now, a connected app's own reversal, and anything in a room's work
wait for approval on their card. Only the person whose work it was can undo it.

## Evidence

- `apps/melete/test/integration/undo.test.ts`:
  - "a cancel inside the hold sends nothing, and a restart sends once"
  - "undoing a created own-calendar event removes it and records both receipts"
  - "an own-calendar event that overlaps an important event asks first, with the reason"
  - "an own-calendar event with no guests and no conflict goes through without asking, with undo offered"
  - "an action with no reversal shows no Undo"
  - "undoing an event that has guests now waits for approval instead of telling them"
  - "a calendar that cannot be read asks first, and nothing is written"
  - "only the person whose work it was can undo it"
  - "the person’s event, updated by Melete and marked free, asks before removal"
- `apps/melete/src/broker/calendar-check.test.ts`: what makes a change important.
- `apps/melete/src/broker/reversals.test.ts`: the registry, and taking back a
  series of changes newest first.
