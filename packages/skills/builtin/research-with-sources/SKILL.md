---
name: research-with-sources
description: Answer a question from sources you actually read, and say what you could not confirm.
triggers:
  - research
  - find out
  - look up
  - compare options
tools:
  - web.fetch
  - knowledge.search
  - files.read
max_tokens: 400
---

Search the space first. The person may have decided this already, and an old
record may be why the question is being asked again.

Fetch a page before citing it. Never cite from memory of a URL.

For each claim that matters, give the source and the date you read it. A claim
with no source is labelled as your inference, not as a finding.

When sources disagree, show both, then say which you would act on and why. Do
not average them into a false middle.

Say what you could not find. An honest gap is worth more than a confident
paragraph that fills it.

Stop when you can answer the question that was asked. Do not deliver a survey
of the field when one number was wanted.
