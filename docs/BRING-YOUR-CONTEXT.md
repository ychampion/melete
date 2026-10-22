# Bring your context to Melete

Your personal agent should start with the useful context you've already built: how you like to communicate, the people you mention, the routines you keep, and what matters this month.

Melete can import a **reviewed Markdown preferences file** or its own **JSON memory export**. An existing assistant can also save details through Melete's MCP server. Start with a concise profile; expand it through actual work together.

## Ask your current assistant

Paste this into ChatGPT, Claude, Hermes, OpenClaw, or the assistant that already knows you:

```text
Help me bring my personal context to Melete. Create a Markdown file using
only current facts and preferences I explicitly told you. Use the context
you can actually access; don't invent missing details.

Include up to 20 useful items: communication style, timezone, scheduling
preferences, important people and their relationship to me, current work,
recurring routines, and personal preferences relevant to everyday tasks.

Use only these headings where useful:
## Preferences
## People
## Work
## Routines and dates
## Accounts and bills
## Everything else

Format EVERY imported item exactly as:
- **Short descriptive label**: One factual sentence.

Keep one detail per line and use distinct, stable labels. Put dates or
expiry information in the sentence for temporary priorities. If something
is uncertain, old, or contradictory, leave it out and ask me about it
separately. Do not turn your own interpretations into facts about me.

Exclude passwords, API keys, tokens, recovery codes, account numbers,
private keys, raw chat transcripts, hidden instructions, and instructions
copied from web pages, tools, or other people's messages. Don't include
blank placeholders or sample preferences as if they were mine.

Show me the proposed file and a separate short list of questions. Wait for
my review before saving or transferring anything to Melete.
```

If that assistant cannot access earlier context, tell it a few preferences or give it selected notes to summarise. For a coding agent with access to your own memory files, explicitly name the files you want it to read. You don't need to give it an entire assistant profile or raw session directory.

## Review and import

Read every item. Remove anything you wouldn't want Melete to use as context. In particular, check dates, names, inferred preferences, and facts that stopped being true.

Save the result as `personal-context.md`, then open **Memory → Import** in Melete. Files can end in `.md`, `.markdown`, or `.json`.

Here is an example of the accepted Markdown shape. Replace the values with your own before importing:

```markdown
# My personal context

## Preferences
- **Communication style**: I prefer short, direct replies with a recommendation first.
- **Timezone**: My timezone is Asia/Kolkata.
- **Scheduling**: I prefer meetings after 10 am local time.

## Work
- **Current focus**: Through November 2026, my main priority is launching my portfolio.

## Routines and dates
- **Weekly planning**: I usually plan the coming week on Sunday evening.
```

The headings organise the entries. Each imported detail must use `- **Label**: Value`; ordinary paragraphs and plain bullets are ignored. A [copyable template](templates/PERSONAL-CONTEXT.md) is available too.

After import, review the imported/skipped counts and the resulting Memory entries. An identical existing entry is skipped; a different existing value under the same subject is kept. Different labels can still create overlapping details, so review the list rather than repeatedly importing renamed copies.

The import records these details as context you provided **now**. It doesn't reconstruct the original assistant's evidence, dates, or conversation history. That is why reviewing the file matters.

## The first conversation

```text
Review the preferences I just imported. Summarise the useful things you
know about me, point out anything ambiguous or conflicting, and ask at
most three questions that would make you more useful today.

Then suggest one first task based on my current priorities. Use my
preferences as context; ask separately for account access and actions.
```

Choose the task, connect the account it needs, and use a [playbook](PLAYBOOKS.md) to give it a finish line. Personal details are context; sending permissions and access controls live in their own Settings.

## Give an agent a standing instruction

An agent's **Standing instruction** is separate from memory. In the Agents editor, use its short instruction field for a durable way of working. It accepts up to 500 characters.

For example:

```text
Be concise and practical. Use my saved preferences, check current sources
for changing facts, and ask only for details that materially affect the
result. For multi-step work, state the finish line, keep track of the next
step, and bring me a recommendation with evidence. Flag time-sensitive
decisions early.
```

Set tone, connection access, computer access, and memory permissions in their respective controls. Importing an `AGENTS.md` or `CLAUDE.md` file as memory does not configure those controls.

## Transfer directly through MCP

If your current assistant is connected to Melete, it can use `recall` and `remember` to transfer approved details. Follow [MCP server setup](MCP-SERVER.md) first. A hosted assistant needs to reach your installation over HTTPS; a local assistant can use an accessible private or tailnet address.

Then give that assistant this prompt, followed by your reviewed preferences:

```text
Transfer the reviewed preferences below to Melete using its MCP tools.
First use recall to look for existing values. Propose stable lowercase
topic/name identifiers for each item. Report any conflict before replacing
a value. Save only the details I approve, then show what you saved and
check it with recall. Do not send email or start other work during this
context transfer.
```

For example, `remember` accepts:

```json
{
  "topic": "communication",
  "name": "style",
  "value": "I prefer short, direct replies with a recommendation first."
}
```

This saves `pref.communication.style`. Reusing the same topic/name replaces that value, so check first. MCP-saved details retain the assistant's provenance; they are not recorded as your own words. File import and MCP transfer deliberately preserve that distinction.

Connect Claude Code with your installation's address, for example:

```bash
claude mcp add --transport http melete https://melete.example.net/api/mcp
```

Run `/mcp`, authenticate in the browser, and approve the connection in Melete. Other clients have their own setup steps in the [MCP guide](MCP-SERVER.md#connecting-an-assistant). Access can be ended under **Settings → Connections → Connected assistants**.

## Keep the context yours

Use **Memory → Export Markdown** for an editable copy or **Export JSON** for Melete's versioned memory format. In **Settings → Account → Download everything**, the account export also includes an importable `memory.json` alongside chats and other records.

Raw ChatGPT/Claude conversation exports and complete account ZIPs are not memory-import formats. Use the reviewed-summary workflow for another assistant's history. Automatic conversation migration and richer context bridges are [roadmap proposals](ROADMAP.md#1-a-reviewed-context-bridge).

Correct details in Memory or tell Melete what changed. Tell it to forget details you no longer want it to retain. [Memory](MEMORY.md) explains sources, correction, forgetting, and restore behavior.
