# What Melete could do next

These are **feature proposals for discussion and future implementation**, not features available in the current release. They build on existing capabilities and the [personal-agent research](PERSONAL-AGENTS.md). There are no promised dates or delivery order.

## 1. A reviewed context bridge

**The experience:** “Bring what my current assistant knows about me.” Select a source, see a proposed personal profile, resolve contradictions, and start Melete with useful context.

**Already works:** reviewed Markdown/Melete JSON memory import, memory export, and `remember`/`recall` through MCP. [Use it today](BRING-YOUR-CONTEXT.md).

**Build next:** guided readers for supported assistant exports, previewed changes, source attribution, duplicate/conflict review, and an easy way to undo a particular import. Keep preferences, instructions, active tasks, and access requests distinct.

**Ready when:** a person can review what will be imported before any memory changes, preserve existing corrections, and see where each imported detail came from. Credentials and embedded instructions from source material never become permissions.

```text
Build a reviewed context bridge for Melete. Start with one documented export
format, a local parse/preview step, conflict review, and an import receipt.
Use the existing portable-memory implementation as the boundary. Define
acceptance checks before adding more sources.
```

## 2. Shareable personal-agent packs

**The experience:** choose “freelancer admin”, “household coordinator”, or “travel planning”, personalise a few details, and begin with an agent that has a useful setup.

**Already works:** the Agent library provides ready-made briefs, suggested connections, preference questions, setup previews, and starter routines you choose to enable. Agents also have standing instructions and scoped access. [Try a first task](START-HERE.md).

**Build next:** a versioned, shareable file format for those setups, plus reviewed package import and export. Let someone publish a useful personal workflow as a pack another person can inspect and personalise. Reuse the library's existing setup flow for the imported content.

**Ready when:** a pack can be shared without carrying someone's conversations, credentials, personal memory, or permissions. Importing it shows every proposed change and leaves schedules paused until the owner enables them.

```text
Make Agent library setups portable with a versioned pack format and
reviewed import/export. Reuse existing previews and setup controls. Ship
one shareable freelancer-admin pack. Keep secrets, personal memory, and
authority out of exported packages.
```

## 3. One view of promises in both directions

**The experience:** see both “what I'm waiting for” and “what I owe someone”, with the original promise, due date, latest change, next step, and relevant work together.

**Already works:** the Companies map, company chases, persistent intents and deadlines, reply follow-ups, mail/calendar watches, and Work.

**Build next:** a unified commitment view across company promises, the person's own commitments, and explicit follow-up requests. Review inferred commitments, reconcile replies, connect existing jobs, and avoid duplicate chasing across surfaces.

**Ready when:** each commitment has a source, owner, status, and next step; a changed promise updates the right record; the same obligation cannot launch several independent chases by accident. A proposed commitment remains distinguishable from one the person accepted.

```text
Prototype a unified commitments view in Melete. Reuse Companies, intents,
and follow-up records. Start with explicit commitments and source links,
then add reviewed extraction. Define how duplicates, changed deadlines,
and existing jobs reconcile before enabling automatic follow-through.
```

## 4. Teach a workflow by doing it together

**The experience:** take over a browser step, show Melete the right way, and turn the correction into a reusable workflow you can inspect, try, and roll back.

**Already works:** browser takeover, standing instructions, routines, and a narrow evaluated-learning path for organising typed table records. [Current learning scope](LEARNING.md).

**Build next:** evaluated browser procedures for a small set of repeatable tasks, with required accounts, checkpoints, expiry, and recovery when the page changes. Let a person review a proposed procedure and trial it before reuse.

**Ready when:** a recorded demonstration becomes a procedure only after task-specific checks; reused procedures cannot expand access; a changed interface stops or recovers visibly. General browser workflow learning is outside today's evaluated scope.

```text
Extend Melete's evaluated-learning pipeline to one bounded browser task.
Define the task contract, captured demonstration, evaluator, and review UI.
Test changed pages and expired sessions. Keep procedure knowledge separate
from memory facts, account credentials, and permissions.
```

## 5. A portable continuation brief

**The experience:** change an assistant, model, or installation without reconstructing an unfinished project from chat history. Bring the goal, decisions, evidence, outstanding questions, and next step together.

**Already works:** portable memory, account export, and long-run **Work → Download record**. The [run record](RUNS.md#the-record) already exports plans, findings, decisions, attempts, and shift handoffs as Markdown. Memory portability and record export alone don't move a running job.

**Build next:** a curated continuation brief derived from the existing record, artifact/source resolution across installations, and reviewed destination import. Keep a clear boundary between “context for continuing” and “an action already carried out”. A destination should preview its interpretation before starting new work.

**Ready when:** importing a brief cannot replay an email, payment, or booking; the person can see which sources are still available; missing evidence and stale facts are explicit. Live credentials and action permissions stay with the original installation.

```text
Build on Melete's existing Markdown run export to create a curated
continuation brief with artifact/source resolution and reviewed import on
another installation. Do not clone execution state or replay completed
actions. Verify with a project resumed elsewhere.
```

## Help choose what ships

Use the current [playbooks](PLAYBOOKS.md), then [open an issue](https://github.com/ychampion/melete/issues) with the situation, the desired result, and where the current flow falls short. Link a proposal above if it fits. For implementation, follow [Contributing](../CONTRIBUTING.md) and scope one complete, reviewable slice first.
