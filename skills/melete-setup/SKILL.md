---
name: melete-setup
description: Install and set up Melete, the open-source self-hosted assistant, on this computer or a server with Docker. Use when the person asks to install, set up, start, check, update or extend a Melete installation (model, computer, voice, mail and calendar, public address, MCP server).
---

# Set up Melete

The steps live in one guide, kept current with the code:

- In a Melete checkout: `SETUP-WITH-AN-AGENT.md` at the repository root.
- Otherwise: https://raw.githubusercontent.com/ychampion/melete/main/SETUP-WITH-AN-AGENT.md

Read the whole guide before running anything, then follow it from the top.
Every step in it is safe to run again.

The rules that matter most:

- The person types every password and key, into Melete's Settings or their own
  terminal. Never ask for one in the chat, and never print `deploy/.env`.
- Ask before installing Docker, creating a server, or deleting anything.
- `bun run deploy/scripts/status.ts` reports where the installation stands and
  what to do next.
