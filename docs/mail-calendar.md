# Mail and calendars

Email and calendar connectors run inside the trusted service. This page
describes how they work and the local IMAP, SMTP and CalDAV servers their tests
run against. A mailbox, a CalDAV calendar or a calendar feed is installed
through `POST /connections`; the fields each kind takes are under
[Installing a connection](CONNECTORS.md#installing-a-connection). Mail and
CalDAV authenticate with an account name and a password or app password.
Gmail and Google Calendar are connected by signing in with Google, and Outlook
mail and calendar by signing in with Microsoft, both described next. See
[CONNECTORS](CONNECTORS.md) for the manifest and broker boundary.

## Signing in with Google

One sign-in connects a Google account's Gmail and its primary Google Calendar.
Each becomes an ordinary connection with the same tools, effect classes,
approvals and receipts as a mailbox or calendar connected with a password, so
everything that uses mail, such as publishing by email and the company map,
uses it the same way.

The consent screen asks for three Google scopes:

| Scope | What it is for |
| --- | --- |
| `gmail.readonly` | `email.search` and `email.read` |
| `gmail.send` | `email.send`, once each send is approved |
| `calendar.events` | `calendar.list`, `calendar.freebusy`, `calendar.create`, `calendar.update`, `calendar.delete` |

Drafts stay in Melete's action record, as they do for any mailbox, so no Gmail
draft scope is asked for. Google lets a person untick a scope on its consent
screen, and Melete connects exactly what was granted: a mailbox without
`gmail.send` has no `email.send` grant, and a sign-in without `calendar.events`
connects no calendar.

### Adding Google Drive

Drive is asked for on a step of its own, the first time a person keeps a
deadline on a Drive file. `POST /google-sign-ins` with `{ "documents": true }`
asks Google only for `drive.metadata.readonly`, with `include_granted_scopes`,
so what the account granted before is kept, and its answer carries a `reason`
in plain words. The step connects the Drive alone, as a connection of its own
(see [SITUATIONAL-AWARENESS.md](SITUATIONAL-AWARENESS.md#drive-files)) with one
read tool, `documents.status`: a file's name, type, last change and sharing,
from its id or link, never its contents. The account's mail and calendar
connections keep their ids, and taking the step again renews the same Drive
(`the Drive step adds Drive beside an account’s mail and calendar, which keep
their ids`). An ordinary sign-in never asks for Drive.

To start, `POST /google-sign-ins` answers with an `authorize_url` to open in
the browser. Google returns the browser to
`<MELETE_PUBLIC_URL>/api/oauth/google/callback`, and
`GET /google-sign-ins/{id}` reports `pending`, `connected` with the connection
ids, or `failed`. `GET /google-sign-ins` says whether sign-in is available and
which redirect address to register. The sign-in uses PKCE with S256 and a
single-use state, and the id token must name this client and a verified
address.

Tokens are sealed on each connection and read from its row on every call. An
access token is refreshed shortly before it expires, and the new one replaces
the sealed secret. When Google refuses the refresh, the connection's check
reports `sign_in_required`. Signing in again with the same account renews the
connections already made for it rather than adding new ones, and they keep
their ids, rules and history. Removing a connection removes it from Melete; the
account's grant to your Google client is listed, and can be withdrawn, at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Setting up your Google client

Signing in with Google needs an OAuth client in your own Google Cloud project:

1. Create a project in the Google Cloud console and enable the **Gmail API**,
   the **Google Calendar API** and the **Google Drive API**.
2. Configure the OAuth consent screen and add the three scopes above, and
   `drive.metadata.readonly` if Drive deadlines are wanted.
3. Create an OAuth client of type **Web application**, with the authorized
   redirect URI `<MELETE_PUBLIC_URL>/api/oauth/google/callback`.
   `GET /google-sign-ins` shows the exact address. `MELETE_PUBLIC_URL` must be
   an `https://` address or a `localhost` one.
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, and restart
   the service.

`gmail.readonly` and `drive.metadata.readonly` are restricted scopes and `gmail.send` a sensitive one, so how
you publish the consent screen decides how long a sign-in lasts:

| Publishing status | What it means |
| --- | --- |
| **Testing** | Only the test users you list can sign in. Google ends the sign-in after 7 days, and the connection reports `sign_in_required` until the person signs in again. |
| **Internal** (Google Workspace) | Everyone in your Workspace organisation can sign in, with no verification and no weekly sign-in. |
| **In production** | Google's verification of restricted scopes, including a security assessment, is required before people outside your organisation can use it. |

For one person or a family on personal Gmail accounts, **Testing** works with a
sign-in once a week. For a Workspace organisation, **Internal** is the simplest.

## Signing in with Microsoft

One sign-in connects a Microsoft account's Outlook mail and its default
calendar, through Microsoft Graph. Personal accounts (Outlook.com, Hotmail,
Live) and work or school accounts can both sign in. As with Google, each part
becomes an ordinary connection with the same tools, approvals and receipts, and
Melete connects only what the person granted.

The consent screen asks for these Microsoft Graph permissions, all delegated:

| Permission | What it is for |
| --- | --- |
| `User.Read` | The account's own address, which mail is sent from |
| `Mail.Read` | `email.search` and `email.read` |
| `Mail.Send` | `email.send`, once each send is approved |
| `Calendars.ReadWrite` | `calendar.list`, `calendar.freebusy`, `calendar.create`, `calendar.update`, `calendar.delete` |
| `offline_access` | Staying signed in between uses |

The routes are the Google ones with `microsoft` in place of `google`:
`POST /microsoft-sign-ins`, `GET /microsoft-sign-ins/{id}`,
`GET /microsoft-sign-ins`, and the redirect address
`<MELETE_PUBLIC_URL>/api/oauth/microsoft/callback`. The id token must name this
client and come from the Microsoft identity platform, and from your tenant when
you name one; the address is the one Graph reports for the signed-in person.

Microsoft replaces the refresh token each time it is used, and Melete seals the
new one in place of the old. A sign-in lasts as long as it keeps being used
within Microsoft's refresh-token lifetime (90 days), and the connection reports
`sign_in_required` when Microsoft ends it.

Outlook calendar events carry Melete's mark in an extended property, so an event
Melete created is found again by the action that created it, and a second create
for that action is refused. A create also sends Graph a transaction id, and a
change or removal sends the ETag it read.

### Setting up your Microsoft app

Signing in with Microsoft needs an app registration in Microsoft Entra:

1. In the Microsoft Entra admin center, register an application. For
   **Supported account types**, choose accounts in any organizational directory
   and personal Microsoft accounts, or only your own organization.
2. Add a **Web** platform with the redirect URI
   `<MELETE_PUBLIC_URL>/api/oauth/microsoft/callback`.
   `GET /microsoft-sign-ins` shows the exact address.
3. Under **Certificates & secrets**, create a client secret, and note when it
   expires so you can replace it.
4. Under **API permissions**, add the delegated Microsoft Graph permissions in
   the table above.
5. Set `MICROSOFT_OAUTH_CLIENT_ID` (the application id) and
   `MICROSOFT_OAUTH_CLIENT_SECRET`, and restart the service. Set
   `MICROSOFT_OAUTH_TENANT` to your tenant id or domain to accept only your own
   organization's accounts; it is `common` otherwise.

Personal accounts can consent for themselves. In a work or school organization,
its policy decides whether people may consent to an app themselves or an
administrator grants consent for everyone, which they do once under **API
permissions**.

## Credentials and configuration

`configuredConnectors` builds a connector from each active connection row.
`POST /connections` stores a mailbox's or a calendar's endpoints on the row and
seals its password, and seals the whole address of a calendar feed; see
[Installing a connection](CONNECTORS.md#installing-a-connection). The
owner-controlled configuration file remains an optional override that wins over
the row, and is the only way to import an ICS file from disk. It contains
endpoints, not passwords.

`SealedSecretStore` takes a secret repository and a master-key supplier.
The key must decode to 32 bytes. The service holds the master key and decrypts
credentials in ordinary process memory, so a compromise of the service process,
or of the host, exposes them. Evidence in `secrets.test.ts`:
`stores randomized sealed boxes and only decrypts in the owning space`,
`rejects a wrong master key, changed ciphertext and cross-row swaps`, and
`fails closed without a valid 32-byte master key`.

## Email

The manifest exposes search, read, draft and send. Drafting creates local
receipt output without SMTP (`a draft is durable local output and never loads
credentials or calls SMTP`). The draft lives in Melete's action record; nothing
is written to the mailbox's Drafts folder.

Sending uses a stable action-derived Message-ID; verification looks for it in
Sent without another send. `accepted send with lost acknowledgement is unknown,
then verified without resending` covers the connector behaviour.
The Message-ID is how verification finds the message: a send happens once
because Melete never resends an unknown send, not because the mail server
discards a duplicate.

A mailbox is named by host, port and TLS mode. `secure` means TLS from the
first byte; without it the connector demands STARTTLS on IMAP and TLS on SMTP
before it authenticates, so a mailbox that will not upgrade is stored with
status `error` and check `unavailable`, and its password never crosses a
plaintext connection (`a mailbox that will not upgrade is unusable, and no
password reaches it` in `mail-transport.test.ts`).
`POST /connections/{id}/health` tests it again at any time and brings the
connection into service once the test passes.

Local IMAP and SMTP servers exercise the real libraries
(`real libraries authenticate, decode MIME for hygiene, send with stable
Message-ID and verify Sent`). `plaintext test exceptions cannot target remote
servers` verifies that the test transport exception stays local.
`context mismatch, header injection and unapproved extra fields never reach
SMTP` checks rejection before sending.

Hygiene matches the known shapes of one-time codes, password resets and magic
links (`withholds OTP, password resets and magic links from search and direct
read`); a sensitive message in any other shape is read like any other message.

## Calendar

Read-only ICS imports expose only `calendar.list` and `calendar.freebusy`; direct writes are rejected
(`ICS import unfolds and unescapes fields, preserves recurrence, and rejects
all writes`). A calendar feed is the same read-only list over an address rather
than a file: the whole address is sealed, because a published feed address is a
credential, and it must be a public HTTPS destination when it is installed and
again on every read. Importing an ICS file from disk stays with the
owner-controlled configuration file. A CalDAV collection address must be HTTPS,
apart from a loopback address for local fixtures, and an address the connector
cannot be built for is answered with `400` before a row or a sealed secret
exists.

CalDAV creation uses action UID and a conditional write
(`CalDAV create uses action UID and conditional PUT; list and verify use real
HTTP locally`).

Updates preserve the original UID and require the observed ETag
(`update preserves original UID, records its new action, and fails stale
ETags`). Verification compares the approved event and action information;
`a dropped acknowledgement remains unknown until exact UID and content
verification` checks uncertainty handling.

Redirects are rejected before credentials leave the configured collection
(`redirects cannot forward credentials outside the configured calendar`).
`calendar.list` returns each event series with its recurrence rule. Watching
a calendar for changes works per occurrence instead, with each series expanded
into its instances; see [SITUATIONAL-AWARENESS.md](SITUATIONAL-AWARENESS.md).

Google Calendar keeps the same promises over its own API. An event Melete
creates is named by the action that created it, so a second create is refused
rather than making a second event; an update or removal sends the ETag it read;
and verification compares the event's recorded action, payload hash and fields
(`google.test.ts`).

## Free time, conflicts, guests and holds

Every calendar (CalDAV, Google, Outlook, a feed or an imported file) answers
`calendar.freebusy` for a window of up to 62 days, given as `start` and `end`.
The answer lists the busy blocks, each with its event's title and `busy` or
`tentative`, the free stretches between them, the time zone used, and
`complete`, which is false when the calendar held more than one read covers.
The grant reads "See when you are busy, and with what", because the blocks
carry titles. The blocks come from the same occurrences change-watching reads:
Google's instances, Graph's `calendarView`, and a CalDAV collection or feed
expanded within the same budget, so every instance of a repeating event counts.
An event shown as free (`TRANSP:TRANSPARENT`, Google's `transparent`, Graph's
`free` or `workingElsewhere`), an invitation the person declined, and a
cancelled event leave the time free; a feed or a CalDAV account whose name is
not the person's address knows a decline by the person's own addresses. A
tentative event or a hold blocks the time. An all-day event fills the person's
own day, midnight to midnight in the time zone of their profile, unless the
call names another zone, and a time written with no zone is read on the
person's own clock. Touching is not overlapping: a meeting ending at 15:00
leaves 15:00 free.

`calendar.create` and `calendar.update` check the calendar twice: once the
proposal is authorized (live attempt, connection in the job's space, the job's
grants, an account-named tool resolved) and before anyone is asked, and again
just before the event is written. The first read has a 10-second deadline;
when it cannot finish, the card says the calendar could not be checked, and
the second read still decides. A time already taken is refused. The refusal
names what is there in the person's own zone ("“Board meeting” (Mon, Nov 9,
10:00 AM–11:00 AM EST)") only when the work may read the calendar
(`calendar.list` or `calendar.freebusy`); otherwise it says only that the time
is taken. A repeat of a proposal that was already made is handed that action,
never refused over the event it made. An update never conflicts with the event
it changes. A calendar that cannot be read stops the write as well; nothing is
written on a guess. To put an event on top of another on purpose, the agent
sends `double_book` with a reason: the person is asked, the card says what it
goes on top of (by title, when the work may read the calendar) and why, and at
dispatch only those events may be in the way.

`attendees` invites people by address, each one plain address; anything else
is refused before anyone is asked. Before anyone is asked, Melete binds which
guests are outside the person's own addresses: in their own space, the address
they sign in with and each account they signed in to and connected there; in a
room's space, only the accounts the room connected for its own use. A mailbox
or calendar connected with a password can be a shared or list address, so it
does not count. Inviting anyone outside asks, and the card names them; inviting
no one, or an empty list, is an event on the person's own calendar. CalDAV
writes each guest as an `ATTENDEE` asked to reply, with the account as
`ORGANIZER`; a CalDAV account whose name is not an address cannot invite, and
says so. Google is told to send the invitations; Graph sends them itself.

`tentative: true` places a hold: the event is marked tentative and keeps the
time. `calendar.update` with `tentative: false` confirms it; an update that
leaves `tentative` out keeps the event as it is, so moving a hold keeps it a
hold. `calendar.delete` releases it, leaving nothing on the calendar. The
receipt of every create or update says whether it is a hold and whom it
invited.

Other code reads the same answers through `calendarConflicts` and `freeBusy` in
`apps/melete/src/connectors/calendar-truth.ts`.

The tests, in `apps/melete/src/connectors/calendar-truth.test.ts`, the
provider tests, and `apps/melete/test/integration/calendar-truth.test.ts`:

- `free/busy from each provider`: Google instances with an all-day day in New
  York, Graph with tentative, away, free, working elsewhere and declined, and a
  weekly CalDAV meeting that keeps 9:00 in New York across the clock change;
  `a time written with no zone is the person’s own wall clock`; `an invitation
  the person declined frees the time even when the account name is not their
  address`;
- `a create over a busy slot is refused with the conflict named` (for each
  provider and through the broker, which also stops a write when something
  lands on its time after it was approved); `a job that may create but not
  read events is never told what is in the way`; `a busy slot is refused, and a
  double-booking lands, through an account-named tool`;
- `nothing is read from a calendar for a proposal that is not authorized`; `a
  calendar that does not answer holds a proposal no longer than the deadline`;
  `the card says when the calendar could not be checked before asking`;
- `proposing a booking that already landed hands back that booking`; `a repeat
  of a proposal still waiting is handed back even when its time has since been
  taken`;
- `inviting someone outside asks, naming them`; `a guest must be one plain
  address, refused before anyone is asked`; `own addresses are the person’s
  sign-in and accounts they signed in to, and a room’s own team accounts`;
- `a double-booking asks, with its reason and what it lands on, and then goes ahead`;
- `a tentative hold can be confirmed or released, and a released hold leaves
  nothing` and `moving a hold without saying tentative keeps it a hold` (CalDAV,
  Google and Outlook).

## Noticing new mail and calendar changes

While a trigger or standing work listens to a mailbox or calendar, the service
reads what changed in it: Gmail's history, the Outlook inbox delta, IMAP UIDs,
and each calendar's occurrences for the next 14 days. New mail arrives as
`mail.received`, headers only; calendar changes arrive as
`calendar.event.created`, `calendar.event.changed` and
`calendar.event.cancelled`. [SITUATIONAL-AWARENESS.md](SITUATIONAL-AWARENESS.md)
describes the cursors, the observations and who hears them.

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/src/connectors
```

The fixtures use local sockets and HTTP with credentials belonging to them
rather than to live accounts. No real mailbox or remote calendar is used.
