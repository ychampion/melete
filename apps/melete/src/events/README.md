# Persisted stream and SSE

Events are written before they are streamed. `GET /jobs/:id/events?after=` and
the global `GET /events?after=` both replay from the `event` table, and
`Last-Event-ID` resumes exactly where a dropped connection stopped.

`dedup_key` is unique, so duplicate delivery of the same runtime event writes one
row. Text deltas are best-effort and a gap in them is shown as an ellipsis,
never as missing history.

Not implemented yet.
