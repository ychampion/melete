# Memory integration hooks

Status: **resolved 2026-09-12**. The hooks this note said were missing are
wired: the memory router is mounted, context invalidation is durable, the
broker asks memory where a payload value came from, and the knowledge
proposal operations are served and described. Scope still comes from
server-side authentication and never from a caller-supplied header, which is
the part of this note that was a requirement rather than a gap.
Date: 2026-09-11

## Problem

Starting SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534` has README stubs for
authentication, gateway, broker admission, and the attempt worker. The frozen
`EventType` does not include `dependencies_invalidated` or `context_invalidated`.
The W4 knowledge API-gap note and `PENDING_CONTRACT` list are absent.

## Proposed integration

W7 exposes a server-authenticated memory router, a gateway chat client, context
assembly for the unchanged `AttemptBundle.knowledge` shape, and durable memory
invalidation events defined additively in `memory.ts`. W1 must invoke the context
assembly on every attempt and stop/discard an attempt whose context is invalidated
before any further inference or broker admission. The memory adapter fences the
job epoch and advances its revision while preserving admitted action receipts.
W2 must retain its job-revision and epoch checks at admission. No broker code or
frozen event type is changed here; wiring the missing worker/gateway/broker is a
stopped slice until those implementations are available.

The three additive knowledge operations follow the existing `ProposalStore`
surface: list pending proposals, apply one, and discard one. Reconcile their
route names with W4 when its proposed note is available.

The core's call reservation is a bounded test policy, not actual provider billing.
The gateway integration must reserve/enforce real token and cost limits before
accepting a call. Scope provisioning and the router resolver must come from
verified authentication/membership, never a caller-supplied space header. The
default bootstrap remains health-only until those dependencies are wired.

## Evidence

`rg --files apps/melete/src .agents/notes` and `rg -n PENDING_CONTRACT .` on the
starting SHA show the missing implementations and note. Integration tests in W7
exercise the adapters using authenticated fixtures and a scripted HTTP gateway.
