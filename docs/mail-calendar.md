# Mail and calendars

Email and calendar connectors run inside the trusted service. This page
describes how they work and the local IMAP, SMTP and CalDAV servers their tests
run against. A mailbox, a CalDAV calendar or a calendar feed is installed
through `POST /connections`; the fields each kind takes are under
[Installing a connection](CONNECTORS.md#installing-a-connection). Mail and
CalDAV authenticate with an account name and a password or app password.
Gmail and Google Calendar are connected by signing in with Google, described
next. See [CONNECTORS](CONNECTORS.md) for the manifest and broker boundary.

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
| `calendar.events` | `calendar.list`, `calendar.create`, `calendar.update`, `calendar.delete` |

Drafts stay in Melete's action record, as they do for any mailbox, so no Gmail
draft scope is asked for. Google lets a person untick a scope on its consent
screen, and Melete connects exactly what was granted: a mailbox without
`gmail.send` has no `email.send` grant, and a sign-in without `calendar.events`
connects no calendar.

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

1. Create a project in the Google Cloud console and enable the **Gmail API**
   and the **Google Calendar API**.
2. Configure the OAuth consent screen and add the three scopes above.
3. Create an OAuth client of type **Web application**, with the authorized
   redirect URI `<MELETE_PUBLIC_URL>/api/oauth/google/callback`.
   `GET /google-sign-ins` shows the exact address. `MELETE_PUBLIC_URL` must be
   an `https://` address or a `localhost` one.
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, and restart
   the service.

`gmail.readonly` is a restricted scope and `gmail.send` a sensitive one, so how
you publish the consent screen decides how long a sign-in lasts:

| Publishing status | What it means |
| --- | --- |
| **Testing** | Only the test users you list can sign in. Google ends the sign-in after 7 days, and the connection reports `sign_in_required` until the person signs in again. |
| **Internal** (Google Workspace) | Everyone in your Workspace organisation can sign in, with no verification and no weekly sign-in. |
| **In production** | Google's verification of restricted scopes, including a security assessment, is required before people outside your organisation can use it. |

For one person or a family on personal Gmail accounts, **Testing** works with a
sign-in once a week. For a Workspace organisation, **Internal** is the simplest.

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

Read-only ICS imports expose only list; direct writes are rejected
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
Listing returns each event series with its recurrence rule; individual
occurrences are not expanded.

Google Calendar keeps the same promises over its own API. An event Melete
creates is named by the action that created it, so a second create is refused
rather than making a second event; an update or removal sends the ETag it read;
and verification compares the event's recorded action, payload hash and fields
(`google.test.ts`).

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/src/connectors
```

The fixtures use local sockets and HTTP with credentials belonging to them
rather than to live accounts. No real mailbox or remote calendar is used.
