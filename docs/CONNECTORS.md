# Connectors

Connectors are trusted service-side code selected by persisted connection IDs.
The manifest declares tool schemas, scopes, effect classes and verification
support. `ConnectorRegistry` validates manifests and refuses duplicate entries
(`registry refuses ambiguous tools and invalid manifests`;
`registry rejects duplicate connections and returns a stable connection order`).

The tests use temporary files, fake destinations and local protocol servers, so
they establish each connector's own behaviour against those fixtures.

Connectors are how Melete reaches other services. The other direction, other
assistants using Melete as their connector over MCP, is described in
[MCP-SERVER](MCP-SERVER.md).

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
| `write_external` | Requires payload-bound approval, or an owner rule that covers this exact action |
| `spend` | Requires approval and a budget reservation |

A `write_external` action waits for the owner unless a rule the owner made
covers it. Choosing `always` on a permission card writes that rule with a count
cap, an expiry and a re-consent interval, and the broker admits under it only
when the space, connection, tool kind and resolved recipient all match, the
recipient's origin is owner-stated or connector-verified, the rule is unrevoked
and inside both its expiry and its re-consent window, and the cap has room;
each use is recorded once, at admission. Rules exist for named kinds only:
sending a message, creating, changing or removing an event, discarding a draft,
saving or restoring a file, and pushing to `melete/` branches of one repository
from the agent's computer
([COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#github)). A `spend` asks every time, and an action the
owner is already reviewing keeps its own approval. [CLIENT](CLIENT.md)
describes the cards, `GET /rules` and `DELETE /rules/{id}`.
Evidence for the default effect gate is conformance 4, `An approval cannot be
spent on different content`; a manifest's schema declares what a tool takes,
and admission is what decides whether it runs.

A timeout after dispatch becomes `unknown`. Verification inspects destination
evidence without repeating the effect. If verification cannot decide, uncertainty
remains visible. Conformance 3 tests `the action is never dispatched a second
time, including after broker restart` and `verify resolves the action to
succeeded and the job continues`.

## Implementations and evidence

| Connector | Implemented surface | Named test |
| --- | --- | --- |
| Files | List/read/write/move in configured work and space-artifact roots; content-hash verification | `files manifests parse and workspace/artifact writes can be read and verified` |
| Web | HTTP(S) fetch with address, redirect and trusted-compartment checks | `redirects are checked hop by hop and never reach a private destination` |
| Email | IMAP search/read, local draft, SMTP send, or the same tools over the Gmail API or Microsoft Graph after a Google or Microsoft sign-in; Message-ID verification in Sent | `accepted send with lost acknowledgement is unknown, then verified without resending`; `a send is found in Sent afterwards, even when Gmail gives it a Message-ID of its own` |
| Calendar | Read-only ICS import; CalDAV, Google Calendar or Outlook calendar list/create/update with UID and content verification; free/busy, conflict refusal, guests and holds | `CalDAV create uses action UID and conditional PUT; list and verify use real HTTP locally`; `an event is named by its action, so a second create cannot make a second event` |
| Test destination | Durable acceptance with optional lost acknowledgement | `destination drops its acknowledgement only after acceptance and verify resolves it` |
| Exec | `exec.run` and `exec.python` carried out inside the cell against a broker-reserved action, with the finished record settled afterwards | `the exec manifest parses and declares in-cell execution with a record schema`; `execution-admission.test.ts` |
| Artifacts | Declared writes become artifact records with deterministic checks; a new file saved to the space goes through like work in the agent's own workspace, while saving over a file already there or sending by email is an approved external effect | `artifacts.test.ts` |
| Generation (speech) | `audio.synthesize` as a `spend` capability with approval, reservation, receipt and an authenticated artifact endpoint | `is a real RIFF/WAVE file, not a placeholder string`; `speech-broker.test.ts` |
| MCP | HTTP servers, and stdio servers in containers of their own, behind the broker, with the effect classes, scopes and audience the installation declares | `MCP config is strict, operator scoped, and defaults unclassified tools to external writes`; `MCP worker and server claims cannot make an ungranted tool callable` |
| Browser | Semantic observe, open, fill, click, select, read and an approved `browser.submit`, carried out by a worker process outside the cell with epoch-fenced takeover; a person signs in to a site themselves through a live view of the worker's page, and signs the space out of a site again | `approval binds the exact browser intent and repeated proposals dispatch one effect`; `an unapproved submit has no external effects and its warning identifies the observed destination`; `no persisted event contains the typed secret or the identity-provider host`; `forgetting a site removes its cookies and the profile row`; see [the browser worker](browser-worker.md) |
| Your computer | `device.status`, `device.list_files`, `device.read_file`, `device.write_file`, `device.run`, `device.open_url` and `device.screenshot` on a computer the person paired, carried out by the companion there over its own outbound connection; commands and file writes need approval, paths stay inside the folders shared on the computer | `a command waits for approval, then runs on the computer with a receipt`; `paths outside the shared folders are refused before anything is sent`; see [connecting your computer](DEVICES.md) |

The code paths are in [the connector directory](../apps/melete/src/connectors).
`configuredConnectors` builds one connector for each active connection row. A
row carries its own configuration, so no file has to be edited by hand; the
owner-controlled `MELETE_CONNECTIONS_FILE` remains an optional override, and an
entry there wins over what the row stores. The browser worker and an imported
ICS file are still configured only through that file.

## Default connections

A new installation has tools before anyone connects anything. Every space is
given the connections below as ordinary `connection` rows. A connector is a
default only when its own code needs no credential and no endpoint, when
everything it does is contained in the job's workspace and the space's
directory, is a guarded read, or waits for a payload-bound approval, and when it
does not depend on isolation the running deployment lacks.

| Default | Tools | Condition |
| --- | --- | --- |
| Files | `files.list`, `files.read` (text, and the words in PDFs, Word documents and spreadsheets), `files.write`, `files.move`, `files.delete` and `files.restore` (deletes go to a trash, restorable for `MELETE_TRASH_DAYS`), `files.save_attachment` (a file the person sent in chat, into the workspace) | always |
| Web | `web.search`, `web.fetch` | always; the address and compartment checks below still apply, and the space's Public web reads setting turns both off |
| Finished work | `artifact.publish` | always; a new file saved to the space needs no approval, replacing one or emailing it does |
| Speech | `audio.synthesize` | only while a speech-capable provider is configured; a `spend`, so every call needs approval and a budget reservation |
| Code in the workspace | `exec.run`, `exec.python` | only while attempts run in a container (`MELETE_RUNTIME_ADAPTER=docker`, or the Hermes adapter with `MELETE_RUNTIME_SUPERVISOR=docker`); under the process supervisor the row offers nothing |

Mail, calendars, MCP servers, plugins and the browser worker need a credential,
an endpoint or a person's choice and are never defaults. The test destination is a fixture and is never
a default. `react`, `job.wait`, `search_tools` and `load_tool` belong to the
broker and need no connection.

The rows are made for a space as it appears — with the account it belongs to,
when a shared space is asked for, or when a session makes an account's own space
on its first use — and for every space at each start, so a database from an
earlier release gains them on its first start. A request furnishes the one space
it made and reads no other. The step is idempotent. A space that already grants
one of a default's tools through a row of its own, in any state, is left as it
is, so a default the owner removed is not made again, and procedure-evaluation
spaces never receive any. The broker admits a default exactly as it admits any
other connection: scopes, approvals and budgets are unchanged. Settings lists a
default with a test and without a removal; `POST /connections/{id}/lifecycle`
removes one for an owner who calls it, and a removed default stays removed.

Evidence: `a fresh installation offers a useful catalog without any hand-made
connection`, `an existing installation gains the default tools once, and a
removal stays removed`, `an account whose own space is made on its first request
finds the default tools in it` and `a request furnishes the one space it made
and leaves every other space alone` in
[default-connections.test.ts](../apps/melete/test/integration/default-connections.test.ts);
`only connectors that declare no credential are defaults, each granted exactly
its own tools` in `builtin.test.ts`.

## Installing a connection

`GET /connection-kinds` lists the kinds that can be installed and, for each, the
fields a form needs, where each value goes in the request, which fields are
secret, and which grants may be chosen. The web application draws its Settings
form from that response alone. Each entry has an `id`, and a kind can appear
more than once: an entry for a provider whose servers are known carries them in
`fixed`, so the person gives only an email address and an app password.

The same response carries `catalog`: everything a person can connect here, in
the order a connector screen shows it. Account sign-ins come first (Google, and
Microsoft), then apps whose makers run a remote MCP server (Notion, Linear,
Atlassian, Sentry, Stripe and GitHub), then one entry for each form in `kinds`.
Each entry says what it covers (`mail`, `calendar`, `tools` or `execution`) and
how it connects:

- `sign_in` names the provider, the route to `POST` to start
  (`/google-sign-ins`, `/microsoft-sign-ins`), the `issuer` the person signs in
  at, and every scope the sign-in asks for, each with a plain-words `label`;
- `mcp_sign_in` gives the server's address and a suggested `mcp.id` for
  `POST /mcp-sign-ins`. For an app in the catalog it also lists `tools`: what
  each lets Melete do, in plain words, its effect class, and whether every use
  asks first. Such an app connects with `{ "catalog_id": "<id>" }` alone (see
  [Connecting an app from the catalog](#connecting-an-app-from-the-catalog));
- `form` names the entry in `kinds` whose form connects it.

Starting a sign-in answers with the same two things before the browser leaves:
`issuer` and `scopes`. For an account sign-in they are the fixed values above.
For an MCP server they are discovered: the authorization server its protected
resource metadata names, and the scopes that will be requested. Show them to
the person before opening `authorize_url`; the web app's Add a connection step
does.

`available` is false when this installation cannot offer an entry yet.
`unavailable_reason` then says so in plain words for anyone signed in, and
`setup_hint`, sent only to the installation's owner, says what to set: a
provider's OAuth client, or a `MELETE_PUBLIC_URL` to return the browser to. An
entry may carry a `warning` to show before connecting: Stripe's says its tools
can move money, and that those tools should be granted as `spend`, so each one
waits for approval.

| Entry | Kind | What the person types |
| --- | --- | --- |
| Gmail, iCloud Mail, Fastmail, Yahoo Mail | `mail` | email address, app password |
| iCloud Calendar, Fastmail Calendar | `caldav` | email address, app password |
| Google Calendar (read only) | `ics` | the calendar's secret address in iCal format |
| Other mail, other calendar, calendar feed, MCP server | each kind | every field the kind takes |

Each provider entry's password field says where that provider issues app
passwords. `POST /connections` takes exactly one configuration block:

| Kind | `provider` | Block | Credential | Grants |
| --- | --- | --- | --- | --- |
| Mail (IMAP and SMTP) | `imap` | `mail`: account name, IMAP and SMTP host, port and TLS mode, optional sender address and folders | `credentials.password` | `email.search`, `email.read`, `email.draft`, `email.send` |
| CalDAV | `caldav` | `caldav`: an account name and either one HTTPS calendar collection address or the HTTPS address of the calendar service | `credentials.password` | `calendar.list`, `calendar.freebusy`, `calendar.create`, `calendar.update`, `calendar.delete` |
| Calendar feed (ICS address) | `caldav` | `ics`: one HTTPS or `webcal` address | the address itself | `calendar.list`, `calendar.freebusy` |
| MCP over HTTP | `mcp` | `mcp`: see [Installed MCP servers](#installed-mcp-servers) | optional token fields | declared in the block |
| MCP from a package or image | `mcp` | `mcp_stdio`: see [the advanced path](#the-advanced-path) | `mcp_stdio.secret_env` | declared in the block |
| GitHub for the agent's computer | `command_line` | `command_line`: `{ "adapter": "github" }` | `credentials.token`, a fine-grained token; GitHub is asked whose it is before it is kept | `egress.github_read`, `egress.github_write` (asks each time); see [COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#github) |
| AWS for the agent's computer | `command_line` | `command_line`: `{ "adapter": "aws", "region": "us-east-1" }`, with an optional `role_arn` and `external_id` | `credentials.access_key_id` and `credentials.secret_access_key`; AWS is asked whose the key is, through the role, before it is kept | `egress.aws_read`, `egress.aws_write` (asks each time); see [COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#aws) |
| GitLab for the agent's computer | `command_line` | `command_line`: `{ "adapter": "gitlab" }` | `credentials.token`, a GitLab.com personal or project access token; GitLab is asked whose it is before it is kept | `egress.gitlab_read`, `egress.gitlab_write` (asks each time); see [COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#gitlab) |
| npm for the agent's computer | `command_line` | `command_line`: `{ "adapter": "npm" }` | `credentials.token`, a granular access token; the registry is asked whose it is before it is kept | `egress.npm_read`, `egress.npm_write` (asks each time); see [COMMAND-LINE-ACCESS](COMMAND-LINE-ACCESS.md#npm) |

`scopes` may narrow the grants of the first three kinds; left empty it means all
of them, and a scope outside the kind is refused. `space_id` may be left out, in
which case the caller's own personal space is used. Installation requires the
owner of a space whose audience is `owner`, which is the rule MCP installation
already followed, and a connection installed this way is withheld from public
compartments.

A mailbox, with the owner's session cookie and from the API's own origin:

```json
{
  "label": "Personal mail",
  "provider": "imap",
  "mail": {
    "username": "you@example.com",
    "from": "you@example.com",
    "imap": { "host": "imap.example.com", "port": 993, "secure": true },
    "smtp": { "host": "smtp.example.com", "port": 465, "secure": true }
  },
  "credentials": { "password": "…" }
}
```

Use an app password where the provider offers one. `from` may be left out when
the account name is an email address, which is then the sender. `inbox` names
the inbox when it is not `INBOX`; `sent` names the sent folder, and left out it
is the folder the server flags as sent, so a provider's own name for it ("Sent
Messages", "[Gmail]/Sent Mail") needs no setting.
A CalDAV calendar takes one collection address and an account name instead:

```json
{
  "label": "Work calendar",
  "provider": "caldav",
  "caldav": {
    "calendar_url": "https://dav.example.com/calendars/you/personal/",
    "username": "you@example.com"
  },
  "credentials": { "password": "…" }
}
```

In place of `calendar_url`, `server_url` names the calendar service, for example
`https://caldav.icloud.com/`. The service then asks it, with the account's own
password, which calendars the account has, and stores the address of the first
one that holds events; only that address is kept. When the address given does
not answer, the service's well-known address (`/.well-known/caldav`) is asked
instead. Every step goes over HTTPS and stays on the host given, except that
iCloud and Fastmail may move it to another host inside their own domain. An
address written as an IP matches only itself, and a service answering from
public addresses never passes the password to a private one. A password the
service refuses, or
an account with no calendar of events, is answered with `400` and a sentence
saying which, and nothing is stored.

A calendar feed carries `ics: { "url": "https://calendar.example.com/feed.ics" }`
and no `credentials`, because the address is the credential. Each call answers
with the new connection and the result of its one test, described below.

Passwords, MCP tokens and the whole feed address are sealed with the master key
before the row is written. No route returns them, and the row's configuration
keeps only endpoints and account names. A CalDAV or feed address that is not
HTTPS, apart from a loopback address for local fixtures, and any endpoint the
connector cannot be built for, is answered with `400` before anything is
stored. A mailbox is named by host, port and a TLS
mode: `secure` means TLS from the first byte, and without it the connector
demands STARTTLS on IMAP and TLS on SMTP before it authenticates. A mailbox that
will not upgrade is therefore stored rather than refused, with status `error`
and check `unavailable`, and its password never crosses a plaintext connection.
A service started without `MELETE_MASTER_KEY` answers `409 sealing_unavailable`
to any installation that has a secret to keep. A request the contract refuses is
answered with `400 invalid_request` and one sentence that names the field the
way the form labels it, such as "IMAP port is too large." or "Send as is not an
email address."; it never repeats a value from the request.

The new connection is tested once. A mailbox's test signs in to both servers:
it opens the inbox over IMAP and signs in over SMTP without sending anything,
so a mailbox that reads but cannot send fails its test rather than its first
approved message. `check` in the response is a fixed code
(`ok`, `degraded`, `unavailable`, `credential_refused`, `not_running`,
`revoked`) with the sentence
that belongs to it; it never carries a transport message, an address or a
credential. A connection whose test failed is kept with status `error` and
offers no tools. `POST /connections/{id}/health` runs the test again at any
time, records the result, and brings a connection in `error` into service once
the test passes. A mailbox or CalDAV server that answers and turns the account
name or password away reads `credential_refused`, whose sentence asks for an app
password; a server that cannot be reached, or answers in some other way, reads
`unavailable`.

`POST /connections/{id}/lifecycle` with `kind: "revoke"` removes a connection.
The row stays with status `revoked`, its tools leave the catalog of every new
attempt, and running attempts are fenced as before. The `switch` lifecycle still
expects a secret reference that no public route creates; replacing a credential
means removing the connection and installing it again.

Every calendar's `calendar.list` (CalDAV, a feed, an imported file, Google or
Microsoft) covers a window, `from` to `to`. Without `from` it starts yesterday;
without `to` it ends 90 days after `from`. Events are listed earliest first, a
series is listed when one of its occurrences falls in the window, and the
receipt names the window it covered. When more events fall in it than `limit`
(at most 100), the receipt says `truncated: true` with a note, so a short list
is never mistaken for a complete one.

`calendar.freebusy` reads when the person is busy and free, and a create or
update over a taken time is refused, naming what is there; see
[mail-calendar.md](mail-calendar.md#free-time-conflicts-guests-and-holds).

A calendar feed is fetched again on every `calendar.list`, with redirects
refused and the same size limit as CalDAV. A feed address must be HTTPS and
public: the service applies the address checks of `web.fetch`, so a loopback,
private, link-local or otherwise non-routable destination is refused, whether it
is written as a literal address or is what the name resolves to. Installation
answers such an address with `400` before a row or a sealed secret exists. Every
read resolves the name again, refuses it if any answer is not public, and sends
the request to the address it checked. A CalDAV address is the owner's own
server and may be on a private network. An MCP server follows the rule under
[Installed MCP servers](#installed-mcp-servers).

Evidence, all in
[connection-kinds.test.ts](../apps/melete/test/integration/connection-kinds.test.ts)
against local protocol fixtures: `mail: validated, sealed, tested, offered to a
new attempt, and gone after revocation`, `CalDAV: validated, sealed, tested,
offered to a new attempt, and gone after revocation`, `calendar feed: the
address is the secret, the feed is read through the broker, and revocation
removes it`, `MCP over HTTP: installed, offered to a new attempt, and gone after
revocation`, `only the owner of an owner-audience space installs, and a session
without a space_id means its own space`, `a mailbox that will not start TLS is
stored in error; a calendar address without TLS is refused`, and `the
owner-controlled connections file still works, and wins over what a row stores`.
That a password never reaches a destination which refuses to upgrade is `a
mailbox that will not upgrade is unusable, and no password reaches it` in
`mail-transport.test.ts`, which also holds `a test reaches both halves: sending
must work as well as reading` and `a sent folder named its own way is found by
its flag, so a send can be confirmed`. `CalDAV from the service address alone:
the calendar is found, and only its address is stored` is in
connection-kinds.test.ts, and the steps of finding a calendar, including a
refused password and a service that points elsewhere, are in
`caldav-discovery.test.ts`. Request validation, the plain-words refusals and the
provider entries are in `packages/contracts/src/connections.test.ts`. `a form drawn only from the served
descriptors installs every kind` in `apps/mock-api` runs the web form's logic
against the contract, and `the form draws exactly what a served descriptor
carries` renders the Settings form from a descriptor the application has never
seen. Address checks for a calendar feed are in `ics-feed.test.ts`. Mail and
CalDAV sign in with an account name and a password or app password.

### Files

Traversal, absolute paths, alternate streams, device names and links are
rejected in the tested paths:
`file boundary rejects parent traversal, absolute paths, alternate streams and
device names` and `file boundary rejects directory junctions and final
symlinks without touching outside content`. These are the connector's own
checks; the container's filesystem boundary was probed live in scenario 6 on a
Linux Docker host, where a sibling job's canary was unreadable from the cell
while its own workspace stayed writable.

### Web

### Web search

`web.search(query, max_results?, recency?)` is a `read` on the default Web connection, so
every agent can search the web on a fresh installation with nothing configured.
A search goes to the first of these that answers:

1. A search API key the operator set: `TAVILY_API_KEY` (Tavily), then
   `BRAVE_SEARCH_API_KEY` (Brave Search). A key is a deliberate choice, so it
   comes before everything else. Tavily comes first when both are set because
   each of its results carries the passages of the page that match the query
   (see "Tavily" below), so the agent can often answer without reading every
   page.
2. The search tool of the model the conversation runs on, when its provider has
   one: the Messages API web search tool for Claude models, the Responses API
   `web_search` tool for recent OpenAI models. The catalog in
   `packages/contracts/src/model-search.ts` decides, the way the vision catalog
   does, and `MELETE_DEFAULT_MODEL_NATIVE_SEARCH` overrides it for the server's
   default model. Gemini is absent because its search grounding is not offered
   on the OpenAI-compatible endpoint Melete uses for Google.
3. A search that needs no key: DuckDuckGo's HTML results page, then Wikipedia's
   search API when DuckDuckGo does not serve results. Both are read through the
   same pinned, public-address-only transport as `web.fetch`. DuckDuckGo's page
   is meant for people and is not an official API, so it is paced: one request
   at a time, two seconds apart, a repeated query answered from a ten-minute
   cache, and nothing sent for fifteen minutes after a robot check. The service
   logs a warning at start when no search key is set (see
   [DEPLOYMENT](DEPLOYMENT.md)). Wikipedia is told who is calling, as its API
   policy asks.

`recency` (`day`, `week`, `month` or `year`) asks for recent pages only. Tavily
receives it as `time_range` and returns each page's publication date, kept as
the result's `published`; Brave receives it as `freshness` and DuckDuckGo as
`df`. Wikipedia's articles carry no date, so it steps aside for such a search.
The model's own search receives the query as written.

A backend that fails or finds nothing hands the search to the next one, and the
receipt's `tried` names every backend that was asked. That includes the model's
own search: when the provider refuses or fails the call, or it returns no
sources, the query goes on to the keyless search, so a site other than the
model's provider can see it. Two native failures stop the search instead: a
privacy refusal, and the job's budget running out (the agent is told the search
was not run). Neither is ever moved to a free backend.

The model's own search is one bounded request through a model gateway of the
service's own (`apps/melete/src/broker/search-gateway.ts`), which permits that
provider search tool and no other built-in tool. The provider key stays in the
gateway. The call is bounded: at most two searches on the Messages tool, the
smallest search context on the Responses tool, and a reply of at most 1 MB. It
is charged to the job under the `web.search` action, and only to the job's
current attempt:

- The token budget is charged the call's whole usage, input included, since
  that input is the provider's own search results. 3,000 output plus 12,000
  result tokens are reserved first, then settled at the provider's count.
- The spending estimate (`usd_est`) is charged $0.01 per search the provider
  ran, the list price of both providers' search tools. Two searches' worth is
  reserved first.

The call is recorded as a `search_request` and a `search_receipt` notice in the
job's ledger. The attempt's usage counts `search_requests`, `web_searches` and
the fee in `usd_est`. The privacy router reads the call as the job's own service
call. A private decision there refuses it (`privacy_confirmation_required`),
and the search stops.

What the receipt keeps: the query, which backend answered and which were tried,
the model for a native search, how many searches the provider ran, the
provider's short answer when there is one, and each result's title, address
(credentials cut, as `web.fetch` does) and snippet, plus the page's matching
passages (`content`, up to 1,600 characters) and publication date
(`published`) when the backend returns them, with `sources` listing the
addresses. The recency asked for is kept as `recency`. `about_this_text` comes before the results and tells the model they
were written by the sites found, that it must not follow instructions in them,
and that it should name the addresses it relied on. The conversation's trail
shows the action as "Searched the web for “…”", with each result as a source.

A query leaves Melete as written, without placeholders, so it is held to more
than a model request is. It is refused at admission and again at dispatch,
before any backend is asked, when:

- the space's Public web reads setting is off, or the work is not a
  conversation or long work a person started (the same rule as `web.fetch`);
- the space or the agent is marked private, or the conversation is marked
  sensitive (`PrivacyRouter.outsideSearchRefusal`);
- the query itself is about a sensitive topic, unless the person said the
  conversation is not sensitive;
- the query carries anything the gateway's redactor would swap for a
  placeholder in a cloud request: a value this conversation's vault already
  holds (whatever found it, the local detector included, in any spelling), a
  value the space lists (numbers with or without separators, text in any case),
  what memory learned in private conversations, a detail the enabled categories
  detect, or an unresolved placeholder. The model reads placeholders, but its
  tool arguments come back with real values, so this check is what keeps a
  private value out of the query.

A check that cannot answer refuses. Evidence: `web-search.test.ts` (connector and backends),
`search-gateway.test.ts`, `privacy/search.test.ts`, and the integration test
[web-search.test.ts](../apps/melete/test/integration/web-search.test.ts):
`a Claude conversation searches with its own search tool, metered on the job,
with sources in the trail`, `a model with no search of its own uses the keyless
search, with no key configured`, `a configured search key takes precedence over
the model’s own search`, `a private space or a sensitive conversation sends the
query nowhere`, and `a default web connection from an earlier release gains
web.search; a removed one does not`.

#### Tavily

With `TAVILY_API_KEY` set, Tavily serves two purposes. The key is sent only to
`https://api.tavily.com`, in the `Authorization` header, with redirects
refused; it never reaches the model, the sandbox or a receipt, and a failed
call records only its status, since an error body can echo the key. Replies
over 1 MB are not read.

- **Search.** `search_depth: basic` (one Tavily credit) with three passages per
  page, reranked against the query. The passages arrive as each result's
  `content`, so a search usually answers on its own, and `web.fetch` is left
  for the pages that need a full read. Tavily's written answer, whole-page text
  and images are not requested. A search that fails or hits a rate limit moves
  on to the next backend.
- **Reading pages `web.fetch` gets no text from.** When the direct read of a
  page meets a bot wall (a 403 that is a challenge or block page from a
  bot-protection service), a rate limit (429) or an unavailable site (503), or
  returns an HTML page with almost no readable text (a page built by scripts),
  `web.fetch` asks Tavily Extract for the same page with `extract_depth:
  advanced`, which renders it first. A plain 403 is the site saying the page
  is not for this reader, so its address stays here. The fallback runs only
  after the direct read has passed every rule for that address: the Public
  web reads setting, and a public address for the host and every redirect.
  The address is then sent only when:
  - nothing in its host, path or query looks like a key: a run of eight or
    more letters mixed with digits, ten or more digits, a JSON web token, or a
    query name that suggests a key (`authkey`, `token`, `sig`, `session` and
    the like);
  - it is not a sign-in, sign-up, reset, invite or share step, and carries no
    onward address (`next`, `redirect`, `return` and the like);
  - the Public web reads rule allows it, even for a site the work's own list
    let it read;
  - the privacy check a search query passes allows it as sent, decoded, and
    as words (`Jane%20Marlowe`, `jane-marlowe` and `john.doe%40gmail.com`
    are read as the details they are).

  The read stays within `web.fetch`'s total time and its 60,000-character
  limit, and the receipt marks it with `read_through: "tavily"` and a note.
  When Extract fails or finds less, the direct read's result is returned as
  it was. The hosted reader reads at most three pages each conversation turn;
  past that, or past the work's spending limit, the receipt's note says so.

Every Tavily call is charged to the job that made it, as the model's own
search is: the most it can cost (one credit for a search, two for a page) is
reserved on the job's spending estimate at $0.008 a credit before it is sent,
then settled at the credits Tavily reports, counted on the attempt
(`tavily_credits`, `usd_est`) and in the installation's spending record, so
the spending limits in [DEPLOYMENT](DEPLOYMENT.md) cover it. A request and its
receipt are `paid_api_request` and `paid_api_receipt` notices in the job's
ledger. A search over the job's limit is refused, not moved to a free backend.

When `recency` is asked for, the receipt keeps it only if the backend that
answered held to it; otherwise its note tells the model the results are not
limited to recent pages.

Evidence: `tavily.test.ts` and `tavily-guard.test.ts`, which run the calls
against a local stand-in for Tavily's API and the privacy check against the
real redactor and topic classifier, and the integration test
`paid-meter.test.ts`.

### Web reads

Public research is still subject to SSRF restrictions; it cannot fetch
arbitrary private or metadata addresses. Private-context requests require the
trusted exact-host allowlist. Tests include `every private, metadata and
encoded-address bypass is refused without a request`, which covers a name that
answers with both a public and a private address, and `DNS rebinding: one lookup
per hop, and the request goes to the address that was checked`.
An address allowlist decides where a fetch may go, not what it may carry: a
permitted destination receives the request's full address, so `web.fetch` is a
`read` whose whole query string is recorded with its action for the owner to
read back.

### Email

Drafting stays local (`a draft is durable local output and never loads
credentials or calls SMTP`). Local IMAP/SMTP fixtures exercise the real
libraries (`real libraries authenticate, decode MIME for hygiene, send with
stable Message-ID and verify Sent`). Header injection and extra fields are
rejected (`context mismatch, header injection and unapproved extra fields never
reach SMTP`). Hygiene withholds the tested shapes of one-time codes, password
resets and magic links; a sensitive message in any other shape is read like any
other message.

Mail and CalDAV authenticate with an account name and a password or app
password. Gmail and Google Calendar can instead be connected by signing in with
Google, and Outlook mail and calendar by signing in with Microsoft, which serve
the same tools over each provider's API; see
[Mail and calendars](mail-calendar.md#signing-in-with-google). Tests use
credentials belonging to local fixtures rather than live accounts.

### Calendar

Imported ICS exposes only the read tool (`manifests conform and imported ICS
exposes only the read tool`). CalDAV updates preserve UID and check ETags
(`update preserves original UID, records its new action, and fails stale
ETags`); lost acknowledgements remain uncertain until verified
(`a dropped acknowledgement remains unknown until exact UID and content
verification`). These names establish the client's behaviour against a local
CalDAV server.

### Knowledge and memory

Knowledge is not a connector. The knowledge routes, Markdown mediation and the
Postgres memory service are separate modules, and the broker catalog carries no
`knowledge.search` or `knowledge.propose_write` verb: an attempt receives
knowledge through the memory context it is given, and the owner reads and edits
it through the authenticated routes. File-view tests and authoritative memory
tests are described in [MEMORY](MEMORY.md); a SQLite search hit is a view, not
authority to disclose memory.

## Credentials and verification

Sealed secret storage is tested by `stores randomized sealed boxes and only
decrypts in the owning space` and `rejects a wrong master key, changed
ciphertext and cross-row swaps`. The service process holds the master key and
decrypts a credential in ordinary process memory when it dispatches, so a
compromise of that process, or of the host, exposes them.

Run from the repository root:

```bash
bun test apps/melete/src/connectors
```

The broker's database scenarios also run under the full test command in
[README](../README.md).

## Watching a feed without spending on it

An `event` trigger wakes the job on every observation the connector delivers. On
a busy feed that means an attempt, a model call and a bill for every message,
most of which say nothing the person wanted to hear. A `watch` trigger is the
other thing: the service tests the observation itself, and wakes the job only if
a small deterministic predicate holds.

```ts
await client.api.POST('/jobs/{jobId}/triggers', {
  params: { path: { jobId } },
  body: {
    kind: 'watch',
    connection_id,
    event_name: 'mail.received',
    predicate: {
      all: [
        { field: 'sender_domain', op: 'eq', value: 'billing.example' },
        { field: 'subject', op: 'contains', value: 'overdue' },
      ],
    },
  },
});
```

The event name must be one the connection reports: a mailbox reports
`mail.received` (and `mail.new` for a reply to a chase), a calendar reports
`calendar.event.created`, `calendar.event.changed` and
`calendar.event.cancelled`, and a Google Drive reports `document.changed`. A
trigger on any other name is refused when it is
made, with the names the connection does report (`a watch on an event its
connection never produces is refused`). How the service reads those events
from Gmail, Outlook, IMAP, calendars and Drive, and what each observation carries, is
in [SITUATIONAL-AWARENESS.md](SITUATIONAL-AWARENESS.md).

The language is deliberately too small to hide a decision in: dotted field paths
into the observation, at most five clauses in all, and a handful of operators.
Every clause in `all` must hold, and when there is an `any` group, at least one
of its clauses.

| Operator | Holds when |
|---|---|
| `eq` | the field is exactly the value |
| `contains` | the text contains the value, or the list has it as an item |
| `matches` | the text matches the regular expression; a pattern that does not compile is refused when the watch is made |
| `lt`, `gt` | both sides are numbers, or both are timestamps |
| `changed` | the field differs from the last observation this watch looked at |
| `before`, `after` | the field is a time earlier, or later, than now plus the value in seconds (negative for the past) |
| `older_than` | the field is a time more than the value in seconds ago |

There is one `any` group, of two to five clauses, for a reason such as
"declined or cancelled". Anything wider is two watches, which keeps every wake
traceable to one predicate a person can read. A time clause takes a whole
number of seconds, up to a year; anything else is refused when the watch is
made.

Everything unclear is false: a missing field, a comparison between things that
are not comparable, a first sighting under `changed`. A watch that cannot tell
is a watch that does not wake.

When one does match, the job wakes with that observation as its evidence and the
consumed-event notice carries `because: ["event:<seq>"]`, so the wake can always
name the observation that caused it. Observations that do not match advance the
trigger's cursor and cost nothing else: no attempt, no model call, no row.

The attempt input lists the job's enabled triggers with their id, event name and
one plain sentence built from the spec. `job.wait` accepts either the trigger id
or the event name; the broker resolves a name under the job lock to the one
enabled trigger of this job that carries it, refuses a name no enabled trigger
carries, and asks for the id when two share it. An omitted deadline is no
deadline (`resolves the event name to the enabled trigger of this job,
broker-side`, `an unknown, disabled or ambiguous name is refused, and nothing is
recorded`).

## Discovering tools without loading every schema

The broker serves a small core plus `search_tools(query)` and `load_tool(name)`.
The core ranks candidates by lexical relevance to the job's objective and its
latest owner message, then granted files, knowledge and react tools, then the
most-used verbs on granted connections. `web.search` and `web.fetch` are always
in the core whenever a web connection grants them: like `ask_person`, they ride
beside the allowance, so a job's own tools never push them out and they take no
room from those tools (`web search and web fetch are always in the core, never
pushed out by the budget`). `job.wait` leads when the job has an
enabled trigger, and `react` leads when the attempt answers a person directly.
A reversible verb is shown only together with an external-write sibling from
the same connection and namespace. MCP tools are candidates only when the job's
words match them, and they are ranked behind everything the owner granted:
relevance is read off a tool's own description, and an MCP server writes its
own, so echoing the job earns it only the room no granted verb wanted
(`an MCP description cannot take the place of a granted connector verb`).
Selection budgets serialised schemas rather than counting tools.
The default core allowance is 750 estimated tokens of schemas, including
the two discovery tools, plus at most 250 estimated tokens for a names-only
index of every healthy tool left outside, carried on `load_tool`. The pinned
engine's scaffolding uses the rest of the 4,000-token tripwire.

`Connector.catalog` supplies trusted source metadata: `connector`, `capability`,
`skill` or `mcp`, up to two examples per verb, and optional core priorities.
Each compact entry carries its name, one-line description, schema fingerprint,
effect class, required scopes, connection and health. Capability producers such
as speech use this seam without changing discovery, and an unavailable
capability is left out of the catalog.

`POST /tools/search` accepts `{ "query": "archived invoices" }`. Postgres ranks
the already scoped entries with `tsvector`, weighting names above descriptions
and examples; no model is involved. Any query term may match: terms are ORed
and ranked, stemmed under the `english` configuration and also kept whole under
`simple`, and a name is indexed by its segments, so "restarting services"
reaches a verb named `ops.restart` (`search matches any term, stems it, and
reads identifier segments`). Only letters and digits from the query reach the
query text. Results target a 1,000-token allowance while
always returning the highest-ranked match, so a long scope list cannot hide a
capability. Results omit full schemas and tools already
loaded in this attempt. A query that matches nothing returns `tools: []`
together with `index`, the name and eight-word gist of every healthy tool that
can still be loaded, and a one-line `hint` (`a search with no match names what
can be loaded instead of returning nothing`). `POST /tools/load` accepts the exact result name. Two
accounts exposing the same verb receive stable account aliases, which the
broker resolves back to the original verb before deriving the action's intent
key. An alias cannot select another account.

Loads are recorded in `attempt_tool_context` and the event ledger. They survive
a service restart for the same attempt, expire with that attempt's authority,
and do not carry into a replacement attempt. A changed schema is not silently
substituted. Every search, load and use rechecks the current job, space, epoch,
revision and scopes. Loading a schema never grants a scope or changes an effect
class; ordinary execution still uses `POST /actions`.

Installed skills enter discovery as `skills.<name>` read tools.
Every attempt carries a skill index: each skill it may use, by name and one
line, within 500 estimated tokens, with no instructions. A skill it may use is
one whose every named tool it can reach (its granted connections plus the
broker's own `job.wait`) and, for a skill a person added to the space, whose
audience admits the attempt's principal; a space skill with no audience is its
owner's alone. The attempt reads any indexed skill with the broker's own
`skills.read`, which is in the first catalog whenever there is a skill to
read; each read is recorded once as a `tool_trace` notice that the
conversation shows as "Used the skill: …". Triggers only rank: up to three
skills whose whole-word triggers match the objective or the latest owner
message are given in full ahead of time and left out of the index, and the
rest of the index is ordered with the matching ones first. The last word of a trigger may carry an ending,
so "booked" and "replies" match "book" and "reply". A learned procedure the
person taught comes first, and a built-in skill covering the same work is left
out beside it: one whose trigger and the procedure's trigger are the same words
or one holds the other, or one with any trigger that occurs in the request the
procedure was learned on. A built-in covering other work may fill a free place. Each attempt that follows skills records one
`tool_trace` notice naming them, which the conversation shows as a tool entry;
the notice carries names, never a skill's instructions. Their content
is read through `POST /tools/call` after loading; their frontmatter tool list
cannot grant access. Space skills are withheld in the public compartment.
The existing deterministic initial skill selection remains available.

Hermes v2026.9.7 snapshots tools when an HTTP run starts. The plugin registers
the newly loaded schema, and the adapter verifies the broker's catalog change,
ends that run, then starts a continuation with the same attempt authority and
shared budgets. There is one public attempt outcome; model-written
`tools_loaded` text does not authorise a continuation.

## Installed MCP servers

The worker in `apps/melete/src/connectors/mcp.ts` takes a policy with an HTTP
URL, a container launch, or, for test fixtures, a stdio command and arguments, allowed scopes, an `owner` audience, and
an explicit list of exposed tools. For each tool the installation chooses a
local alias, required scopes and an effect class. The default is
`write_external`. Server annotations such as `readOnlyHint` never determine
policy, and a server tool the policy does not name is ignored.

The worker runs outside the runtime cell. Its test stdio transport uses a
filtered environment and its own temporary working directory. It receives neither vault
credentials nor database, broker or provider keys. It offers the server no
roots, sampling or other client capabilities. HTTP redirects, automatic call
replay and unbounded responses are refused. Results retain external-content
provenance and action evidence handles. A lost acknowledgement remains unknown;
generic MCP verification cannot prove that an effect happened.

An HTTP server is installed with `POST /connections` and its `mcp` block, as
described under [Installing a connection](#installing-a-connection); the row then
stores the policy.

### Protocol revisions

Over HTTP the client speaks every revision of the MCP transport in use. It first
sends `server/discover` the stateless way (revision `2026-07-28`): with the
revision, the client's name and its (empty) capabilities in the request's
`_meta`, and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. A
server that answers is spoken to that way from then on: no `initialize`, no
session, a header for each tool parameter whose schema marks it with
`x-mcp-header` (a tool whose marks break the rules is not offered), and
`server/discover` as the health check. A server that answers with any error
that is not one of the stateless revision's own gets the `initialize` handshake,
and may settle on `2025-11-25`, `2025-06-18` or `2025-03-26`; every later request
names the revision it chose. A server that settles on anything else is refused.

A stateless server that answers a call with `resultType: "input_required"` has
not acted, and Melete gives servers nothing beyond the call itself, so the call
fails without a retry. A call whose answer never came stays unknown and is never
sent again, whatever the revision. Evidence:
[mcp-protocol.test.ts](../apps/melete/src/connectors/mcp-protocol.test.ts).

### Signing in to an MCP server

A server that asks for OAuth can be connected by signing in from the browser
instead of pasting a token. `POST /mcp-sign-ins` takes the same `label` and
`mcp` block and answers with an `authorize_url` to open. The authorization
server returns the browser to `<MELETE_PUBLIC_URL>/api/oauth/callback`, the
connection is installed exactly as a pasted credential would be, and
`GET /mcp-sign-ins/{id}` reports `pending`, `connected` or `failed`.
`MELETE_PUBLIC_URL` must be an `https://` address or a `localhost` one.

The client follows the MCP authorization specification: protected resource
metadata (RFC 9728), authorization server metadata or OpenID discovery with an
exact issuer match, PKCE with S256, the resource indicator (RFC 8707) on the
authorization, token and refresh requests, and the issuer check on the returning
browser (RFC 9207). Discovery and the token exchange use the same reach the
installed connection has, so outside the setup owner's spaces every address must
be public.

Melete identifies itself to the authorization server in this order:

1. **A client you registered.** Pass `client: { client_id, client_secret? }`
   when the server's provider asks you to create an OAuth app yourself.
2. **A Client ID Metadata Document**, when `MELETE_PUBLIC_URL` is an `https://`
   address the authorization server can reach from the internet. The document is
   served at `<MELETE_PUBLIC_URL>/api/oauth/client-metadata.json`.
3. **Dynamic client registration**, when the server offers it.

A server may later refuse a call because it needs a scope that was not granted
(`403` with `error="insufficient_scope"`). The call stops without a retry, the
scopes the server named are kept on the connection, and the connection shows
them as `needs_scope`. `POST /mcp-sign-ins` with `{ "connection_id": ... }`
signs in again for that connection: it asks for everything granted before
together with the scopes needed since, and gives the same connection the new
credential, keeping its id, grants and history. The same request renews a
connection whose sign-in has ended.

An installation reachable only on a private network or tailnet uses dynamic
registration or a client you registered: when its `MELETE_PUBLIC_URL` is an
`https://` address, set `MELETE_OAUTH_CLIENT_METADATA=false` so the metadata
document is not offered. When a server offers none of these,
the sign-in answers `409 client_registration_required`; register a client with
that provider and sign in again with its client ID.

Where an MCP server may live depends on whose space it is installed in. In the
setup owner's spaces it may be at any address, including one on the owner's own
machine or network. In every other account's space it must be at a public
address: the service applies the address checks of `web.fetch`, so a loopback,
private, link-local or otherwise non-routable destination is refused, whether it
is written as a literal address or is what the name resolves to. Installation
answers such an address with `400`. Every request to the server resolves the
name again, refuses it if any answer is not public, and connects to the address
it checked, so a name that later resolves inside the installation reaches
nothing. Evidence: `an MCP server at a private address is the setup owner’s
alone` in
[connection-kinds.test.ts](../apps/melete/test/integration/connection-kinds.test.ts)
and [public-fetch.test.ts](../apps/melete/src/connectors/public-fetch.test.ts). The same policy can instead be pinned by the operator: create
the connection row with provider `mcp` and the exact granted tool scopes, then
add its transport and policy to the owner-controlled `MELETE_CONNECTIONS_FILE`:

```json
[
  {
    "kind": "mcp",
    "id": "conn_REPLACE_WITH_CONNECTION_ID",
    "server": {
      "id": "notes",
      "endpoint": { "transport": "http", "url": "http://127.0.0.1:8080/mcp" },
      "allowed_scopes": ["mcp_notes.search"],
      "audience": "owner",
      "tools": [
        { "name": "search", "alias": "search", "required_scopes": ["mcp_notes.search"], "effect_class": "read" }
      ]
    }
  }
]
```

Service startup registers configured HTTP servers against their persisted
connection and space. Owner-only tools disappear from public compartments, and
the audience and persisted scopes are checked again before dispatch. Server
schemas default to JSON Schema 2020-12; draft-07 schemas can declare their
dialect explicitly. Unsupported dialects or unresolved references fail validation.
Shutdown disposes HTTP sessions (a stateless server has none). This
implementation does not configure server authentication or resume disconnected
sessions; it sends no service secrets.

### Connecting an app from the catalog

`MCP_CATALOG` in `packages/contracts/src/mcp-catalog.ts` lists apps whose makers
run their own remote MCP server, each with the tools Melete uses there and what
each may do:

- `read`: looks only, and runs without asking;
- `write_reversible`: a change that can be put back where it was made, such as
  editing a page or moving an issue to another state; it goes through
  auto-review like any other reversible change;
- `write_external`: posts or sends something as the person that others see or
  are told about (a comment, a new issue, a pull request), merges, or deletes;
  it always asks first;
- `spend`: moves or commits money (Stripe's refunds, invoices, payment links and
  subscription changes); it always asks first.

`POST /mcp-sign-ins` with `{ "catalog_id": "notion" }` signs in to that app's
server exactly as above. When the browser returns, the server is asked for its
tools with the new credential, and the connection is installed with the catalog's
tools that the server has, each with its own grant (`mcp_<id>.<alias>`). A tool
the server lists that the catalog does not name is never offered; one the
catalog names that the server lacks is left out. An app that offers none of them
is not installed (`catalog_tools_unavailable`). The connection is shown as the
app (`catalog_id` on `GET /experience/connections`), and disconnecting it is the
ordinary revoke. Evidence: `connecting an app from the catalog` in
[mcp-sign-in.test.ts](../apps/melete/test/integration/mcp-sign-in.test.ts) and
[mcp-catalog.test.ts](../apps/melete/src/connectors/mcp-catalog.test.ts).

#### Connecting GitHub

GitHub's MCP server (`https://api.githubcopilot.com/mcp/`) accepts only an OAuth
app registered with GitHub ahead of time. Register one at
github.com/settings/applications/new (free, with no review), with
`<MELETE_PUBLIC_URL>/api/oauth/callback` as its callback URL, then set
`GITHUB_MCP_CLIENT_ID` and `GITHUB_MCP_CLIENT_SECRET` and restart. Until both are
set, GitHub is listed as not set up, and its operator is told what to set.

A stdio MCP server never runs under the service's own identity. The stdio
fixture above is launched only by tests; a server a person installs runs in a
container of its own, described next.

## Plugins and stdio MCP servers

A plugin is a stdio MCP server Melete runs for a person. `GET /plugins` lists
the starter catalog; adding one is `POST /plugins/{id}` with the few values the
entry asks for, which is one tap for most:

| Plugin | Runs | Reaches | Asks for |
| --- | --- | --- | --- |
| Files | `@modelcontextprotocol/server-filesystem@2026.8.31` with `npx` | nothing | nothing |
| Fetch a page | `mcp-server-fetch==2026.8.18` with `uvx` | any public HTTPS site, or only the sites the person lists | nothing; sites to keep it to, if the person wants |
| Time and time zones | `mcp-server-time==2026.8.18` with `uvx` | nothing | nothing |
| GitHub | `ghcr.io/github/github-mcp-server:v1.12.2`, pinned by digest | `api.github.com` | a GitHub token |

Each entry names the tools it offers and how far each may act. Reading is
admitted within scope; saving into the plugin's own folder is a reversible
write; opening or changing a GitHub issue is an external write that waits for
the person's approval every time. A value the entry marks secret, such as the
GitHub token, is sealed on arrival and given to that plugin's container only.
What is missing or malformed is answered with `400` and a sentence naming the
field. The same plugin is added once per space; a second request answers
`409`. Adding a plugin is a new route and a new response shape; nothing an
existing client reads changes.

The catalog pins versions. When a release pins a newer one, the service moves
an installed plugin to it at start: it starts the new version once, records
the tools it describes, and keeps the plugin on the version it had if the new
one will not start (`a plugin moves to the version a release pins, and stays
put if that version will not start`). The tools, their grants and the person's
values stay as they were installed.

Plugin tool calls are broker actions, so they appear in the conversation's
trail like every other connector call, under the plugin's name.

### The advanced path

The owner of a space can also install a server by hand with `POST /connections`
and an `mcp_stdio` block, which `GET /connection-kinds` describes as the
advanced kind:

```json
{
  "provider": "mcp",
  "label": "Notes server",
  "mcp_stdio": {
    "id": "notes",
    "runner": "npx",
    "source": "@example/notes-server@1.0.0",
    "args": ["/data/home"],
    "egress": ["api.example.com"],
    "secret_env": [{ "name": "NOTES_TOKEN", "value": "…" }],
    "allowed_scopes": ["mcp_notes.lookup"],
    "audience": "owner",
    "tools": [
      { "name": "lookup", "alias": "lookup", "required_scopes": ["mcp_notes.lookup"], "effect_class": "read" }
    ]
  }
}
```

`runner` is `npx` for an npm package, `uvx` for a PyPI package, or `image` for
a container image. `source` is a registry name with an optional version, or an
image reference; a URL, a git remote, a local path or anything shaped like a
flag is refused. `command` names a package's program or overrides an image's
entry command. `egress` lists HTTPS host names, each with an optional port, or
`*` for any public HTTPS site. Plain HTTP is refused either way, and so is any
name that resolves to a private, loopback or link-local address.
Each `secret_env` value is sealed together with the others; the row keeps only
the names, and a name the launcher sets itself, such as `PATH` or
`HTTPS_PROXY`, is refused. The policy fields are those of an HTTP installation,
and an unclassified tool is an external write.

### Where a server runs

Stdio servers run only where attempts run in containers
(`MELETE_RUNTIME_ADAPTER=docker`); elsewhere the kind and the catalog are not
offered and installation answers `400`. The service reaches the Docker engine
through `melete-cells`, as its runtime supervisor does, which starts a server
only in this shape and gives each connection:

- one container at a time, as uid 10001, on a read-only root filesystem, with
  every capability dropped, `no-new-privileges`, Docker's default seccomp
  profile, 512 MiB of memory without swap, 128 processes, one CPU and a 64 MiB
  `/tmp`;
- its own volume, mounted at `/data`, kept between runs and removed with the
  connection, and for a package runner the prepared package, mounted read-only
  at `/pkg`. Those are its only mounts: no host path, no Docker socket, nothing
  of the service. Any volume the image itself declares is anonymous and is
  removed with the container;
- no network at all when `egress` is empty. With destinations named, an
  internal network whose only other member is the service's container. There
  the server can open the service's listeners on that network, and nothing
  else: the egress proxy, which needs the token its start was given and opens
  HTTPS tunnels to the named hosts alone, and only when every address a name
  resolves to is public; and the broker, which answers only a request carrying
  an attempt's capability. The owner API does not listen there, and names
  outside the network do not resolve;
- an environment of its home, its `/tmp` and the sealed variables, and no
  container log: what the server says is read from its attached output and
  kept nowhere else.

The service speaks to the server over the container's attached standard input
and output, so a server with no network is still reachable. Before a container
starts, the service reads back what the engine recorded for it (the user, the
read-only root, the dropped capabilities, `no-new-privileges`, that it is not
privileged, its process and memory limits, its network and each mount) and
removes it unstarted if any of these is less than asked. A network the engine
did not record as internal is removed before anything joins it.

An image pins its digest (`ghcr.io/org/server:1.0@sha256:…`, or a Docker Hub
name such as `node:22@sha256:…`), and it runs only if the image on the host
carries that digest. It can come from any registry, public or private, such as
`ghcr.io` or a company's own `registry.example.com` or `10.0.0.5:5000`, except
one that points back at the host: `localhost` and loopback addresses
(`127.0.0.0/8`, `::1`), `0.0.0.0`, link-local and cloud metadata addresses
(`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`), Docker's
`host.docker.internal` and `gateway.docker.internal`, the engine's own ports
2375 and 2376 on any host, and wildcard-DNS names such as `127.0.0.1.nip.io`
that spell one of those addresses. Before a pull the service resolves the
registry's name and refuses it if any address is one of those. The engine
resolves the name again itself and follows a registry's redirects and sign-in
address, so these checks narrow where it connects rather than bound it; an
operator who needs a fixed set of registries puts the images on the host and
limits the host's outbound traffic. An image already on the host runs without
a pull. The runners' own images are pinned the same way.

A package runner is prepared in a separate container that holds no secret and
may reach only its registry (`registry.npmjs.org`, or `pypi.org` and
`files.pythonhosted.org`). Preparation writes the package into a volume of its
own, keeps its home and caches in memory, and reads no user, global or project
configuration (npm's user and global files point into its empty `/tmp`, and
`UV_NO_CONFIG=1`), with uv
held to the image's own Python. It never sees the server's `/data`, and the
server can only read what it prepared, so nothing a server writes reaches the
next preparation or changes what runs. The server then runs offline from the
package volume. Preparation happens once per service start.

A server with destinations, and any package runner, needs the service to run
in its Compose container, since the proxy lives there. Images are pulled
without registry credentials, so an image must be public or already on the
host. At most sixteen servers run at once across the deployment; a start
beyond that is refused, in plain words, without counting against the server.
`MELETE_MCP_NODE_IMAGE` and `MELETE_MCP_PYTHON_IMAGE` choose the runners'
images, `MELETE_MCP_EGRESS_PORT` the proxy's port inside the service
container, and `MELETE_MCP_IDLE_MS` how long a server may sit unused.

### Start, stop and failure

Installation starts the server once, so the tools it describes are recorded;
the row keeps them, and the service starts afterwards without running the
server. A server starts for the first call the broker has admitted, is stopped
after ten idle minutes, and starts again for the next call. A restarted server
that describes different tools is refused and stopped. Three crashes, or
starts that never reach a working session, within ten minutes leave the server
stopped: calls fail without a start and say so in plain words, until the owner
tests the connection with `POST /connections/{id}/health`, which is one
deliberate retry. When a connection goes, whether revoked by its owner or
removed with its space, the registry retires its connector: the container
stops at once and the volume is removed. Shutting the service down only stops
the containers. At start the service removes any server container an
earlier process left behind, and the volume of any connection that no longer
exists.

Evidence: `a stdio server starts for its first call, stops when idle, and
starts again`, `a server that keeps crashing is left stopped until its owner
tests it`, `a restarted server that describes different tools is refused and
stopped` and `a server's annotations and results never change what a tool may
do` in `mcp-stdio.test.ts`; the container's restrictions against a recording
engine in `mcp-stdio-docker.test.ts`; the proxy's grants in `mcp-egress.test.ts`;
and, through the API, broker and registry with a fake launcher, `sealed
variables reach only the server; its tools are admitted by the broker like any
other`, `a restarted service offers the recorded tools and starts nothing until
a call needs it`, `a server that crashes on every start is refused without
starting, until its owner tests it`, `a plugin is added with one tap from the
catalog, with only the values it asks for` and `revoking the connection stops
its server and removes what it kept` in
[mcp-stdio.test.ts](../apps/melete/test/integration/mcp-stdio.test.ts). The
same restrictions are observed from inside real containers by
[conformance 10](../conformance/README.md), which CI runs on every pull request.

## Remote sandboxes (optional plugins)

A space's owner can install a `sandbox` connection so the agent's
`terminal.run` commands run on a remote machine from E2B, Daytona or Modal. Each
provider is an optional plugin: an adapter in
[`sandbox/adapters/`](../apps/melete/src/sandbox/adapters/) and one entry in
[`registry.ts`](../apps/melete/src/sandbox/adapters/registry.ts), beside its
name in the connection contract. A new provider is its adapter file and that
entry.

Nothing provider-specific is loaded until a connection that selects the
provider is used. E2B and Daytona are reached over their HTTP APIs with no
SDK. The Modal SDK is the optional `modal` dependency, imported on the first
use of a Modal connection; a normal install includes it, and an installation
that removes it is told plainly when a Modal connection needs it. A deployment
with no sandbox connection runs without any of them. Setting
`MELETE_SANDBOX_PROJECT` is what lets a sandbox connection be installed at all.

The provider key is sealed with the connection and lent to the adapter one
request at a time, and a sandbox's environment carries no Melete or provider
credential. Egress is fixed when the sandbox is created and comes only from the
connection: `deny_all`, a CIDR allow-list, or `open`. A configuration the
adapter cannot enforce is refused when the connection is installed.

### Daytona

- `adapter: daytona`; `image` is a Daytona snapshot name; `credentials.api_key`
  is the Daytona API key on its own.
- Daytona sets a sandbox's egress only for organisations on Tier 3 or Tier 4.
  This adapter has not yet been run against a lower tier. Daytona's allow-list
  takes IPv4 ranges only, at most ten.
- The adapter reads Daytona's record of each sandbox back before using it, and
  a sandbox whose recorded egress differs from the connection's is destroyed.
- With `persistence: pause`, a workspace is a stopped sandbox between attempts:
  its files are kept and its processes end. Daytona keeps a stopped workspace
  for at most `MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS`.
- A sandbox's lifetime is set as Daytona's `autoStopInterval`, which counts idle
  minutes rather than a hard lifetime: a sandbox this service no longer holds is
  stopped once idle, and deleted by reconciliation or after
  `MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS`.
- Each command runs in a toolbox session of its own and is polled to its end,
  so a long command does not depend on one request staying open. A command
  whose outcome is lost after it started is recorded as unknown and never run
  again.
- Commands run without the `DAYTONA_*` variables the daemon passes on. Those
  are identifiers, not credentials, and as with Modal's they stay readable
  inside the sandbox from `/proc/1/environ`.
- Evidence: [daytona.test.ts](../apps/melete/src/sandbox/adapters/daytona.test.ts)
  runs the provider-neutral conformance and workspace suites over the adapter,
  replaying fixtures written from Daytona's published REST and toolbox APIs and
  its v0.190.0 source; a missing, extra or different request fails the run.
  [daytona.live.test.ts](../apps/melete/src/sandbox/adapters/daytona.live.test.ts)
  runs the same suites against Daytona with `MELETE_SANDBOX_LIVE=daytona` and
  `DAYTONA_API_KEY`.

## Composing read results

`compose` accepts a list of named reads and a JavaScript function body operating
on their JSON results. It preflights the complete list, then performs each read
as an individual broker action with its own budget reservation and receipt.
The script receives only JSON data; it cannot call tools, select connections or
grant itself authority. The broker returns bounded JSON plus the underlying
action evidence handles, and derived output retains inferred provenance.

The broker offers `compose` only when a `ComposeExecutor` is injected, and the
default service entry point injects none, so the shipped catalog does not carry
it (`HTTP composition is unavailable without the service-owned cell executor`).
The in-process fallback is restricted to tests: `node:vm` is not a security
boundary and imposes no memory limit.
