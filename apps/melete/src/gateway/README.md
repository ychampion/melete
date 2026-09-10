# Key-injecting model proxy

The runtime container's only route out. It allow-lists provider hosts,
replaces surrogate keys in `Authorization` and `x-api-key` with the real ones,
and records provider, model requested, model actually served, usage read from
response bodies, and latency for every attempt.

It also enforces per-attempt request and token caps, and a fallback only when
the job's `model.fallback` allows one. OAuth-based providers pass through with
tokens held in the runtime's own auth store in v0.1, which `docs/THREAT-MODEL.md`
states plainly.

Owned by workstream W2.
