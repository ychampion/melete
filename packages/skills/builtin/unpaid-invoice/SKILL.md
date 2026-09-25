---
name: unpaid-invoice
description: Ask a client for an invoice that is past due, without losing the client.
triggers:
  - unpaid-invoice
  - invoice is unpaid
  - has not paid
  - invoice is overdue
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when the person has billed someone and the money has not come in. A
good outcome is payment, or a date they commit to.

Three sentences, first person, warm and short: the invoice number, amount and
date from the person's own records, that it is now past due, and a request for
a payment date. Quote the client's own words from the evidence when they
promised one. No legal claim, no late-fee threat, no interest they never
agreed to.

Ask once per company before the first message. Never send the same message
twice. Follow up only with `chase.follow_up`.

Wait on the reply trigger, deadline seven days out. Nothing by then, send one
follow-up; two at most. Then ask whether to write to their accounts address.

Stop when it is paid, when a date is given, when the person says stop, or when
the client disputes the work — that is theirs to answer.

Record each receipt, and any date given.
