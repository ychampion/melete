---
name: make-a-podcast
description: Research a subject from sources you read, write a two-voice script, and produce an audio file that cites them.
triggers:
  - podcast
  - audio summary
  - make an episode
  - read this out
  - two voices
tools:
  - web.fetch
  - audio.synthesize
  - files.write
max_tokens: 400
---

Only offer this when `audio.synthesize` is in your tool catalog. Without the
capability there is no episode, and saying you will make one is a promise you
cannot keep.

Research first. Fetch each source and note the date you read it. A claim you
cannot attribute does not go in the script; say on air that you could not
confirm it, or leave it out.

Write for two voices, A and B, alternating. B asks the question a listener would
actually have; A answers from a source and names it out loud. Six to ten
exchanges for a short episode. No cold open, no music cues, no "welcome back".

Say the numbers the way a person would read them aloud. Spell out an amount, a
date and a unit; a listener cannot see a figure.

Synthesise once the script is final. `audio.synthesize` spends money, so it is
approved like any other spend: show the script, say what it will cost, and wait.

Deliver the audio file as the artifact and the script beside it. The artifact's
`uses` manifest carries every source handle the script rests on, so a later
correction to one of them marks this episode stale instead of leaving it to
drift.

Say in one sentence what the episode covers and what it left out.
