# Connectors

Connectors are trusted service-side code selected by persisted connection IDs.
The manifest declares tool schemas, scopes, effect classes and verification
support. `ConnectorRegistry` validates manifests and refuses duplicate entries
(`registry refuses ambiguous tools and invalid manifests`;
`registry rejects duplicate connections and returns a stable connection order`).

This describes code baseline `9484023cabd32b786cb4d336dec818f441cd0cc1`.
The tests use temporary files, fake destinations and local protocol servers.
General compatibility with live mail/calendar accounts is **not claimed**.

## Contract and policy

Implement `Connector` from
[`types.ts`](../apps/melete/src/connectors/types.ts): a manifest,
`execute(action, ctx)`, `verify(action, ctx)`, and `health()`.
The trusted context carries job/space identity, constraints, cancellation signal
and an idempotency key equal to the admitted action ID. Request payloads do not
select arbitrary code or credentials.

| Effect class | Default broker rule |
| --- | --- |
| `read` | Eligible for admission within scope and budget |
| `write_reversible` | Eligible for admission within scope and budget; manifest approval requirements still apply |
| `write_external` | Requires payload-bound approval in the configured default boundary |
| `spend` | Requires approval and a budget reservation |

The default boundary has no configured reusable send authorization; such a
product feature is **not claimed**. Broker tests use injected policy seams and
must not be described as shipped owner configuration.
Evidence for the default effect gate is conformance 4, `An approval cannot be
spent on different content`. Schema declarations alone do not prove admission.

A timeout after dispatch becomes `unknown`. Verification inspects destination
evidence without repeating the effect. If verification cannot decide, uncertainty
remains visible. Conformance 3 tests `the action is never dispatched a second
time, including after broker restart` and `verify resolves the action to
succeeded and the job continues`.

## Implementations and evidence

| Connector | Implemented surface | Named test |
| --- | --- | --- |
| Files | List/read/write/move in configured work and space-artifact roots; content-hash verification | `files manifests parse and workspace/artifact writes can be read and verified` |
| Web | HTTP(S) fetch with address, redirect and trusted-compartment checks | `redirects repeat compartment and DNS checks, with no request to the denied destination` |
| Email | IMAP search/read, local draft, SMTP send; Message-ID verification in Sent | `accepted send with lost acknowledgement is unknown, then verified without resending` |
| Calendar | Read-only ICS import; CalDAV list/create/update with UID and content verification | `CalDAV create uses action UID and conditional PUT; list and verify use real HTTP locally` |
| Test destination | Durable acceptance with optional lost acknowledgement | `destination drops its acknowledgement only after acceptance and verify resolves it` |

The code paths are in [the connector directory](../apps/melete/src/connectors).
`configuredConnectors` reads active connections and owner-controlled endpoint
configuration; email/CalDAV need matching configuration and sealed credentials.
End-to-end connection onboarding is **not claimed**.

### Files

Traversal, absolute paths, alternate streams, device names and links are
rejected in the tested paths:
`file boundary rejects parent traversal, absolute paths, alternate streams and
device names` and `file boundary rejects directory junctions and final
symlinks without touching outside content`. These are connector checks, not
proof of container filesystem isolation. The container probes are **written,
not run**.

### Web

Public research is still subject to SSRF restrictions; it cannot fetch
arbitrary private or metadata addresses. Private-context requests require the
trusted exact-host allowlist. Tests include `web validates every DNS answer,
so a mixed public/private answer never reaches transport` and `checked DNS
answer is passed unchanged to transport and DNS is not repeated`.
No claim of arbitrary-data exfiltration prevention follows from a domain
allowlist; comprehensive containment is **not claimed**.

### Email

Drafting stays local (`a draft is durable local output and never loads
credentials or calls SMTP`). Local IMAP/SMTP fixtures exercise the real
libraries (`real libraries authenticate, decode MIME for hygiene, send with
stable Message-ID and verify Sent`). Header injection and extra fields are
rejected (`context mismatch, header injection and unapproved extra fields never
reach SMTP`). Hygiene patterns do not detect every sensitive message.

Provider-specific OAuth onboarding and live-account acceptance are **not
claimed**. Tests use credentials belonging to local fixtures.

### Calendar

Imported ICS exposes only the read tool (`manifests conform and imported ICS
exposes only the read tool`). CalDAV updates preserve UID and check ETags
(`update preserves original UID, records its new action, and fails stale
ETags`); lost acknowledgements remain uncertain until verified
(`a dropped acknowledgement remains unknown until exact UID and content
verification`). Compatibility with every CalDAV implementation is **not claimed**.

### Knowledge and memory

The configured connector registry does not register a knowledge connector.
Knowledge routes, Markdown mediation and the Postgres memory service exist as
separate modules. A shipped broker catalog containing `knowledge.search` and
`knowledge.propose_write` is **not claimed**. File-view tests and authoritative
memory tests are described in [MEMORY](MEMORY.md); do not use SQLite search hits
as authority to disclose memory.

## Credentials and verification

Sealed secret storage is tested by `stores randomized sealed boxes and only
decrypts in the owning space` and `rejects a wrong master key, changed
ciphertext and cross-row swaps`. The service process and its master key remain
trusted; stronger host isolation is **not claimed**.

Run from the repository root:

```bash
bun test apps/melete/src/connectors
```

The broker's database scenarios also run under the full test command in
[README](../README.md). [REPORT.md](../REPORT.md) records verification results.
