# Choosing a personal agent

Researched **October 22, 2026**, using the projects' own documentation and repositories. Products in this category change quickly; follow the linked sources for current access and features.

The important choice is where your agent lives, how it uses your context, and which kind of work its interface helps you manage. Browsing, memory, and background execution are widely shared capabilities now.

## The approaches

| Project | Its centre of gravity | Why choose Melete alongside or instead |
| --- | --- | --- |
| [OpenAI Dots](https://learn.chatgpt.com/docs/dots) | An always-on GPT-powered agent inside ChatGPT, with a cloud computer, plugins, and personalisation. Desktop can also connect your computer. | Run your own installation, choose among model providers, inspect/export/import personal memory, and manage inbox-derived obligations in the Companies view. |
| [Grok Bot](https://docs.x.ai/grok-bot/overview) | Named AI teammates that coordinate, keep context, and work on an account's shared cloud computer. | Use a personal workspace organised around your context, commitments, company records, and action history, with self-hosting and a choice of models. |
| [Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) | An ongoing assistant using existing Claude memory, skills, and connectors, with proactive and background cloud work. | Own the stack and model choice; work with inspectable personal memory, an inbox-derived company map, and a browser you can watch and take over. |
| [OpenClaw](https://github.com/openclaw/openclaw) | An extensible self-hosted assistant gateway across messaging channels and devices, with swappable models and harnesses. | Start from an integrated personal web workspace with Companies, Work, Memory, approvals, and apps as visible surfaces for everyday follow-through. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | A model-flexible agent runtime with memory, learning, skills, scheduled work, and terminal/messaging interfaces. | Get that runtime foundation inside a personal product with accounts, an app UI, company chases, persistent goals, and reviewable work. Melete builds on Hermes. |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | A team-of-bots desktop/chat experience using local agent CLIs, computer access, connected apps, and portable team packages. | Choose a self-hosted personal service with its own model connections and a workflow focused on obligations, provenance, and outcomes. |
| [Rowboat](https://github.com/rowboatlabs/rowboat) | A personal coworker built around a knowledge graph and work surfaces such as email, docs, a browser, and project workspaces. | Put inbox obligations, persistent goals, result-checked runs, and your choice of model at the centre of a self-hosted personal workspace. |
| [nanobot](https://github.com/HKUDS/nanobot) | A lightweight Python personal-agent framework with a WebUI, messaging, memory, tools, and automation. | Use Melete's opinionated product surfaces and built-in company-follow-up workflow rather than assembling the personal workflow around a framework. |

These are differences in emphasis and deployment, not a claim that another agent cannot perform a similar task. A capable general agent may chase a refund too. Melete makes the obligation, source, follow-up, and outcome part of the product.

## What is gaining adoption

The public GitHub repository snapshot below shows substantial adoption across several different approaches. **Stars are a point-in-time interest signal, not active users, a growth rate, or evidence of product quality.**

| Open-source project | Stars, rounded on October 22 | What its current product presentation makes easy to understand |
| --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | 392.8k | Where the assistant runs, how to install it, and the channels where you'll use it |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 256.2k | Learning and continuity, followed by concrete tools and a direct install path |
| [nanobot](https://github.com/HKUDS/nanobot) | 49.3k | Lightweight self-hosting, a “start here” table, and separate paths for different experience levels |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | 5.4k | A visible bot team, feature demonstrations, and packaging that helps people begin with a useful setup |

Counts were checked against each repository's GitHub API metadata. [OpenClaw releases](https://github.com/openclaw/openclaw/releases), [Hermes releases](https://github.com/NousResearch/hermes-agent/releases), and [OpenMausBot releases](https://github.com/milind-soni/OpenMausBot/releases) also show active product development. This is an adoption snapshot rather than a ranking of which project is growing fastest.

## What the category is building toward

**A useful first day.** Duet starts with existing Claude context. OpenMausBot's recent releases describe bringing skills and tools from other AI apps into setup. A new assistant has to earn its place quickly. Melete's current route is a [reviewed context file](BRING-YOUR-CONTEXT.md), followed by a real first task. A richer import bridge and starter packs are [proposed next steps](ROADMAP.md). [Duet setup](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet) · [OpenMausBot releases](https://github.com/milind-soni/OpenMausBot/releases).

**Visible places to work.** Rowboat leads with a demonstration and shows its work surfaces. OpenMausBot presents features beside captures. Our interpretation: readers should see where work, context, and decisions go before reading an architecture reference. Melete's [README](../README.md) shows the computer, follow-through, Work, Memory, Connections, and Companies. [Rowboat](https://github.com/rowboatlabs/rowboat) · [OpenMausBot](https://github.com/milind-soni/OpenMausBot).

**Continuity over a single clever response.** Dots, Grok Bot, Duet, Hermes, and the other projects all emphasise ongoing work or accumulated context. Melete should make its own combination concrete: evidence-backed company records, durable goals, result-checked runs, portable memory, and control of the deployment. This is our positioning choice, not a claim of exclusive invention. [Dots](https://learn.chatgpt.com/docs/dots) · [Grok Bot](https://docs.x.ai/grok-bot/overview) · [Hermes](https://github.com/NousResearch/hermes-agent).

## Where Melete is most useful

Choose Melete when you want **personal context and unfinished work in a system you can own**, especially when the work crosses mail, calendars, websites, and files. The source-linked company map and chase workflow make refunds, recurring charges, renewals, and promises a concrete starting point.

You can also keep your existing assistant. [Melete's MCP server](MCP-SERVER.md) lets it recall saved context, inspect owed items, start a chase, propose an email, and check status. Melete can be the persistent personal resource behind more than one assistant.

Start with [one playbook](PLAYBOOKS.md). If your ideal workflow needs something beyond the current product, check the [proposed roadmap](ROADMAP.md) and describe the missing outcome in an issue.
