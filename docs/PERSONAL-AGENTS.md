# Choosing a personal agent

Researched **October 22–23, 2026**, using the projects' own documentation and repositories. Follow the linked sources for current access and features.

Browsing, memory, useful files, and background execution are shared capabilities across this category. Melete's positioning needs to explain the personal experience those tools create.

## The approaches

| Project | Its centre of gravity | Melete's emphasis |
| --- | --- | --- |
| [OpenAI Dots](https://learn.chatgpt.com/docs/dots) | An ongoing GPT-powered agent inside ChatGPT, with a cloud computer, plugins, personalisation, and tasks. | Your own installation, choice of providers, inspectable portable memory, plans, run records, and private apps. |
| [Grok Bot](https://docs.x.ai/grok-bot/overview) | Named AI teammates that coordinate, keep context, and use an account's shared cloud computer. | A personal workspace for one person's ongoing goals, with a computer, reviewable work, and control of the stack. |
| [Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) | A persistent main thread and topic channels sharing Claude memory, proactive briefs, background cloud work, and finished files. | Personal context that stays with your installation across model changes, alongside visible work, files, and tools you can extend. |
| [OpenClaw](https://github.com/openclaw/openclaw) | An extensible self-hosted assistant gateway across messaging channels and devices, with swappable models and harnesses. | An integrated personal web workspace with Work, Memory, plans, approvals, and apps. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | A model-flexible runtime with memory, learning, skills, scheduled work, and terminal/messaging interfaces. | That runtime foundation inside a personal product with accounts, a web UI, connected sources, goals, and reviewable work. Melete builds on Hermes. |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | A team-of-bots desktop/chat experience using local agent CLIs, computer access, connected apps, and portable team packages. | A self-hosted personal service with its own model connections and persistent records of your work. |
| [Rowboat](https://github.com/rowboatlabs/rowboat) | A knowledge graph and work surfaces including docs, email, a browser, code, apps, and project workspaces. | Personal goals, result-checked long runs, portable memory, and a proposed focus on maintained personal Spaces. |
| [nanobot](https://github.com/HKUDS/nanobot) | A lightweight Python personal-agent framework with a WebUI, messaging, memory, tools, and automation. | A ready personal product with an integrated interface, deployment path, work records, and app surfaces. |

These are differences in emphasis, not exclusive capabilities. A comparison should help someone choose a product without suggesting that other capable agents cannot research, remember, or execute a similar task.

## What is gaining adoption

This public GitHub snapshot illustrates interest in several approaches. Stars measure repository interest at a point in time; they do not measure active use or a growth rate.

| Open-source project | Stars, rounded on October 22 | What its presentation makes clear |
| --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | 392.8k | Deployment, installation, and the channels where the assistant is used |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 256.2k | Learning and continuity, concrete tools, and a direct install path |
| [nanobot](https://github.com/HKUDS/nanobot) | 49.3k | Lightweight self-hosting and separate getting-started paths |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | 5.4k | A visible team, product demonstrations, and useful starter packages |

Counts were checked against each repository's GitHub API metadata on October 22. This is a dated adoption snapshot, not a ranking of which project is growing fastest.

## What the research changes for Melete

**Start with useful personal context.** Duet carries existing Claude memory, skills, and connectors into its first session. Melete should make its own first day concrete: bring a small reviewed profile, connect the sources a real task needs, and make something useful. The [context guide](BRING-YOUR-CONTEXT.md) works today; richer import and portable starter setups are [proposals](ROADMAP.md). [Duet setup](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet).

**Show the work and what it leaves behind.** Rowboat shows work surfaces and apps. OpenMausBot places demonstrations beside feature descriptions. Melete's README should let someone see the computer, Work, Memory, Connections, and Agent library, then try a task that produces a plan, file, or small app. [Rowboat](https://github.com/rowboatlabs/rowboat) · [OpenMausBot](https://github.com/milind-soni/OpenMausBot).

**Make continuity a designed experience.** Ongoing context and background work are already central to Dots, Duet, Grok Bot, and Hermes. Melete's opportunity is to make a person's longer projects easier to continue: what is current, why a decision was made, what changed, and where to begin. This is our interpretation of a useful direction, not evidence of an unserved market. [Dots](https://learn.chatgpt.com/docs/dots) · [Grok Bot](https://docs.x.ai/grok-bot/overview) · [Hermes](https://github.com/NousResearch/hermes-agent).

## Why Spaces need more than organisation

Duet already offers topic channels that share memory. Rowboat already describes workspaces for different projects. A new folder or a renamed conversation is too thin a reason to switch. [Duet channels](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) · [Rowboat workspaces](https://github.com/rowboatlabs/rowboat).

The proposed Melete experience combines a personal place to work with an agent that helps maintain it:

- **Capture into progress:** a new note can propose a change to an existing plan or answer an open question.
- **Revisit a decision:** preserve the choice and its reasons, then show the effect of a changed constraint.
- **Return with context:** see relevant changes, current work, and a next step tied to the actual project.
- **Keep the relationship portable:** retain personal memory across model changes and move reviewed context when you choose.

The first three are [Spaces proposals](SPACES.md), not shipped features. Reviewed memory import/export and model choice work today. The product has to earn the proposed differentiation through the experience, rather than through claims that these ideas exist nowhere else.

## Who to start with

A person learning something over several weeks, developing a creative project, or making a longer life transition has repeated reasons to return. The useful unit is a project that develops over time, with personal context and artifacts worth keeping.

Melete's current foundations support [learning plans, project briefs, trip planning, research, and private tools](PLAYBOOKS.md). Personal Spaces would connect those foundations into a more coherent experience.

You can also keep your existing assistant. [Melete's MCP server](MCP-SERVER.md) lets it recall saved context, save reviewed preferences, propose an email, and check work status.

[Try one playbook](PLAYBOOKS.md) · [Explore personal Spaces](SPACES.md) · [Choose a build slice](ROADMAP.md)
