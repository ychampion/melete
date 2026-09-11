# W16a additive experience contract

`packages/contracts/src/experience.ts` adds outcome-only schemas and HTTP operations for conversations, turns, trail steps, cards, receipts, drafts, permissions, bounded rules, quick answers, agents, memory items, plans, tasks, automations, profile, home, sign-in, browser sessions and lexical search. It includes typed unavailable capabilities for surfaces without an implementation. Existing record contracts keep their meanings.

`packages/contracts/src/experience-openapi.ts` registers the additive paths. `bun run openapi` and `bun run client:generate` regenerate the checked-in document and client types. Experience requests use session scope and reject extra fields. Experience output schemas enumerate every field and contain no arbitrary object payloads.
