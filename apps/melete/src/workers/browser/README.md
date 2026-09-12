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
and control epoch. It keeps Chromium warm for five minutes by default. A new
lease after idle expiry gets a new session identity and a greater epoch. Public
research uses a disposable context without the persistent profile's cookies.

The worker's listener requires a service token and rejects browser Origin and
Fetch Metadata headers. It exposes only health, lease, command, takeover,
handback, and release. The runtime receives connector tools, never this token.
