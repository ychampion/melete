# Skills for coding agents

`melete-setup` lets a coding agent install and set up Melete for you. It points
at [SETUP-WITH-AN-AGENT.md](../SETUP-WITH-AN-AGENT.md), so it always follows the
current steps. You type your own passwords and keys; the agent does the rest.

## Claude Code

Install the skill once:

```bash
mkdir -p ~/.claude/skills/melete-setup && curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/skills/melete-setup/SKILL.md -o ~/.claude/skills/melete-setup/SKILL.md
```

Then ask: "Set up Melete on this machine."

## Codex

Codex reads `AGENTS.md`. Add this to the `AGENTS.md` in the folder you run it
from, or to `~/.codex/AGENTS.md` for every folder:

```markdown
## Melete
To install or set up Melete, read
https://raw.githubusercontent.com/ychampion/melete/main/SETUP-WITH-AN-AGENT.md
and follow it from the top. Never ask me for a password or key in the chat.
```

## Cursor and other agents

No install is needed. Paste this:

```text
Set up Melete on this machine using https://github.com/ychampion/melete/blob/main/SETUP-WITH-AN-AGENT.md
```
