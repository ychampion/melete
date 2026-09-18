# Mail and calendars

Email and calendar connectors run inside the trusted service. This page
describes how they work and the local IMAP, SMTP and CalDAV servers their tests
run against. A mailbox, a CalDAV calendar or a calendar feed is installed
through `POST /connections`; the fields each kind takes are under
[Installing a connection](CONNECTORS.md#installing-a-connection). Mail and
CalDAV authenticate with an account name and a password or app password; a
provider that only accepts OAuth cannot be connected.
See [CONNECTORS](CONNECTORS.md) for the manifest and broker boundary.

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

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/src/connectors
```

The fixtures use local sockets and HTTP with credentials belonging to them
rather than to live accounts. No real mailbox or remote calendar is used.
