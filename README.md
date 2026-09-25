# Melete

A personal assistant that follows through: it writes the email, waits, follows up, and tells you when it's done.

![Melete chasing a £64 refund: the draft, the one approval, then the replies and follow-up until it's settled.](docs/assets/readme/demo.gif)

Hand it a loose end, like a refund you were promised or a reply you're still
waiting for. Melete writes from your own address, and you see each message
before it goes out.

## See it work

1. **Connect your inbox.** Gmail and iCloud take an app password, and most other
   mailboxes connect over IMAP.

   ![The Gmail connection form in Settings, asking for an email address and an app password](docs/assets/readme/walkthrough/01-connect.png)

2. **See what's open.** Melete reads your mail and lists what each company owes
   you and what is overdue.

   ![The Companies screen listing money owed, overdue invoices and a deposit five days late](docs/assets/readme/walkthrough/02-whats-open.png)

3. **Hand it one.** Ask it to chase the refund, and it drafts an email that
   quotes the date the company gave you.

   ![A chat asking Melete to chase Tern & Co for a £64 refund, with the drafted email and a Review and send button](docs/assets/readme/walkthrough/03-hand-it-one.png)

4. **Approve the exact email.** You see who it's from, who it's to and every
   word, and nothing goes until you allow it.

   ![The approval card showing From, To and the full email, with Deny and Allow once](docs/assets/readme/walkthrough/04-approve.png)

5. **It follows up until it's settled.** When the money doesn't arrive, it
   writes again with the reference, and tells you when the refund is back.

   ![The finished case: their reply, the follow-up, their confirmation, and Settled with £64 back on the card](docs/assets/readme/walkthrough/05-settled.png)

## Run it yourself

Needs Docker and Bun.

```bash
git clone https://github.com/ychampion/melete.git && cd melete
bun install --frozen-lockfile && bun run deploy/scripts/configure.ts --fake
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

Then open http://localhost:3101 and create your account. It starts with a
practice model that plays one job from start to finish, so you can try Melete
before you connect your own.

[Deployment](docs/DEPLOYMENT.md) has the version requirements, Windows, remote
hosts, HTTPS, Tailscale, backups and how to remove Melete.

## Set it up with your coding agent

Paste one of these into Claude Code, Codex or Cursor.

To run it:

```text
Clone https://github.com/ychampion/melete and run it on this machine with
Docker, following its README. First check that Docker Engine is 28 or newer and
Docker Compose is 2.33.1 or newer. docs/DEPLOYMENT.md has the requirements, and
a Windows section if this machine runs Windows. Then run the three commands
under "Run it yourself". When `docker compose -f deploy/docker-compose.yml ps`
shows the services running and healthy, tell me the address to open.
```

To connect Gmail:

```text
Help me connect my Gmail to Melete, which is running at http://localhost:3101.
Walk me through turning on 2-Step Verification for my Google account and
creating an app password named Melete at https://myaccount.google.com/apppasswords.
Then tell me to open Settings, then Connections, choose Gmail, and enter my
address and the 16-character app password there. Don't ask me to paste the
password into this chat.
```

To use your own model:

```text
Switch my Melete install to my own model. My API key is in my environment as
ANTHROPIC_API_KEY. In deploy/.env, set MELETE_DEFAULT_PROVIDER=anthropic, set
MELETE_DEFAULT_MODEL to the model I name, copy the key into ANTHROPIC_API_KEY
without printing it, and set MELETE_ENABLE_FAKE_PROVIDER=false and
MELETE_ENABLE_TEST_CONNECTOR=false. Then run
`docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime`
and check `docker compose -f deploy/docker-compose.yml logs --tail=50 melete`
for a warning about the provider key. If my key is for another provider, use
the matching name and key from the Providers section of docs/DEPLOYMENT.md.
```

## Connect your model

Melete works with the model you choose. Set these in `deploy/.env`:

| `MELETE_DEFAULT_PROVIDER` | What it needs |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `chatgpt` | Your ChatGPT sign-in, using your plan |
| `google` | `GOOGLE_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` and a key, which can be a model server on your own network |

Set `MELETE_DEFAULT_MODEL` to the model's name as the provider writes it and
`MELETE_ENABLE_FAKE_PROVIDER` to `false`, then restart the two services that
use them:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

[Providers](docs/DEPLOYMENT.md#providers) explains each one, including signing
in with ChatGPT.

## Plugins

Plugins give Melete new tools. You can add any MCP server in
**Settings → Connections**, over HTTP or from a package or image, and a packaged
server runs in its own locked-down container. There is also a starter set of
files, fetch, time and GitHub, listed at `GET /plugins`, and each one installs
with a single request.

Melete can also run code in a cloud sandbox. Connect an [E2B](https://e2b.dev)
or [Modal](https://modal.com) account as a **Sandbox** connection and your jobs
can use it.

## More it does for you

**Your day.** Home opens with a short morning brief and the decisions waiting on
you, next to your calendar.

**Memory.** Tell it once how you like things done and it does them that way next
time. You can see everything it remembers, and change or forget any of it.

## How it keeps you in control

- **Approvals.** Each message waits for your OK. For someone you trust, you can allow a set number of messages instead.
- **Receipts.** Everything it sends or creates is recorded with when and where it went.
- **Undo.** An action that can be reversed shows an Undo button for as long as it still works.
- **Forgetting.** Something you ask it to forget stays forgotten, even after you restore a backup.

## Documentation

- [Deployment](docs/DEPLOYMENT.md): hosting, providers, Tailscale, backups and removal
- [Upgrading](docs/UPGRADING.md): moving an installation to a later release
- [Connectors](docs/CONNECTORS.md) and [mail and calendars](docs/mail-calendar.md)
- [Browser worker](docs/browser-worker.md): the browser Melete drives, and taking over from it
- [Memory](docs/MEMORY.md) and [learning](docs/LEARNING.md)
- [Architecture](docs/ARCHITECTURE.md) and [threat model](docs/THREAT-MODEL.md)
- [Building a client](docs/CLIENT.md): the API and how the app uses it
- [Contributing](CONTRIBUTING.md): setting up, testing and sending changes

## Licence and credits

Melete is Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). To report a
security issue, follow the [security policy](SECURITY.md).

Melete's agent runtime is built on
[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research,
customised for Melete.
