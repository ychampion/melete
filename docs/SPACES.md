# Personal Spaces

**Product proposal — not available in the current release.**

A personal agent should help you build a body of work you can return to. Melete's proposed Spaces give each project or part of your life a home, and give your agent a role in keeping that home useful.

**You bring an idea, a question, or a half-finished project. The Space becomes its working context: the current brief, useful material, decisions, progress, and the next thing worth doing.**

## Start with one person's life

| Space | What accumulates | Why you come back |
| --- | --- | --- |
| **Learn Spanish** | Your interests, available time, practice material, session notes, and skills to revisit | Continue from the last session and see what to practise next |
| **Launch my portfolio** | References, drafts, research, decisions, milestones, and a preview of the site | Move the next piece forward without rebuilding the brief |
| **Kyoto in October** | Travel preferences, options, saved places, an itinerary, and open decisions | Develop a trip over time and revise it when your plans change |
| **My next career move** | Your priorities, experience, role research, application material, and questions | Keep a longer transition coherent across several conversations |

Each Space belongs to the same person. A useful first release needs no team setup, shared room, or new persona for every project.

## Three moments that should feel different

### 1. Drop something in; move the project forward

You add a link, a note, or a file. Melete proposes where it belongs and the useful change it suggests: a reference worth keeping, an open question answered, or a revision to the plan. You can accept, change, or dismiss that proposal.

```text
This course looks interesting. Add it to Learn Spanish, compare it with
the plan we chose, and tell me whether it changes your recommendation.
```

The result should be a maintained comparison or plan with the new source linked. Capturing something should leave less organising for later.

### 2. Change a constraint; see what changes with it

You say you now have two hours a week instead of five. Melete identifies the parts of the plan affected, proposes a revision, and preserves the reasoning behind the earlier choice.

```text
I only have two evenings a week now. Show how that changes my portfolio
milestones, keep the original scope visible, and suggest what to defer.
```

The result should show what changed, why, and which decisions still need you. Revisions should remain reviewable and reversible.

### 3. Return after a week; know where to begin

A short return brief shows the current goal, what changed since your last visit, the decision waiting on you, and one useful next step. Changes come from the Space's actual chats, files, and work records. External updates require a connected source and a configured watch or routine.

```text
Bring me back into this project. What moved, what did we decide, and what
is the best use of the next 30 minutes?
```

The result should get you back to doing the work without rereading several conversations.

## The proposed surface

```text
Launch my portfolio
Current goal: publish a focused portfolio by November 20

Where you left off
  The writing-first approach is chosen. Two case studies need a final edit.

Next useful step
  Review the first case study's opening. Estimated effort: 20 minutes.

Brief          Goal, constraints, current plan, open questions
Decisions      What we chose, why, and what would change that choice
Materials      Notes, references, files, and useful app links
Work           Related conversations, runs, milestones, and routines

[Add something]   [Continue with Melete]
```

This is an illustrative product sketch. The proposal does not imply an existing Spaces screen or working automatic filing feature.

## An agent that helps maintain the Space

The agent should propose updates as work happens: attach a relevant artifact, keep the brief current, record a decision with its reasons, and suggest a next step based on the actual state of the work. Show consequential changes for review and retain revision history.

The benefit is continuity: a project remains understandable across chats and time away. Topic channels and project workspaces already exist elsewhere; the [research](PERSONAL-AGENTS.md) makes that overlap explicit. This is a direction for Melete's own experience, rather than a claim that organising work into Spaces is new.

## Personal context, with boundaries

Some context should travel: communication style, timezone, and preferences you choose to use widely. Some belongs to a particular Space: a private career plan, draft writing, or assumptions for one trip.

The design needs visible controls for what is personal, what is Space-specific, and what may be reused elsewhere. A suggested connection between Spaces should explain itself and ask before moving sensitive context. Archiving a project should preserve its useful record while ending its active work only through an explicit control.

Importing a [reviewed personal context file](BRING-YOUR-CONTEXT.md) works today. Project-specific import and automatic context routing belong to this proposal.

## A first version worth shipping

Start with a person creating three Spaces and returning to one project after time away:

1. Create, rename, and archive a personal Space, with a short goal and brief.
2. Attach conversations, files, and work records explicitly. Let a person correct a mistaken association.
3. Let the agent propose a brief or decision update with source links, a visible diff, and accept/decline controls.
4. Generate a return brief from the attached records, including unresolved questions and a suggested next step.
5. Keep Space context separate during retrieval and make any use of broader personal memory visible.

**Done means:** a person can leave a project, return, understand its current state, and continue with the right context. Verify this with a changed constraint, a declined update, an unrelated private Space, and a missing source. A summary should distinguish recorded progress from suggested work.

Automatic capture routing, cross-Space suggestions, richer dashboards, and workflow learning can follow after that core experience is useful.

## Implementation boundary

Melete already has memory, plans, persistent goals, work records, files, apps, and routines. The first slice should connect those existing records around a personal project and add the reviewed brief and return experience.

The existing internal `space` model is an identity and access boundary, with rooms used for collaboration. A personal organisation feature must have an explicit model and retrieval scope within the existing account boundary. Reusing a familiar name must not change tenant isolation or grant access across accounts.

```text
Build a first personal Spaces slice from docs/SPACES.md. Inspect the
existing account/space/room boundaries first. Keep personal organisation
separate from tenant identity. Reuse conversations, files, goals, and run
records through explicit associations. Implement a reviewed current brief
and a sourced return summary before adding automatic filing. Verify
isolation, declined updates, stale sources, and archiving behavior.
```

[Other proposals](ROADMAP.md) · [Use Melete today](PLAYBOOKS.md) · [Discuss the experience](https://github.com/ychampion/melete/issues)
