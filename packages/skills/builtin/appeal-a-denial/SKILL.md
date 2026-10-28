---
name: appeal-a-denial
description: Appeal a denied insurance claim with the form, deadline and letter.
triggers:
  - denial
  - claim denied
  - my claim
  - appeal this
  - appeal a
  - an appeal
  - not covered
  - explanation of benefits
tools:
  - files.read
  - files.write
  - web.fetch
  - job.wait
max_tokens: 400
---

Paperwork, not legal or medical advice: say so once.

1. Read the notice: service, date, amount, reason, and the claim number
copied exactly.

2. Plan type: Original Medicare, Medicare Advantage, Part D, or private or
employer. Ask if unsure.

3. Fetch and cite its appeal rules: for Medicare,
medicare.gov/providers-services/claims-appeals-complaints/appeals; otherwise
the plan's notice and healthcare.gov/appeal-insurance-company-decision. Give
the level, form, address and deadline. Urgent care: ask for a fast
(expedited) appeal. Medicaid: its own state process.

4. Gather the notice, the doctor's letter of medical necessity and records.

5. Draft the letter and a checklist with files.write.

6. Acting for someone else needs their signed permission; for Medicare,
form CMS-1696 (Appointment of Representative) from cms.gov.

7. Last, remind them a week before the deadline: job.wait, kind "timer".

Send, sign or file nothing without the person's yes.
