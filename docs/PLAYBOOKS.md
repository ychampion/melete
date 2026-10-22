# Put Melete to work

These playbooks turn Melete's memory, connections, computer, and background work into a useful result. Replace the examples with your own details. Set up the listed connections first; a prompt alone doesn't connect an account.

New here? [Install Melete](START-HERE.md) and [bring a few preferences](BRING-YOUR-CONTEXT.md) before you begin.

## Recover a refund or credit

**Use when:** a company promised a refund, credit, deposit return, or other follow-up and you are still waiting.

**Needs:** the relevant mailbox connected. Enable its Watch switch to notice incoming changes.

Open **Companies → Scan the inbox** and wait for results if you haven't scanned this mailbox yet. Find the owed item, check the source email, amount, and timing, then choose **Handle it**. Review the first message Melete proposes. Approving a company chase also covers its bounded follow-ups to that recipient within your saved rules; review those rules before starting unattended chasing.

For a more specific brief:

```text
Find the refund [company] promised for [order or issue]. Check the original
promise and all later replies before deciding it is overdue. Show me the
amount, the promised date, and the source messages.

Draft a concise follow-up for my review. Track the reply in this job and
tell me if the company gives a new date or asks for information. Done means
the refund is confirmed in the connected evidence, or you clearly explain
what remains unresolved and what I need to do next.
```

**Check the result:** the amount and promise match the source; the first message went to the right recipient; the outcome distinguishes a new promise from evidence that it was fulfilled. Mail evidence doesn't independently verify a bank balance.

[Company map](../apps/melete/src/companies/README.md) · [Sending and chase behavior](MCP-SERVER.md#approving-what-an-assistant-sends)

## Get ahead of renewals

**Use when:** recurring charges and renewal notices are spread across your inbox.

**Needs:** the mailbox containing those notices, and a Companies scan with useful records.

For a fresh setup, open **Companies → Scan the inbox** first and wait for results.

```text
Review the recurring charges and upcoming renewals in Companies. Build a
table of company, amount and currency, billing period, next relevant date,
and the email supporting each fact. Separate known amounts from anything
missing. Flag the decisions I should make in the next 30 days.

Recommend what I should review first based on my current priorities.
Don't cancel or change an account during this review. Done means a sourced
list and a practical next step for each upcoming decision.
```

**Check the result:** currencies and billing periods remain explicit; a monthly charge hasn't become an annual total by guesswork; each decision has a source and a date where known. The map reflects connected evidence, so add missing records rather than treating it as a complete financial inventory.

**Make it repeat:** ask for a weekly review once the first report is useful. Use a separate, explicit request for an account change.

## Keep a personal commitment from slipping

**Use when:** a booking, meeting, or reply needs several steps before a deadline.

**Needs:** the relevant calendar/mail connection and browser access for the sites involved. Save useful food, travel, scheduling, or location preferences first.

```text
Plan dinner for six on [exact date] near [area], within [budget and
currency]. Use my saved food preferences, and check current menus and
availability. Compare three options with travel time and total cost where
available. Tell me which you recommend and why.

I need the plan settled by [deadline and timezone]. Keep track of the next
step and tell me early if the deadline is at risk. Check with me before
booking or paying. Done means I have approved an option and you have shown
the booking confirmation, or explained the obstacle and next action.
```

**Check the result:** Home shows the right date, budget, people, and next step. Correct any inferred detail before approval. When a site needs a login or human step, take over the browser and hand it back afterward.

An agent's separate computer needs its own logins. Pairing your own browser is an option when you want it to work in an existing session. [Devices](DEVICES.md) · [Persistent goals and deadlines](INTENTS.md).

## Turn research into a decision

**Use when:** comparing quotes, venues, products, or options needs more than a quick answer.

**Needs:** the input files or source links, a working model, and any tools needed to read them.

```text
Compare [options] for [decision]. My requirements are [constraints], with
[must-haves] and [trade-offs I can accept]. Work through this as a long run.
Keep your findings and sources, and record approaches that don't work.

Done means:
1. A comparison against every requirement, with dated source links.
2. A recommendation explaining the trade-offs and remaining uncertainties.
3. A saved Markdown report I can use without rereading this conversation.

Check the final result against those criteria. If a fact can't be verified,
say which decision it affects instead of filling in a plausible value.
```

**Check the result:** open the report and its sources; confirm every requirement was addressed. In **Work**, inspect the long run's progress and any decision waiting on you. A long run uses durable shifts and an independent completion check; a gap in the result should remain a gap, rather than disappearing into a confident summary. [How long runs work](RUNS.md).

## Start the day with the right things

**Use when:** you want a brief that reflects your day, your preferences, and your active work.

**Needs:** connected mail/calendar, the timezone you actually use, and an awake Melete host for the scheduled time.

```text
Create a weekday routine for 8:30 am in [timezone]. Give me a brief from my
connected inbox and calendar: today's commitments, replies that need me,
and deadlines or active work that could slip. Use my current priorities
from memory. Put the three most useful decisions first and link the sources.

Keep it under 250 words unless something needs a fuller explanation.
Don't send messages or change events as part of this routine.
```

**Check the result:** inspect the schedule and timezone, then review the first brief. Correct one noisy category or missing priority. Add actions to the routine only when you want those actions and have chosen the relevant sending preferences.

Mail/calendar watches wake work on changes; the routine provides a scheduled review. They serve different purposes. [Watching for changes](SITUATIONAL-AWARENESS.md).

## Build a dashboard that stays useful

**Use when:** a repeated report deserves its own small interface.

**Needs:** source records Melete can read, a working model, and the app tools. Begin with a small JSON or CSV dataset you can inspect.

```text
Build a private renewal dashboard from [these records]. Show the upcoming
dates, amounts and currencies, source links, and items needing a decision.
Use a readable table with filters and a simple monthly view.

Publish it as an app only I can open in Melete. Create a weekly routine
that refreshes its data file, and bind the app's data to that routine's
output so new runs update the dashboard. Show when the data was refreshed.
Keep unknown amounts and dates visibly unknown.
```

**Check the result:** open the app, compare it with the input records, and verify that the data source is bound to the routine. After the routine writes another version, check that the app shows the new data. Apps can be private or shared with selected accounts on your installation; viewers sign in to Melete. [Apps, live files, and version history](APPS.md).

## Write your own playbook

```text
Outcome: [what I want to be true]
Context: [the relevant memory, account, files, and sources]
Constraints: [budget, dates, preferences, and exclusions]
Review with me: [decisions or actions I want to approve]
Done means: [observable result and evidence]
If blocked: [what to try next and when to bring it back to me]
```

For repeat work, run the first instance, inspect its result, and refine the brief before turning it into a routine. Keep personal facts in Memory, durable working style in an agent's instruction, and actual access and sending preferences in Settings.
