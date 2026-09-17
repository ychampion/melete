# Mail and calendars

Email and calendar connectors run inside the trusted service. This page
describes the implementations tested with local protocols on the tree at the
head of `integration`. Live-account onboarding and
compatibility with every mail/CalDAV server are **not claimed**.
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
The key must decode to 32 bytes. The service remains trusted while decrypting
credentials; JavaScript string erasure and host-compromise containment are
**not claimed**. Evidence in `secrets.test.ts`:
`stores randomized sealed boxes and only decrypts in the owning space`,
`rejects a wrong master key, changed ciphertext and cross-row swaps`, and
`fails closed without a valid 32-byte master key`.

## Email

The manifest exposes search, read, draft and send. Drafting creates local
receipt output without SMTP (`a draft is durable local output and never loads
credentials or calls SMTP`). It does not promise a remote Drafts folder.

Sending uses a stable action-derived Message-ID; verification looks for it in
Sent without another send. `accepted send with lost acknowledgement is unknown,
then verified without resending` covers the connector behavior.
Message-ID is a verification handle; SMTP-level deduplication is **not claimed**.

Local IMAP and SMTP servers exercise the real libraries
(`real libraries authenticate, decode MIME for hygiene, send with stable
Message-ID and verify Sent`). `plaintext test exceptions cannot target remote
servers` verifies that the test transport exception stays local.
`context mismatch, header injection and unapproved extra fields never reach
SMTP` checks rejection before sending.

Hygiene withholds tested OTP/reset/magic-link forms
(`withholds OTP, password resets and magic links from search and direct read`).
Complete detection of sensitive messages is **not claimed**.

## Calendar

Read-only ICS imports expose only list; direct writes are rejected
(`ICS import unfolds and unescapes fields, preserves recurrence, and rejects
all writes`). CalDAV creation uses action UID and a conditional write
(`CalDAV create uses action UID and conditional PUT; list and verify use real
HTTP locally`).

Updates preserve the original UID and require the observed ETag
(`update preserves original UID, records its new action, and fails stale
ETags`). Verification compares the approved event and action information;
`a dropped acknowledgement remains unknown until exact UID and content
verification` checks uncertainty handling.

Redirects are rejected before credentials leave the configured collection
(`redirects cannot forward credentials outside the configured calendar`).
General server compatibility and occurrence expansion for recurring series
are **not claimed**.

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/src/connectors
```

The fixtures use local sockets and HTTP with test credentials. No real mailbox
or remote calendar is used.
