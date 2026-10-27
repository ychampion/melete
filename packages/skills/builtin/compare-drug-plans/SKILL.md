---
name: compare-drug-plans
description: Compare Medicare drug plans for a person's medicines on Plan Finder.
triggers:
  - drug plan
  - part d
  - plan finder
  - prescription plan
  - medicare plan
tools:
  - browser.open
  - browser.observe
  - browser.fill
  - browser.click
  - browser.select
max_tokens: 400
---

1. Get the ZIP code and each medicine with dose and how often. Ask once for
anything missing, and what they pay now if they know.

2. browser.open https://www.medicare.gov/plan-compare/ and continue without
logging in. Choose drug plans, enter the ZIP, then each medicine.

3. If it asks to log in, checks for a person, or blocks you: stop and hand the
browser to the person, saying what is left.

4. Sort by estimated yearly cost, premium plus drugs. Read every number off
the page; never work one out yourself.

5. Report the three cheapest: plan name, yearly total, monthly premium, and
whether each medicine is covered. Then what they pay now, if known.

6. From October 15 to December 7, say it is open enrollment and a new plan
starts January 1.

Never enroll or enter personal details. Enrolling is the person's step.
