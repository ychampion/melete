# Command-line access with a connected account

The agent's computer runs ordinary command-line tools. When a person connects
an account for the computer, those tools can use it while the account's secret
stays in the Melete service: the computer holds a placeholder, the service
adds the account on the way out, and every change asks the person first.

This works with the Computer on this server (Docker). The computer's only way
out is the service's egress relay ([sandbox-docker](sandbox-docker.md#what-it-may-reach)),
which is where the account is added. Remote computers (E2B, Modal, Daytona)
reach the internet directly, so a command-line account is offered only for the
Docker computer.

## What the relay does

**The relay terminates TLS for the hosts of a connected account.** For those
hosts, and only for a command whose space has the account connected, the relay
answers the computer's connection itself, with a certificate for that host
signed by the installation's egress certificate authority, reads each request,
and makes the request to the real host over a new TLS connection that checks
the host's own certificate. Every other host stays a blind tunnel: the relay
passes the encrypted bytes through and never sees them.

For each request inside a terminated connection:

- The computer's own `Authorization`, `Proxy-*` and `Cookie` headers, any
  header naming a different method (`X-HTTP-Method-Override`, `X-HTTP-Method`,
  `X-Method-Override`), and any header carrying one of the account's
  placeholders, are removed.
- The request must name the connection's host, in its `Host` header and in any
  absolute address. HTTP/1.1 only; upgrades and tunnels inside the connection
  are refused.
- The account's adapter says what the request does: it reads, it changes
  something, or it is refused. A request the adapter cannot read, or does not
  list, counts as a change.
- **A read** goes out with the account added. The answer comes back
  uncompressed, without `Alt-Svc` or `Set-Cookie`, and with every form of the
  secret replaced by `[redacted]`, even if the service echoes it.
- **A change** is held while Melete asks. The approval is bound to the request
  as it will be sent: its method, address, the digest of its exact body bytes,
  and every header that goes with it (only `User-Agent`, `Date`, `Traceparent`,
  `Tracestate` and `X-Request-Id` are left out), and the change forwards exactly
  those. A request that differs in any of them is a new approval. The card
  shows the adapter's summary, the headers, and the body as text or JSON; a
  binary body is shown by its size and digest, and a long one says how much is
  not shown. A change that deletes or overwrites something says so. If the person answers
  within about 90 seconds (`MELETE_EGRESS_APPROVAL_HOLD_SECONDS`, always ending
  ten seconds before the command's own time), the change goes out inside the
  same command. If not, the command is told, in plain words, to wait, and the
  work waits for the answer. After approval the agent runs the same command
  again and the change goes out once; running it a third time is answered with
  what already happened. A change whose answer was lost after it was sent is
  never sent again.
- Changes larger than `MELETE_EGRESS_HOLD_MAX_BYTES` (64 MiB) are refused with
  a plain message. A computer has at most four requests that may be changes in
  hand at once, checked before a body is read, and the bodies the relay holds
  stay within a budget of four such requests per computer and sixteen for the
  whole installation; past either, the request is refused and nothing is sent.

Each change is an ordinary Melete action: its scope, its approval bound to the
request as above, the job's revision, the budget, and a receipt
from the service's answer. Every connection the computer opens has an egress
record; a connection that used an account also records its reads, its changes
and their actions, and the command's step lists the hosts it reached.

## What the computer holds

- placeholders in place of the account, where a tool needs a value to run;
- the egress certificate authority's **certificate**, at
  `/home/agent/.melete/ca/egress-ca.pem`, and a bundle of the public roots plus
  it at `/home/agent/.melete/ca/bundle.pem`, which each command's environment
  points common clients at (`SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`,
  `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `AWS_CA_BUNDLE`,
  `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE`);
- a token for each running command, which works only from that computer and
  only until the command ends.

It never holds the account's secret or the certificate authority's key. A
connection a command opened stops carrying the account the moment that command
ends.

## The egress certificate authority

- Its key is ECDSA P-256, made the first time it is needed, sealed with the
  installation's master key for this one purpose, and used only inside the
  service.
- Its certificate is name-constrained to the DNS names of the adapters this
  installation offers and excludes every IP address, so it can vouch for those
  names and no others.
- Host certificates last a day and are kept in memory only.
- It lasts two years and is replaced ninety days before it ends, when the
  adapters' names change, or when the master key can no longer open it. A
  computer receives the new certificate with its next command.

## GitHub

Connect it in Settings, under Connections, as **GitHub for the agent's
computer**, with a fine-grained token: choose only the repositories the work
needs, and give read and write on Contents and Pull requests. Melete asks
GitHub whose token it is (`GET /user`) before keeping it, and the connection
shows that account. It has two grants: reading the repositories, and pushing
and making changes, which asks each time. The connection's own check asks
GitHub the same question again.

The computer has `git` and `gh` (2.83.2, pinned by checksum in the image).
Each command gets `GH_TOKEN` set to a placeholder, `GH_PROMPT_DISABLED=1` and
`GIT_TERMINAL_PROMPT=0`. git's requests carry the token as `x-access-token`
basic credentials and the API's as a bearer token.

| Host | What goes through it |
| --- | --- |
| `github.com` | git over smart HTTP, and Git LFS |
| `api.github.com` | the REST and GraphQL APIs: everything `gh` does |
| `codeload.github.com`, `uploads.github.com`, `raw.githubusercontent.com` | downloads; a change sent to one of them is refused |

What reads: cloning and fetching (`info/refs` and `git-upload-pack`), every
`GET` and `HEAD`, rendering Markdown (`POST /markdown`), GraphQL documents with
only queries in them, Git LFS downloads and lock checks, and git's empty probe
before a large push. Everything else is a change and asks:

- **A push** (`git-receive-pack`) is read up to its pack. The card shows the
  repository and each ref update, old and new commit, as a new branch, an
  update or a **delete**, with any push options and whether the push is all or
  nothing. The approval is bound to the repository, each update, the push
  options and the exact bytes of the command list. The commits name their own
  content by hash, so the pack that carries them is left out: git may pack the
  same commits differently when the command runs again. A push whose commands
  cannot be read exactly, such as a signed push or a compressed body, is asked
  for as the request itself and bound to every byte.
- **A REST call** with any method other than `GET` or `HEAD` is bound to its
  method, path, query and body. Pull requests (open, merge, review, comment),
  issues (open, comment, close, reopen), releases, branches and tags, workflow
  runs and dispatches, file contents, Actions secrets and deleting a repository
  have their own summaries; any other call is summarised by its method, path
  and size, with the whole body under Details.
- **A GraphQL document** with a mutation or subscription anywhere in it, or one
  that does not parse, is bound to its exact text and variables. The mutations
  `gh` uses (opening, editing, merging, closing and reviewing pull requests,
  comments, issues, branches and tags) have their own summaries, and the card
  shows the document and its variables.
- **A Git LFS upload** shows how many files it sends and their size.

If the person answers while a push is held, it completes inside the command.
If not, git prints the reason beside each ref:

```
 ! [remote rejected] melete/fix-login -> melete/fix-login (Waiting for your approval in Melete: Push to alice/site (melete/fix-login). Run the same command again once it is approved.)
```

and `gh` prints the same sentence as the API's error message. After approval,
the same command sends the change once.

A push keeps on its receipt the status GitHub reported for each ref; a push
whose refs were all rejected, or a GraphQL answer that holds only errors, is
recorded as failed. A REST change keeps the address of what it made, and a
GraphQL change the ids and addresses it returned.

**Standing permission.** Answering "Always" on a push card makes a rule for
that repository that covers later pushes creating or moving branches under
`melete/`, within the rule's count, expiry and re-consent window. A push to any
other branch, a tag, a delete, and every REST or GraphQL change still ask. The
rule reads the ref updates, not the history between them, so it also covers a
push that rewrites a `melete/` branch. It is offered when the repository's name
came from the person or a connected app, and it follows the repository through
a rename or a transfer, as GitHub's own redirects do.

A push the rule covers also starts the repository's workflows that run on
push. They run the pushed code with the repository's secrets and its workflow
token, and a workflow token allowed to write can push to any unprotected
branch, the default branch included. The rule's own text says so. Before
saying "Always", use a token without the Workflows permission, set the
repository's default workflow permissions to read, and protect the default
branch.

Signed links GitHub hands out, for release assets, archives and raw files of
private repositories, reach the computer as GitHub sends them. Each opens one
object for a few minutes, an object the computer could already read with the
account.

## Limits

- Docker computers only, as above.
- A standing rule for pushes lets those pushes run the repository's workflows
  without asking, with its secrets; see [GitHub](#github) for the settings that
  keep them from reaching the default branch.
- An account can read whatever its own permissions allow, and a computer with
  `open` egress can send what it read anywhere public. Give an account only the
  access the work needs, and choose `connected_hosts_only` for a computer that
  should reach the account's hosts and nothing else.
- Inside one computer, a process can read another's environment and borrow a
  running command's token. That moves which command a request is recorded
  against; every change still asks the same person.
- A tool that keeps its own list of trusted certificates and ignores the
  variables above cannot use a connected account.
