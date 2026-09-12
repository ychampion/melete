# Saved setup answers and sign-out

The final setup step saves four answers through `POST /memory/items` and opens
an accepted first message referring to one of them. Settings exposes sign-out
and returns to sign-in, including after reloading with a revoked cookie.

## Assumptions

The existing option to skip setup remains available. Answers are saved as they
are chosen; skipping does not remove answers already accepted by the service.
The four questions use registered preference keys. The interface does not
choose arbitrary keys from free text.

## Behavior

`memoryItemCreate` accepts a registered key, value and optional statement.
Identity, space, publisher, source and trust come from the authenticated
session and service, and extra identity fields are rejected. Event and contact
keys are refused with `409 extractor_owned_key`; correct their existing items
instead of creating a statement that shadows deterministic extraction.

The route calls `persistEvidence` and `publishRevision`, the same memory
services used by owner corrections. Evidence enters the `onboarding` stream,
with owner trust and protected revisions. An identical statement is
idempotent. A changed answer on the same key supersedes the old revision and
keeps one active head. Replacement also uses the correction path's output
repair journal and invalidates dependent context. Preference answers enter the
memory profile after its queued rebuild; the integration test verifies an
attempt bundle containing the focus answer.

Sign-out removes the current session row and expires its cookie. The old
cookie then receives 401, while another session for the same person remains
usable. The web app clears its displayed account state when sign-out succeeds
and treats a revoked profile request as a request to sign in.

The mock serves both operations through the shared contract table. It keeps
one item per key, fills the scripted welcome from setup answers, and refuses
experience requests after sign-out until a sign-in link is consumed. Its
session is shared mock state and its sign-in links send no mail.

The screen walk exercises four saved answers, the first message and welcome,
and sign-out followed by reload and sign-in. It refreshes screenshots at the
specified widths and themes. The client and memory guides describe these
features, and their two proposed entries have been removed.

## Verification

- The two service integration files: 5 tests passed.
- Memory and authentication suites: 111 tests passed across 11 files.
- Mock API: 39 tests passed across 3 files.
- Root typecheck, web typecheck and web build passed.
- Lint passed with one existing unused-import warning in the Postgres test helper.

- The full screen walk ran once. All 138 other cases passed; the two sign-out
  cases passed when rechecked after accounting for Strict Mode's two expected
  profile 401 responses. All 140 recorded cases now have no overflow or
  unexpected console errors. Screenshots were refreshed and both servers stopped.

Regenerate the contract and client with `bun run openapi && bun run
client:generate`, then check that `git status --short` remains empty.

## Limits

The welcome is scripted in the mock. The service integration test proves
saved memory reaches an attempt bundle after the profile rebuild; it does not
assert how an external model phrases its response. Setup offers four choice
lists, and sign-out revokes the current session only. There is no sign-out
everywhere control.
