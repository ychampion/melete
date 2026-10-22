# What Melete could do next

These are **product proposals**, with no promised dates. [The playbooks](PLAYBOOKS.md) use today's capabilities; this page describes the experiences we want to explore next.

The direction is a personal agent that helps you keep developing the things you care about: learning, creative projects, travel, a career move, or a longer personal goal.

## 1. Personal Spaces

**The experience:** open a part of your life and find the current brief, decisions, useful material, and next step together. The agent helps keep it current as you work.

**Already works:** memory, conversations, plans, goals, files, run records, apps, and routines exist as separate product surfaces.

**Build next:** personal Spaces with explicit associations to those records, reviewed brief updates, and scoped project context. Start with one person and a few projects. Keep personal organisation separate from the existing tenant and collaboration model.

**Ready when:** someone can leave a project, return, understand its state, and continue with the right context. An unrelated private Space stays out of retrieval.

[Read the experience, sketch, implementation prompt, and first slice →](SPACES.md)

## 2. A useful return brief

**The experience:** “I have 30 minutes. Bring me back into this project.” See what changed since the last visit, why it matters, what needs a decision, and one useful next step.

**Already works:** Work records, saved files, plans, and chat history provide material for a manually requested recap.

**Build next:** a Space return view based on changes to attached records, with a last-visited marker and links behind each claim. Distinguish completed work, open questions, and suggestions. Bring in external changes only from configured sources.

**Ready when:** a person can verify the recap, correct it, and act without reading several chats. A lack of activity produces a quiet, accurate return view.

```text
Build a return brief for one personal Space. Use attached records and a
last-visited marker. Link changes to their sources, separate recorded
progress from suggestions, and offer one next step. Verify a quiet week,
a completed run, a blocked task, and a missing source.
```

## 3. Decisions with their reasons

**The experience:** remember why you chose an approach, and see what should be reconsidered when your constraints change.

**Already works:** an agent can write a decision log into a file, and long runs record decisions. [Try the research playbook](PLAYBOOKS.md#turn-research-into-a-decision-you-can-revisit).

**Build next:** reviewed Space decisions with alternatives, reasons, assumptions, and links to affected plans or artifacts. A new constraint should produce a proposed change with a visible diff. Automatic detection from an external source needs a configured watch or routine.

**Ready when:** “I now have two hours a week” produces a useful revision, preserves the earlier rationale, and changes nothing the person declined.

```text
Add reviewed decisions to a Space. Record the choice, reasons, assumptions,
sources, and related artifacts. Implement one explicit constraint-change
flow that proposes a revised plan. Preserve history and verify accept,
decline, and stale-source cases before automatic update suggestions.
```

## 4. Capture that helps organise

**The experience:** drop in a note, link, or file. Melete suggests where it belongs and which existing question or plan it could update.

**Already works:** conversations and files can hold material supplied by the person; agents can read available sources and save outputs.

**Build next:** an intake flow with suggested Space placement, duplicate detection, and a preview of the proposed use. Let people leave something unfiled or change its destination.

**Ready when:** a useful capture reduces later organising, while an ambiguous or sensitive note stays available for review. Source text cannot change permissions or become an instruction by being captured.

```text
Build reviewed capture into one personal Space. Start with a note, a link,
and a file. Propose placement and a useful follow-on update, with accept,
change, and leave-unfiled controls. Test duplicate material and context
that must stay private to a different Space.
```

## 5. A reviewed context bridge

**The experience:** bring useful context from an assistant you already know, review it, and start Melete with a profile that feels like yours.

**Already works:** reviewed Markdown/Melete JSON memory import, memory export, and MCP remember/recall. [Use it today](BRING-YOUR-CONTEXT.md).

**Build next:** readers for documented assistant exports, conflict review, source attribution, and an import receipt. Propose personal preferences separately from project-specific context.

**Ready when:** the person can preview every change, preserve existing corrections, and undo an import. Credentials and embedded source instructions never become permissions.

```text
Build a reviewed context bridge for one documented assistant export.
Reuse Melete's portable-memory implementation. Add parse/preview, source
attribution, conflict review, and an import receipt. Propose Space context
separately from personal preferences. Verify corrections and undo.
```

## 6. Portable personal setups and continuation

**The experience:** start with a useful learning or creative-project setup, personalise it, and keep enough context to continue elsewhere when you choose.

**Already works:** the Agent library supplies briefs, connection suggestions, preference questions, previews, and optional starter routines. Memory is portable. Work's Download record already exports plans, findings, decisions, attempts, and shift handoffs as Markdown.

**Build next:** a versioned format for sharing reviewed starter setups, and a curated continuation brief that resolves project artifacts and sources in another installation. These can ship as separate slices.

**Ready when:** a starter setup carries no private history, credentials, or permissions, and schedules arrive paused. Importing a continuation brief previews the new context and cannot replay completed actions.

```text
Make one Agent library learning setup portable with a reviewed package
format. Reuse the existing setup preview and leave schedules paused.
Separately scope a project continuation brief on top of Work's existing
record export. Resolve sources and preview destination import before
starting work; never clone credentials or replay completed actions.
```

## Help shape the experience

[Try a playbook](PLAYBOOKS.md), then [open an issue](https://github.com/ychampion/melete/issues) with the project you wanted to continue, what you needed to see, and where the current flow fell short. For implementation, follow [Contributing](../CONTRIBUTING.md) and scope one complete slice first.
