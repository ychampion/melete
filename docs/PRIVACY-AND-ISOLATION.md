# Privacy and isolation

This page says where a person's data and accounts live, what can act on the
world for them, and which tests check each statement. The
[threat model](THREAT-MODEL.md) goes attacker by attacker.

## What holds today

**Actions out pass through one place.** Every action the agent takes through a
connected account (a message, an event, a payment, a publish) is proposed to the
broker. The broker writes the exact content down, and a person's approval
covers that content only: one changed byte is a different action that needs its
own approval (`An approval cannot be spent on different content`). The same
action is carried out once, even across restarts
(`the database itself refuses a second action for one intent key`), and one
whose outcome is unknown is not sent again
(`An unacknowledged send stays unknown and is never re-sent`).

**Melete asks when it matters.** Spending, deleting and anything carrying a
credential ask, with a warning that says why. Sending outside Melete asks
unless the person set a standing rule for that kind of message to that
recipient. Any recipient, address or amount that came from a page or an email,
rather than from the person, asks every time, and no standing rule covers it.
Work inside the person's own space and the agent's own computer goes ahead,
with a receipt (`spending wins over every other reading`;
`an address read off a page is refused as untrusted_recipient_origin`).

**The agent holds no secrets.** The agent runs in a container whose only
connection is to the broker: no internet, no database, no other work's files
(conformance scenario 6, run against a Linux Docker host). The agent's own
computer holds no Melete credentials. When a command-line tool in it uses a
connected account, the secret is added on the way out by a relay in the
service, and every change it makes asks the person
(`a computer uses a connected account through the relay, and its environment, files and output never hold the secret`).

**The service's public side holds no keys to the host or to the secrets.** The
service that answers the web app has no Docker socket. One small service,
`melete-cells`, holds it, with no database address and no service key, and
starts containers for the service only in fixed shapes: an attempt's engine, an
agent's computer and an MCP server, each unprivileged on a read-only root with
its own network and volumes. Any other image, host path, privilege or network
is refused, and so is any request on a container it did not start
(`melete-cells refuses a container outside its profiles`;
`compose-check: the API has no socket`). The service's own database role cannot
read the table of sealed account credentials at all
(`as melete_api, SELECT on secret fails`); only the code that opens a
credential to act through an account reads it, as a second role, and the
service refuses to start if its own role could
(`a service role that can read secrets is refused at start`). An existing
installation gains both by upgrading, with its data and every connected account
in place
(`an upgrade from the current main's deployment, with data, works and keeps secrets readable for effects`).

**Model providers see less.** Before a cloud model reads a request, account
numbers, IDs, contact details and keys are swapped for placeholders, and
private or sensitive conversations go to a model on the person's own machine
or wait for them. A check that fails holds the request
(`a check that fails holds the request and says nothing was sent`). See
[the privacy router](PRIVACY-ROUTER.md).

**Secrets are sealed.** Connected-account secrets, sign-in tokens and the relay's
signing key are stored sealed under the installation's master key, each bound to
its own row and space (`rejects a wrong master key, changed ciphertext and cross-row swaps`).
Backups never contain the master key and can be encrypted to a key the operator
holds.

**People are kept apart.** In an installation with several people, each one's
work, approvals, memory and accounts are reachable only by them
(`isolation holds in both directions once both accounts hold data`). Removing a
space removes everything of it, and restoring an older backup does not bring it
back (conformance scenario 9).

**Self-hosting keeps the key with the person.** On an installation a person runs
themselves, the master key is theirs and lives on their machine.

## Limits

The agent's container and computer on Docker share the host's kernel; for a
virtual machine per computer, connect E2B, Modal or Daytona. The service that
holds the master key decrypts credentials in its own memory when it acts, so
the host it runs on is trusted with them. The privacy router recognises details
by pattern, and a provider keeps whatever it already received. Reads through a
connected account go ahead; what the agent then sends is what asks.
