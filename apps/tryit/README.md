# Try it

Paste an email from a company, or write what happened. Get back a case file:
what you are owed and why, the sentence that proves it, the message to send,
and what to do if they go quiet. No account, nothing kept.

One page and one endpoint, on a Cloudflare Worker. It stands on its own: it
shares the design tokens and the mark with `apps/web`, and nothing else. It
does not talk to the Melete API and it has no database. The only thing it
keeps is the day's counters, and those are keyed by a daily digest rather than
by an address, so no visitor's address is written down anywhere.

## Run it

```sh
bun install
bun run --cwd apps/tryit dev        # wrangler dev, http://localhost:8787
bun test apps/tryit                 # the gates, the caps, the route, the Worker
```

With no `OPENAI_API_KEY` the page answers from the scripted provider: it reads
the pasted text, works out which situation it is, and quotes real sentences
back. It never searches, so it never cites a page. `/healthz` says which
provider and which counter are running.

## What is guaranteed, in code

The model's answer is checked before anyone sees it. The rules are in
`src/validate.ts`, not in the prompt, because a prompt is a request:

- **A quote is a copy.** Every quote shown is an exact substring of what was
  pasted. Anything else is dropped. If nothing survives, the case file says so
  and the odds come down a step. `src/text.ts` folds both sides into one
  canonical form first — wrapping, non-breaking spaces, typographic quotes and
  dashes — and the text that is displayed is sliced out of the paste, never
  taken from the model.
- **A link is a page that was opened.** Every URL shown appeared in the web
  search tool's own list of retrieved sources for that request. Others are
  dropped.
- **The shape is the shape.** The reply is the case file or it is nothing.
- **Nothing pasted is stored.** No database, no session, `store: false` on the
  API call. The log line carries character counts, timings and an outcome code,
  never content.
- **No address is stored either.** The counter is keyed by a digest of the
  address and the day, worked out in the Worker, so the address never reaches
  the counter or its storage and the key changes at midnight. Set
  `TRYIT_COUNTER_SALT` to make that digest one-way in earnest rather than
  merely daily.
- **The paste is data.** The system prompt says so, the model gets web search
  and no other tool, and the fence around the text cannot be closed from inside
  it.

## The model call

`src/openai.ts`, one call to the Responses API:

| | |
| --- | --- |
| model | `gpt-6-astra` (`MODEL`) |
| structured output | `text.format` = `{ type: 'json_schema', strict: true }` |
| tool | `{ type: 'web_search' }`, nothing else |
| sources | `include: ['web_search_call.action.sources']` — the list the link gate checks against |
| effort | `reasoning.effort` (`REASONING_EFFORT`), never `none` |
| retention | `store: false` |

## The caps

Both are configuration, both are counted in one Durable Object so the count is
the same wherever a request lands.

| Variable | Default | |
| --- | --- | --- |
| `TRYIT_PER_IP_PER_DAY` | 5 | case files one address may have in a day |
| `TRYIT_GLOBAL_PER_DAY` | 400 | case files the whole page may produce in a day |
| `TRYIT_MAX_INPUT_CHARS` | 20000 | longest paste accepted |
| `TRYIT_MIN_INPUT_CHARS` | 40 | shortest paste worth a case file |
| `TRYIT_REQUEST_TIMEOUT_MS` | 100000 | how long one request may take |

An attempt that produced nothing is given back, so an upstream failure does not
cost someone one of their five. With a key set and no Durable Object bound the
endpoint refuses: an approximate spend cap on a real key is not a spend cap.

## Deploy

`workers.dev` only. No custom domain, no DNS record.

```sh
cd apps/tryit
bunx wrangler deploy                      # first deploy creates melete-tryit.<subdomain>.workers.dev
bunx wrangler secret put OPENAI_API_KEY   # paste the key; it is never echoed
curl -s https://melete-tryit.<subdomain>.workers.dev/healthz
# expect {"ok":true,"provider":"live","limiter":"durable"}
```

To set the secret from a file without it appearing anywhere:

```sh
grep -h '^OPENAI_API_KEY=' ~/.config/melete/openai.env | cut -d= -f2- \
  | bunx wrangler secret put OPENAI_API_KEY --name melete-tryit
```

`LANDING_URL` in `wrangler.toml` is the one place the landing site's address
appears.
