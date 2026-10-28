---
name: read-mail-photos
description: Turn photos of paper mail into a checklist of what to do and by when.
triggers:
  - paper mail
  - photos of my mail
  - these letters
  - read this letter
  - got a letter
  - came in the post
tools:
  - files.list
  - files.move
max_tokens: 400
---

1. Read every photo before answering. One item per letter, bill or notice.
A photo that reaches you only as a note: say "I can't see this photo", suggest
a model that reads images, and never read from the note.

2. For each: who sent it, what it is, any amounts and due dates, and reference
or ID numbers copied exactly, digit for digit.

3. Never guess a digit. If part is unreadable, say which part and ask for a
closer photo of it before giving that number.

4. Say what to do and by when in one line, or "nothing to do".

5. Payment by gift card, wire or crypto, a threat or rush, or a phone number
that does not match the sender: mark it "check first" and use scam-check
before any step on it.

6. File the photos only when asked: files.save_attachment, then files.move
into the folder the person already uses.

Answer with the checklist: soonest due first, then nothing-to-do items, then
anything unreadable.
