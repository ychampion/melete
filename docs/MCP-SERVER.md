# Melete as an MCP server

Other assistants can use Melete as a connector: ChatGPT, Claude, Claude Code,
Hermes, OpenClaw, or any client that speaks the Model Context Protocol. The
assistant signs in as one person, with that person's consent, and gets six
tools that act as that person:

| Tool | What it does |
| --- | --- |
| `waiting_on` | Lists what companies owe the person: refunds, credits, deposits and promises Melete found in their mailbox, each with the `item_id` to pass to `handle`. |
| `handle` | Asks Melete to chase one owed item. Melete starts the chase and returns its `job_id`. Asking again for the same item returns the same chase. |
| `safe_send` | Proposes an email from the person's connected mailbox. It returns "Awaiting your approval in Melete." The person reads the exact text in Melete and approves it there; only then does Melete send it. |
| `remember` | Saves a detail the person states, under a topic and a name. |
| `recall` | Looks up the details the person saved. |
| `status` | Reports a job's state and each of its actions, with receipts for what was sent. |

Every tool calls the same route the person would call signed in to Melete, so
an assistant can do what that person can do in their own space, and only that.
Every message it asks for goes through Melete's broker and waits for the
person's approval of its exact words, whatever standing permissions the person
has saved for their own chats.

## What the installation needs

Set `MELETE_PUBLIC_URL` to the address people open Melete at, for example
`https://melete.example.net`. The MCP endpoint is then:

```text
https://melete.example.net/api/mcp
```

Melete is the OAuth authorization server for its own accounts. An assistant
finds everything from the endpoint itself: its first request is answered with a
401 that names the protected resource metadata, which names Melete as the
authorization server. The documents are published at the root of the public
address:

- `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728)
- `/.well-known/oauth-authorization-server` (RFC 8414)

The web server forwards both to the API unchanged. Assistants register
themselves with dynamic client registration (RFC 7591), or identify
themselves with a client ID metadata document at an `https://` address. Every
client is a public client and uses PKCE with S256; tokens are bound to the
`/api/mcp` resource (RFC 8707).

Hosted assistants such as ChatGPT and Claude on the web connect from their own
servers, so for them the address must be reachable from the internet over
HTTPS. Assistants that run on the person's own computer, such as Claude Code
and Hermes, need only reach it from that computer, so an address on a private
network or a tailnet works for them.

## Connecting an assistant

In every case the assistant opens a Melete page in the browser. Sign in to
Melete in that browser if you have not already, read what the assistant is
asking for, and choose **Allow**. The assistant then holds a token for your
account and the space you were using.

### ChatGPT

1. In ChatGPT, open **Settings**, then **Apps & Connectors**. Connectors you
   add yourself are under the advanced settings, in developer mode.
2. Create a connector. Name it Melete and give the MCP server URL,
   `https://melete.example.net/api/mcp`. Choose OAuth for authentication.
3. ChatGPT sends you to Melete. Choose **Allow**.

### Claude

1. In Claude, open **Settings**, then **Connectors**, and add a custom
   connector.
2. Give it the URL `https://melete.example.net/api/mcp` and connect.
3. Claude sends you to Melete. Choose **Allow**.

### Claude Code

```bash
claude mcp add --transport http melete https://melete.example.net/api/mcp
```

Then run `/mcp` in Claude Code, choose melete, and authenticate. Claude Code
opens Melete in your browser; choose **Allow**.

### Hermes

Add the server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  melete:
    url: https://melete.example.net/api/mcp
    auth: oauth
```

Run `/reload-mcp`. Hermes opens Melete in your browser and listens for the
answer on this computer; choose **Allow**.

### Any other MCP client

Point it at `https://melete.example.net/api/mcp` with OAuth enabled. A client
that follows the MCP authorization specification needs nothing else. The
endpoint speaks streamable HTTP and answers each JSON-RPC message with one JSON
response; it accepts protocol versions `2025-11-25`, `2025-06-18` and
`2025-03-26`.

## Approving what an assistant sends

When an assistant calls `safe_send`, the message appears in Melete among the
things waiting for your permission, with its recipients and its full text.
**Allow once** sends exactly those words, once, through the mailbox you
connected. **Deny** ends it. The assistant can follow the result with
`status`.

Standing rules you save in Melete ("always allow this for this recipient")
cover the messages Melete writes in your own chats. A message an assistant
asks for always waits for you, and its card offers **Allow once** and **Deny**.

## Seeing and ending access

`GET /api/mcp/clients` lists the assistants you connected and since when.
`DELETE /api/mcp/clients/{clientId}` ends every token that assistant holds for
you. Tokens also end on their own: an access token lasts an hour, and a refresh
token lasts 30 days and is replaced each time it is used. A refresh token used a
second time ends the whole connection. Removing or emptying a space ends every
assistant's access to it, along with everyone's sessions there.

## Protocol reference

| Endpoint | Purpose |
| --- | --- |
| `POST /api/mcp` | The MCP endpoint, with `Authorization: Bearer <access token>` |
| `GET /api/oauth/authorize` | The consent page, with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and optionally `state`, `scope=melete` and `resource` |
| `POST /api/oauth/token` | `authorization_code` with `code_verifier`, or `refresh_token`, form encoded |
| `POST /api/oauth/register` | Dynamic client registration for a public client |
| `POST /api/oauth/revoke` | Revokes a token and the rest of its connection |

A redirect address is HTTPS, or HTTP back to this computer (`127.0.0.1`,
`localhost` or `[::1]`) for desktop clients. The authorization response carries
`iss` (RFC 9207). The full contract is in
[openapi.json](../packages/contracts/openapi.json) under the `assistants` tag,
and [conformance scenario 11](../conformance/scenarios/11-mcp-server.test.ts)
runs the whole flow with the reference MCP client library.
