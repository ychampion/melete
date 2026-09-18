# Company map

An inbox scan that builds a map of every company in a person's life: what they
pay, what they are owed, what renews next, what each company promised. Every
figure carries the span it was read from, and a figure whose span does not hold
is dropped rather than shown.

The rule the module is built around is in `@melete/contracts`, not here:
`evidenceHolds(messageText, evidence)` is true only when the quote is exactly
the characters at `[start, end)` in the message it cites. `validate.ts` is the
only caller that decides whether an item lives, and it runs over everything the
extractor returned, whatever the extractor is.

## The path one message takes

| Step | File | What decides it |
| --- | --- | --- |
| Read the mailbox | `mailbox.ts` | The installed `EmailConnector`, through its own `execute`. Nothing here opens IMAP and nothing here can send. |
| Compose the stored text | `messages.ts` | `messageText()`. Both the extractor and the store use it, so spans are counted against one string. |
| Group and select | `prefilter.ts` | Sender domain and a word list. No model. Counts leave this file; sentences do not. |
| Propose items | `extract.ts` + (`scripted.ts` \| `gateway.ts`) | One tool-less call per message returning a strict schema, or the deterministic stand-in. |
| Admit or drop | `validate.ts` | `evidenceHolds`, then currency, due date and dedupe. Every drop is counted. |
| Add up | `totals.ts` | Integer arithmetic over admitted items only. |
| Store and serve | `repository.ts`, `routes.ts` | Every row and every query carries the space and the principal. |

## What the tests cover

| Behaviour | Test |
| --- | --- |
| A fabricated quote is dropped | `validate.test.ts` — `drops a fabricated quote, however plausible it reads` |
| A real sentence with the wrong span is dropped | `validate.test.ts` — `drops a real sentence carrying the wrong span` |
| One bad quote drops its whole item | `validate.test.ts` — `drops every item whose second quote fails, not only its first` |
| A company has one subscription, at the price in force | `validate.test.ts` — `a company has one subscription, and it is the price in force` |
| Monthly spend excludes annual and one-off charges | `validate.test.ts` — `monthly spend counts subscriptions, not an annual renewal or a one-off` |
| The map is the same twice | `scan.test.ts` — `produces the same map twice` |
| Every admitted span re-verifies against the stored text | `scan.test.ts` — `every admitted figure opens back to the exact sentence it came from` |
| A model that obeys an injected instruction changes nothing | `scan.test.ts` — `a model that obeys the email still changes nothing, because the quote does not hold` |
| A failed mailbox leaves no half-written map | `scan.test.ts` — `is recorded as failed, and leaves no half-written map` |
| Hygiene is the connector's, applied before the scan sees anything | `mailbox.test.ts` — `inbox hygiene is the connector's own, so a passcode never reaches the scan` |
| The scan cannot send | `mailbox.test.ts` — `never sends anything, whatever it is asked for` |
| A connection in another space is refused by the connector | `mailbox.test.ts` — `a connection belonging to another space is refused by the connector itself` |
| The provider key stays inside the gateway | `gateway.test.ts` — `the provider key stays in the gateway and never reaches this module` |
| No tools are offered to the model | `gateway.test.ts` — `offers the model no tools at all` |
| An email cannot close the fence around itself | `gateway.test.ts` — `an email that guesses at a closing tag still cannot close the real one` |
| A malformed reply yields nothing, not a guess | `gateway.test.ts` — `a reply that is not the schema yields nothing rather than a guess` |
| Another account reads none of it | `test/integration/companies-surface.test.ts` |

## Running it

```bash
bun run companies:demo -- --fixed        # scan the fixture mailbox, print the map JSON
```

Needs no database, no provider key and no inbox. `--fixed` pins the fixture
dates to a reference instant; without it they are dated against today, so the
mailbox always sits inside the window. With `DATABASE_URL` set it writes into
Postgres instead, against `--space` and `--principal`.

## The extractor

`MELETE_COMPANIES_MODEL` is the switch. Unset, `scriptedExtractor()` runs: a
rule table over the message text, with amounts and dates from the Tier 0 grammar
in `memory/tier0.ts`. It is deliberately literal and understates rather than
invents, which is what makes a demonstration and a test reproducible.

Set, `openExtractionGateway` runs the call through the service's own model
gateway, the way `learning/proposal-gateway.ts` does, so the provider credential
stays in the gateway. `gpt-6-astra` is served over the Responses protocol, which
`requiresResponsesProtocol` already decides for every `gpt-6` model.

**A real provider answering is not claimed.** There was no key on the machine
this was built on. `gateway.test.ts` exercises the real gateway and replaces the
upstream at the socket, so the recorded request is the one a provider would
receive; that the provider then returns usable extractions is untested.

**A live mailbox is not claimed** beyond the connector seam. `mailbox.test.ts`
runs the real `EmailConnector` over a transport double; no IMAP server was
involved. The connector's `email.search` tool caps a read at fifty messages, so
a scan sees the newest fifty and then applies the window, rather than ninety
days of mail.

## The surface, where it makes a choice

- `GET /spaces/:spaceId/companies` omits items with status `dropped` and keeps
  `settled` ones. A dropped item is one the person has said is not a thing; the
  row survives so a re-scan does not offer it again, but it is off the map.
- `POST /ledger/:id/handle` is idempotent. An item that already names a job is
  already being handled, so the job it names is the answer and the playbook is
  not asked a second time. Writing to a company twice is the failure this
  product exists to avoid.
- `PATCH /ledger/:id` takes `dropped` or `settled` and returns the item.

## Handing an item on

`handler.ts` is the whole seam to the playbooks that write to a company: an
interface, a stub that refuses, and the adapter onto `handle.ts`, which turns an
item into a job carrying its playbook and the sentences that item can still
quote. The route asks through that interface and then records `job_id` and
`handling` on the row itself, so the transition is written once, in the module
that owns the row. Nothing here sends: a send belongs on the existing broker
path with its approval and exactly-once behaviour, and that is where the job's
first message goes.

## Scoping

Rows are reached only by the principal who owns them, inside the space they
belong to, using the same `ownJob` rule `experience/*` applies to jobs. A space
in a path is additionally guarded by `mountPrincipals`, which refuses one the
caller cannot see with `scope_denied` and 403 before any route here runs — the
answer the rest of the API gives. A ledger item is addressed by its own id,
outside `/spaces`, and answers 404: an id that is not yours must not be
distinguishable from one that never existed.

See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md).
