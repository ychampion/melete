# W16a additive experience contract

`packages/contracts/src/experience.ts` adds outcome-only schemas and HTTP operations for conversations, turns, trail steps, cards, receipts, drafts, permissions, bounded rules, quick answers, agents, memory items, plans, tasks, automations, profile, home, sign-in, browser sessions and lexical search. It includes typed unavailable capabilities for surfaces without an implementation. Existing record contracts keep their meanings.

`packages/contracts/src/experience-openapi.ts` registers the additive paths. `bun run openapi` and `bun run client:generate` regenerate the checked-in document and client types. Experience requests use session scope and reject extra fields. Experience output schemas enumerate every field and contain no arbitrary object payloads.
- `runtime.ts`: optional attempt-bundle `identity` supplies a bounded agent persona without changing the fallback identity.
- `responsibility.ts`: optional `questionSpec.options` carries zero to four unique opaque choices through deferred and owner questions. Existing text answers retain their meaning.
- `experience.ts`: optional draft Cc/Bcc recipients and permission-card `draft` carry the complete reviewed message; result-card previews may be shortened.
- `effects.ts`: optional intent-key `turn_id` separates new conversation turns and routine occurrences while preserving existing identities when omitted.
