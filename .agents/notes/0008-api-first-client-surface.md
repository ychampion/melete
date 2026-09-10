# 0008 - The product is an API; the UI is a client

Status: accepted
Date: 2026-09-11

## Problem

Two things pulled in opposite directions: the interface is being built
separately, and the release has to be usable by someone who found it on GitHub.
Building the backend around one particular screen layout would serve neither.

## Decision

The service is API-first. Every capability a web client has, a script has too,
described by an OpenAPI 3.1 document generated from the same Zod schemas the
service validates with, so the document cannot drift from the implementation.

The UI is a client. Approval screens are rendered from `action` records, never
from model text, and Markdown a model produced is rendered sanitised in a
sandboxed frame with a null origin. That rule is easier to keep when the record
is the interface and the screen is downstream of it.

Multi-user is out of scope for v0.1. The schema carries `space.audience` so
shared spaces can arrive later without rewriting every record.

## Alternatives

- **Ship an existing prototype as the product UI.** Freezes a prototype's shape
  into the API and makes the second client harder to write.
- **Server-rendered pages.** Fewer moving parts, and the API becomes the
  afterthought rather than the contract.

## Evidence

`bun run openapi` regenerates the document and a test fails if the committed
`openapi.json` differs by a byte. It covers 22 paths across health, spaces, jobs,
attempts, events, actions, approvals, connections, knowledge, and skills. The
event endpoints take an `after` cursor, which is the same value SSE sends back as
`Last-Event-ID`, so replay needs no separate bookkeeping.
