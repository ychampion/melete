# Mail and calendars

The `EmailConnector` and `CalendarConnector` run inside the trusted Melete
service. Register each configured instance against its connection ID in the
broker registry. Connection settings come from the owner, never from a tool
payload. Every call checks the action's connection, job, space and idempotency
key against that trusted context.

`SealedSecretStore(new PostgresSecretRepository(sql))` stores app passwords in the
existing `secret` table. Set `MELETE_MASTER_KEY` to 32 random bytes encoded as
64 hex characters or standard padded base64. The store derives a libsodium box
key pair from this seed, seals each secret with `crypto_box_seal`, and seals its
row ID and space ID alongside the value. Changing ciphertext, swapping rows or
using a different master key fails closed. Keep the master key outside the
runtime; losing it makes stored credentials unreadable.

Provision a password with `await secrets.put(spaceId, appPassword)` and retain
the returned reference only in trusted connection configuration and
`connection.secret_ref`. The connectors use a `withSecret` callback to construct
their transport. Neither tool catalogs, receipts nor health responses contain
credentials or secret references. JavaScript strings cannot be reliably erased;
the service process and its dependencies remain trusted.

## Email

Construct `new EmailConnector(config, secrets)` with `id`, `spaceId`, `secretRef`,
`username`, `from`, and `imap`/`smtp` endpoint objects containing `host`, `port`,
and `secure`. Configure `inbox` and `sent` if the mailbox uses names other than
`INBOX` and `Sent`. Implicit TLS uses `secure: true`; otherwise STARTTLS is
required. Certificate verification remains enabled. The explicit
`allowInsecureLocalForTests` exception accepts loopback destinations only.

- `email.search` accepts `query` and `limit` (maximum 50).
- `email.read` accepts an IMAP message `uid`.
- `email.draft` accepts `to`, optional `cc`/`bcc`, `subject`, and `body`; its
  durable draft is the action receipt. It does not write a mailbox Drafts folder.
- `email.send` accepts the same fields and requires the broker's approval.
  Sender overrides, arbitrary headers and attachments are rejected.

Recipient fields accept an address or an array of addresses. The broker's frozen
canonicalizer normalizes these before approval. A send uses
`Message-ID: <action-id@melete.local>`. SMTP recipient acceptance/rejection is
recorded in the receipt. After SMTP accepts the message, the adapter checks Sent
and appends a copy if none is found. A Sent-copy failure records
`sent_copy: false`; SMTP acceptance still happened. An interrupted SMTP send is
unknown. `verify` searches Sent for the Message-ID and never sends again. An
absent copy is undecided: the message may have been delivered without a Sent
copy, or the folder may not yet be consistent. Message-ID is a verification
handle, not a promise that an SMTP server deduplicates sends.

Inbox hygiene is best-effort. Search and read both decode MIME before checking
the subject and body for OTP, one-time passcodes, verification/security/sign-in
codes, password-reset and magic-link patterns. Messages larger than 256 KiB are
withheld because filtering a truncated body would expose an unchecked message.
Matching messages are withheld entirely. Unusual wording, obfuscation, images,
attachments and unsupported languages can evade these patterns; this is not a
complete authentication-message classifier.

## Calendars

Construct `new CalendarConnector(config, secrets)`. A CalDAV configuration has
`id`, `spaceId`, `mode: 'caldav'`, `calendarUrl`, `username`, and `secretRef`.
Use a direct HTTPS calendar collection URL. Redirects are rejected, so Basic
credentials cannot follow a server redirect. Plain HTTP is allowed only by the
explicit loopback test setting.

`calendar.list` uses a CalDAV REPORT and returns event series with UID, times,
summary, description, location, recurrence rule and ETag. `limit` is at most 100;
responses and ICS imports are bounded to 2 MiB. Recurring series are returned as
series; occurrences are not expanded.

`calendar.create` takes `summary`, RFC 3339 `start` and `end`, and optional
`description`/`location`. It conditionally creates `<action-id>.ics` with
`UID = action.id` and `If-None-Match: *`. `calendar.update` also requires the
original event `uid` and last observed `etag`, using `If-Match` to reject a stale
edit. Updates are limited to Melete-created event UIDs. The original creation
action remains the event UID; changing UID on each edit would identify a new
event. Each update additionally records its own action ID and payload hash in
ICS properties. Both write tools require approval.

Verification performs GET by UID and compares the action/hash properties and
the event's approved fields. Missing, changed or unavailable resources leave the
outcome undecided. A lost write acknowledgement is unknown and is never retried
by the connector. Conditional writes prevent overwrite races but do not turn an
unknown outcome into permission to replay.

For an owner-imported read-only calendar, use `mode: 'ics'` with an `ics` string
instead of remote settings. The manifest exposes only `calendar.list`, no
credentials are read, and direct attempts to invoke write tools also fail.

## Verification

Run `bun test apps/melete/src/connectors/email.test.ts apps/melete/src/connectors/mail-transport.test.ts apps/melete/src/connectors/calendar.test.ts apps/melete/src/connectors/secrets.test.ts --max-concurrency 2`.
The mail tests include local IMAP and SMTP socket servers and real client
libraries; CalDAV uses an in-process HTTP server. No real mailbox or remote
calendar is used. Tests cover MIME-decoded hygiene, accepted sends with dropped
acknowledgements, exact calendar verification, stale ETags, credential redirect
rejection, cross-space rejection and sealed-secret tamper detection.

Implementation references: [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/),
[Nodemailer SMTP](https://nodemailer.com/smtp), and
[libsodium sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes).
