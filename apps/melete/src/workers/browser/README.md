# Browser worker

The service owns a `BrowserWorkerPool`. Each local development worker is a separate
Node 24 process, with one space root and a random broker-only HTTP token. The child
receives OS essentials, never the service environment or database/provider keys.
Production uses explicitly configured isolated worker endpoints.

Install the pinned dependencies with `bun install`, then install Chromium with
`bunx playwright install chromium`. Linux images also need Playwright's Chromium
system dependencies. Browser tests become a named `todo` when the executable is
absent; CI can omit the browser download deliberately. Tests use Bun, but Chromium
launches in the Node worker: Bun's Windows pipe launch timed out in the local probe.

`BrowserSessions` stores the space, profile directory, job lease, idle deadline,
and control epoch. It keeps Chromium warm for five minutes by default. While a
person holds control, their live channel's activity keeps it open for fifteen
minutes (`MELETE_BROWSER_HUMAN_IDLE_MS`). A new lease after idle expiry gets a new
session identity and a greater epoch. Public research uses a disposable context
without the persistent profile's cookies.

The worker's listener requires a service token and rejects browser Origin and
Fetch Metadata headers. It exposes only health, lease, command, takeover,
handback, release, and a person's live channel (`/live/open`, `/live/pull`,
`/live/input`, `/live/scope`, `/live/close`), whose input is typed page events,
never a browser protocol method. The runtime receives connector tools, never this
token.

The worker image installs `playwright`, `zod` and `tldts` and copies this
directory, so nothing here may import `@melete/contracts` at runtime; type imports
are erased. `live-protocol.ts` mirrors the live contract, and its test keeps the two
equal.
