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
| `remember` | Saves a detail under a topic and a name. Melete records it as saved by that assistant, not as the person's own words, so a message that uses it shows a warning on its approval card. |
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

The page names the space the assistant will act in and the site you will
return to. An assistant that registered itself is shown by the name it gave,
marked unverified; one identified by a metadata document is shown with the host
that published it.

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

So that an assistant cannot bury you in requests, at most five messages from
assistants wait for you at once, and after you deny one, that assistant must
wait ten minutes before proposing another. Each connection may make 60 tool
calls a minute.

## Seeing and ending access

In Melete, open **Settings**, then **Connections**. Under **Connected
assistants**, each assistant you let in is listed with the date you connected
it, and **Disconnect** ends its access at once. The same list is
`GET /api/mcp/clients`, and `DELETE /api/mcp/clients/{clientId}` ends every
token that assistant holds for you.

Tokens also end on their own: an access token lasts an hour, and a refresh
token lasts 30 days and is replaced each time it is used. However often it is
refreshed, a connection ends 90 days after you allowed it, and the assistant
asks you again. A refresh token used a second time ends the whole connection.

A token works only in the space you connected it from. If you are removed from
that shared space, your assistants' access to it ends, and being invited back
does not revive it. Removing or emptying a space ends every assistant's access
to it, along with everyone's sessions there.

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
`iss` (RFC 9207). An error about an authorization request goes back to the
assistant only at an address Melete trusts: this computer, the host of the
client's metadata document, or an address someone here already allowed. Any
other error is shown on Melete's page instead, so the endpoint cannot be used
to redirect someone elsewhere. The full contract is in
[openapi.json](../packages/contracts/openapi.json) under the `assistants` tag,
and [conformance scenario 11](../conformance/scenarios/11-mcp-server.test.ts)
runs the whole flow with the reference MCP client library.
