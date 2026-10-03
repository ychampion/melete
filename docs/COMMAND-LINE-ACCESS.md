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
- An answer that holds a new credential the service handed out (a GitLab
  personal, deploy, runner, trigger, cluster agent, feed or incoming mail
  token, an npm token) is not passed on:
  one seen before the answer starts is replaced by a plain refusal, and one
  seen later cuts the answer off before any of it is sent. A change whose
  answer is withheld this way is recorded as possibly landed.
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
other branch, a tag, a delete, a push that carries push options, and every
REST or GraphQL change still ask. The
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

## AWS

Connect it in Settings, under Connections, as **AWS for the agent's
computer**, with an access key of an IAM user that has only the permissions
the work needs, a default region, and optionally a role to assume (with its
external ID, if the role's trust policy asks for one). Melete asks AWS whose
key it is (STS `GetCallerIdentity`, after assuming the role when one is named)
before keeping it, and the connection shows that identity's ARN. It has two
grants: reading, and making changes, which asks each time. The connection's
own check asks AWS the same question again.

The computer has the `aws` command line (version 2.37.8, pinned by checksum in
the image). Each command gets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
set to placeholders and `AWS_REGION` set to the default region; the AWS SDKs
read the same variables.

**Signing.** AWS requests are signed with the key itself (Signature Version 4),
so the account cannot simply be added as a header. Commands in the computer
sign with the placeholder key. For every host under `amazonaws.com`, the relay
reads that signature for the service and region it names, removes it, and
signs the same request again: with the stored key, or, with a role, with a
session of that role that the service assumes for each command and names after
it (`melete-<command id>`), so CloudTrail shows which command made each call.
The session lasts fifteen minutes and its keys stay in the service. The
signature is made with `@smithy/signature-v4` (Apache-2.0), the signer of the
AWS SDK for JavaScript; a test checks it against the signatures the AWS SDK for
Python makes for the same requests.

- A request signed with any other key, carrying its own session token, or
  presigned in its query, is refused and never sent: the computer may hold
  other AWS keys, and they are never mixed with the account.
- A request with no AWS signature goes out as it is, without the account, as it
  would to any other host.
- Uploads whose body is signed chunk by chunk
  (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`) are refused with a plain message. The
  `aws` command line signs uploads whole or sends them unsigned with a trailing
  checksum (`STREAMING-UNSIGNED-PAYLOAD-TRAILER`), which goes through.

**What reads and what asks.** The relay knows each AWS service from the AWS
SDK's own service definitions (a table generated from them sits beside the
adapter): its host, its signing name, and the protocols its endpoint speaks. A
request's operation is believed only where its service reads it.

- Query and EC2 services by the `Action` parameter, read from the query and
  from the body as a form whatever its content type; JSON services by
  `X-Amz-Target`, which must be the service's own target prefix and one
  operation; CBOR services by the operation in the path. Operations whose names
  begin with Get, List, Describe, Head, Query, Scan, BatchGet, Select, Lookup,
  Search or Filter read; everything else asks.
- REST services by method and path alone: `GET` and `HEAD` read unless the
  service's definition names that route as something else; every other method
  asks.
- A request that names its operation twice, in two ways, or in a way its
  service does not read (an `Action` sent to a REST service, say) is refused. A
  service the definitions do not know asks for everything. Where one host
  serves several APIs, a request reads only if it reads for each of them.
- **S3** reads with `GET` and `HEAD`. Every other request asks, named as the
  operation it is (`s3:PutObject`, `s3:DeleteObjects`, `s3:PutBucketPolicy` and
  so on) with the bucket and key, read from the host the way S3 reads it; a
  delete of many objects lists them. Starting a multipart upload asks (it
  carries the object's settings, such as its ACL), and completing it asks. In
  between, the parts pass without asking only into an upload this job started
  with an approval, for the same bucket and key, up to 10,000 parts and 64 GiB;
  any other part asks on its own.
- Reading a stored secret asks like a change: Secrets Manager
  `GetSecretValue`, a Systems Manager parameter read with decryption (including
  its history), Cognito user pool client details, API Gateway keys with their
  values, and EC2 `GetPasswordData`.
- Operations that hand out credentials are refused: assuming a role, getting a
  session or federation token from STS, creating an access key or service
  credential in IAM, SSO role credentials, Cognito identity credentials, ECR and
  CodeArtifact authorization tokens, Redshift database credentials, Lightsail
  and GameLift access details, EMR cluster credentials and S3 Express
  sessions, and in any service an operation named as assuming a role or as
  getting, creating or generating credentials, a token or a presigned sign-in
  link. Any other operation whose name speaks of a credential, token, key pair,
  password or private key asks, and says it may hand one back.
- **Every answer is checked.** An answer to a signed request (other than an S3
  object, which is the person's own file) that holds a credential (an AWS secret access key or session token; an
  access, refresh, identity or authorization token; a password, a client secret,
  a `Secret` field or a private key) is kept from the computer, which is told why; the connection's record notes it, and for a
  change that was made, its receipt does too.
- A signed request to a server that runs on AWS rather than one of AWS's APIs
  (an EC2 instance's public name, a load balancer) is refused: the account is
  not used there.

Each card names the operation, the bucket and key or the region, and the
request; a delete or overwrite says so, and `RunInstances`,
`CreateDBInstance`, `CreateCluster`, `PurchaseReserved…` and similar
operations say they may cost money. The approval is bound to the request as it
will be sent, as above; the signing date, the SDK's request id and retry count
(`amz-sdk-invocation-id`, `amz-sdk-request`) and trace ids are left out, since
they change on every run of the same command. Where the SDK makes up an
idempotency token for each call (`ClientToken` on `RunInstances` and the like),
the approval binds the body with that one token blanked and its name kept, so
the same command run again after approval is the same change.

If the person answers while a change is held, it completes inside the command.
If not, `aws` prints the reason as AWS's own error:

```
An error occurred (ApprovalRequired) when calling the DeleteObject operation: Waiting for your approval in Melete: s3:DeleteObject on reports/2026.csv. Run the same command again once it is approved.
```

After approval, the same command sends the change once. A receipt keeps the
service, region, bucket and key, AWS's request id and, for S3, the object's
ETag and version. S3 can answer a copy or the completion of an upload with
`200` and an error in the body; that is recorded as possibly landed.

## GitLab

Connect it in Settings, under Connections, as **GitLab for the agent's
computer**, with a personal access token from GitLab.com that has the `api`,
`read_repository` and `write_repository` scopes and an expiry date; a project
access token keeps it to one project. Melete asks GitLab whose token it is
(`GET /api/v4/user`) before keeping it, and the connection shows that account.
It has two grants: reading the projects, and pushing and making changes, which
asks each time.

The computer has `git` and `glab` (1.120.0, pinned by checksum in the image).
Each command gets `GITLAB_TOKEN` set to a placeholder and
`GIT_TERMINAL_PROMPT=0`. git's requests carry the token as `oauth2` basic
credentials, and the API's as a `PRIVATE-TOKEN` header.

| Host | What goes through it |
| --- | --- |
| `gitlab.com` | git over smart HTTP, Git LFS, the REST API under `/api/v4` and the GraphQL API at `/api/graphql`: everything `glab` does |

What reads: cloning and fetching, every `GET` and `HEAD`, rendering Markdown
(`POST /api/v4/markdown`), GraphQL documents with only queries in them, Git
LFS downloads and lock checks, and git's empty probe before a large push.
Everything else is a change and asks:

- **A push** is read and bound the same way as on GitHub: the project (its
  whole path, subgroups included), each ref update, the push options and the
  exact bytes of the command list. Push options matter more here: GitLab reads
  them to open or merge a merge request (`merge_request.create`,
  `merge_request.merge_when_pipeline_succeeds`) or to skip or vary a pipeline
  (`ci.skip`, `ci.variable`), so the card says in plain words what GitLab will
  also do, for example "open a merge request into main, merge it when its
  pipeline passes", and lists each option.
- **A REST call** with any method other than `GET` or `HEAD` is bound to its
  method, path, query and body. Merge requests (open, merge, approve, comment,
  close, reopen), issues, releases, pipelines and jobs (run, retry, cancel),
  CI/CD variables, branches, tags, protected branches, commits and files made
  through the API, labels and deleting a project have their own summaries; any
  other call is summarised by its method, path and size, with the whole body
  under Details. A project the path names by number is shown by its number.
- **A GraphQL document** with a mutation anywhere in it, or one that does not
  parse, is bound to its exact text and variables.

Three kinds of request are refused and never sent with the account:

- one that asks to act as another user (`Sudo`, as a header, or as a
  parameter in the query or any kind of body);
- one that would make a credential the computer then holds: a personal,
  project, group, impersonation or deploy token, a token rotation, a pipeline
  trigger token, a runner, a cluster agent or its tokens, an SSH or deploy key,
  or an OAuth token, through
  REST or GraphQL. Make one on GitLab yourself if the work needs it;
- the usage reports `glab` sends after each command. `glab` carries on without
  them.

Reads return what the account can read, secrets included: reading a project's
CI/CD variables (`glab variable list`, `GET .../variables`) returns their
values to the computer. Give the token only the projects the work needs, or a
role that cannot read variables.

A held push prints its reason beside each ref, as on GitHub, and `glab` prints
the same sentence as the API's error message. A push keeps on its receipt the
status GitLab reported for each ref, and a REST change the address of what it
made.

Every GitLab change asks; no standing rule covers one.

## npm

Connect it in Settings, under Connections, as **npm for the agent's
computer**, with a granular access token: choose only the packages it needs,
read and write, and an expiry date. Melete asks the registry whose token it is
(`GET /-/whoami`) before keeping it, and the connection shows that account. It
has two grants: installing and looking up packages, and publishing and
changing packages, which asks each time.

The computer has Node.js 24 with npm (pinned by checksum in the image). Each
command gets `NPM_TOKEN` set to a placeholder, which the computer's global npm
settings name as the registry's token, and the relay sends the token as a
bearer token.

| Host | What goes through it |
| --- | --- |
| `registry.npmjs.org` | everything `npm` asks the public registry: installs, views, searches, audits, publishes and package settings |

What reads: every `GET` and `HEAD` (installs, `npm view`, `npm search`, tarball
downloads), and the audit lookups `npm install` and `npm audit` send as POSTs.
Everything else is a change and asks:

- **A publish** shows the package, each version it adds, its tags, its access,
  the tarball's name and size, and its integrity. The scripts that run when
  someone installs it are read from the tarball's own `package.json`, which is
  what an install uses; the card says when that file disagrees with what the
  publish declares, and when a `binding.gyp` builds native code on install. A
  tarball that cannot be read is shown with the declared scripts, marked as
  unchecked. The approval is bound to the exact bytes of the request, so a
  different tarball is a new approval.
- **An unpublish** of the whole package or of one version, a **deprecation**,
  a **maintainer** change, and any other change to a package's record show each
  field the change sets as it will be afterwards (the versions kept, the
  deprecation messages, the maintainers, the tags). One that removes versions,
  maintainers or tags is marked as such.
- **A dist-tag** change shows the tag and the version it will name; **access**,
  **team** and **organisation** changes say what they grant or take away.

Logging in (`npm login`, `npm adduser`, the end of a web login), making a
token and a trusted-publishing token exchange are refused: each would put a
credential in the computer. Make a token on npmjs.com yourself if the work
needs one.

A held change fails the npm command with the reason in npm's own error line:

```
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/melete-demo - Waiting for your approval in Melete: Publish melete-demo@1.0.0 to npm (tag latest). Run the same command again once it is approved.
```

After approval, the same command sends the change once. Every npm change asks;
no standing rule covers one.

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
- AWS: the commercial partition only (hosts under `amazonaws.com`, roles in
  `arn:aws:`). A presigned URL made in the computer is signed with the
  placeholder, so it works only through the relay and is refused there; share
  objects another way. Chunk-signed uploads and S3 directory buckets (S3
  Express One Zone) are refused. Some answers carry short-lived links of their
  own (Lambda's `GetFunction` returns a link to the function's code); they
  reach the computer as AWS sends them, each opening one object for minutes.
- AWS: other reads return whatever the account may read, including values kept
  in a resource's settings, such as a Lambda function's environment variables,
  unless the answer holds one of the credentials above. Give the key, or the
  role, only the permissions the work needs.
- AWS: with an account connected, `connected_hosts_only` lets the computer reach
  every name under `amazonaws.com`, including resources other people own (their
  buckets, their APIs on API Gateway). A request signed there carries the
  account's key id and a short-lived session token, never its secret, and a
  change there asks like any other.
- GitLab is GitLab.com. A self-managed GitLab server is reached as any other
  host, without the account.
- npm is the public registry, `registry.npmjs.org`. Another registry is reached
  as any other host, without the account.
- npm asks for a one-time password on publish when the account requires one
  for writes, and a command in the computer cannot answer it: use a granular
  token that publishes without one.
