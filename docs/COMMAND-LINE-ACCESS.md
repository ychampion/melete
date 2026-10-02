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

## Limits

- Docker computers only, as above.
- An account can read whatever its own permissions allow, and a computer with
  `open` egress can send what it read anywhere public. Give an account only the
  access the work needs, and choose `connected_hosts_only` for a computer that
  should reach the account's hosts and nothing else.
- Inside one computer, a process can read another's environment and borrow a
  running command's token. That moves which command a request is recorded
  against; every change still asks the same person.
- A tool that keeps its own list of trusted certificates and ignores the
  variables above cannot use a connected account.
