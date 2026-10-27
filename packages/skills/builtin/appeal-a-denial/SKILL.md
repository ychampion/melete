---
name: appeal-a-denial
description: Appeal a denied insurance claim with the form, deadline and letter.
triggers:
  - denied
  - denial
  - appeal
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

3. Fetch and cite that type's appeal rules: for Medicare,
medicare.gov/providers-services/claims-appeals-complaints/appeals; otherwise
the plan's notice and healthcare.gov/appeal-insurance-company-decision. Give
the level, the form, where to send it and the deadline.

4. To gather: the notice, the doctor's letter of medical necessity,
and records.

5. Draft the letter and a short checklist with files.write.

6. Someone acting for another person needs their signed permission; for
Medicare, the Appointment of Representative form, CMS-1696, from cms.gov.

7. Last, remind them a week before the deadline: job.wait, kind "timer".

Send, sign or file nothing without the person's yes.
