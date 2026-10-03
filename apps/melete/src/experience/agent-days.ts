import type { AgentTemplate } from '@melete/contracts';

/**
 * An example exchange for each library agent, shown on its sheet before it is
 * added: what the person asks, the agent's first message, the work it does,
 * the one question it asks and what it says at the end. Each illustrates how
 * the agent works in a chat; none is a record of a run.
 */
export const AGENT_DAYS: Record<string, AgentTemplate['day']> = {
  'morning-brief': {
    ask: 'What does today look like?',
    opening: 'Morning. I’ll check your calendar and what came in overnight.',
    work: [
      { reach: 'calendar', title: 'Read today’s calendar' },
      { reach: 'mail', title: 'Read 14 new emails in your inbox' },
    ],
    question: {
      text: 'The dentist moved your 3:00 to 3:30. Keep it in the brief?',
      options: ['Yes, keep it in', 'Leave it out'],
    },
    answer:
      'Three things today. The dentist is now at 3:30. Sam needs a yes on the venue by noon. Your train tickets for Friday arrived, and nothing else needs you before lunch.',
  },
  'weekly-review': {
    ask: 'Can we do the weekly review?',
    opening: 'Sure. I’ll look back at your week first, then we can plan the next one.',
    work: [
      { reach: 'calendar', title: 'Read this week’s calendar' },
      { reach: 'mail', title: 'Searched your inbox for open threads' },
      { reach: 'files', title: 'Read `weekly-notes.md`' },
    ],
    question: {
      text: 'Two threads are still waiting on you. Put them at the top of next week?',
      options: ['Yes, top of the list', 'Leave them off'],
    },
    answer:
      'A full week: four meetings, the launch notes sent, and the gym three times. Next week has room on Tuesday morning, so the two replies and the budget draft go there.',
  },
  'home-admin': {
    ask: 'The dishwasher stopped draining. Is it still under warranty?',
    opening: 'Let me find the receipt and the warranty terms.',
    work: [
      { reach: 'mail', title: 'Searched your inbox for the dishwasher receipt' },
      { reach: 'files', title: 'Read `home-list.md`' },
    ],
    question: {
      text: 'It is covered until March. Shall I draft a repair request to the store?',
      options: ['Yes, draft it', 'Not yet'],
    },
    answer:
      'Bought on March 12 last year for $649, with two years of cover, so you are covered. The draft to the store is ready for you to read, with the order number and what went wrong.',
  },
  'family-calendar': {
    ask: 'Who is driving to soccer on Saturday?',
    opening: 'I’ll check the family calendar and the latest club email.',
    work: [
      { reach: 'calendar', title: 'Read Saturday on the family calendar' },
      { reach: 'mail', title: 'Read the club’s email about the new kickoff time' },
    ],
    question: {
      text: 'Kickoff moved to 10:00. Update the calendar event?',
      options: ['Yes, update it', 'Leave it'],
    },
    answer:
      'Alex is driving, leaving at 9:20 now that kickoff is at 10:00. Maya has a birthday party at 2:00, and nobody is down to take her yet.',
  },
  'gift-planner': {
    ask: 'Mom’s birthday is coming up. Any ideas?',
    opening: 'It’s on the 24th, so there is time. Let me look for a few ideas.',
    work: [
      { reach: 'memory', title: 'Used what you told me about your mom' },
      { reach: 'web', title: 'Searched the web for pottery classes nearby' },
      { reach: 'web', title: 'Read a page of garden gift ideas' },
    ],
    question: {
      text: 'Keep it under $80, like last year?',
      options: ['Yes, under $80', 'I can spend more'],
    },
    answer:
      'Three ideas under $80: a two-hour pottery class for two, heirloom tomato seeds with a good trowel, or the gardening book she mentioned in May. Each one has its link.',
  },
  'bill-tracker': {
    ask: 'What bills are due this week?',
    opening: 'I’ll check your list and anything new in your inbox.',
    work: [
      { reach: 'files', title: 'Read `bills.md`' },
      { reach: 'mail', title: 'Searched your inbox for new bills' },
    ],
    question: {
      text: 'The internet bill went up from $65 to $79. Add a note to check it?',
      options: ['Yes, add a note', 'That’s expected'],
    },
    answer:
      'Two this week: electricity, $112 on Thursday, and internet, $79 on Friday, up $14 from last month. Both are on autopay. Car insurance renews on the 30th.',
  },
  'refund-chaser': {
    ask: 'The store still hasn’t refunded the jacket I sent back.',
    opening: 'Let me find the return and what they promised.',
    work: [
      { reach: 'mail', title: 'Searched your inbox for the return confirmation' },
      { reach: 'browser', title: 'Opened the store’s returns policy' },
    ],
    question: {
      text: 'They promised a refund within 10 days, and it has been 18. Draft a polite reminder?',
      options: ['Yes, draft it', 'Wait a few more days'],
    },
    answer:
      'The return arrived on the 2nd, and their policy says 10 business days. The reminder quotes your order number and the $120 refund. It’s ready for you to read before anything is sent.',
  },
  'inbox-triage': {
    ask: 'Can you go through my inbox?',
    opening: 'On it. I’ll sort what needs you from what can wait.',
    work: [
      { reach: 'mail', title: 'Read 38 new emails in your inbox' },
      { reach: 'memory', title: 'Used what you told me about who matters' },
    ],
    question: {
      text: 'Priya asked about Thursday. Shall I draft a reply saying yes?',
      options: ['Yes, draft it', 'I’ll reply myself'],
    },
    answer:
      'Three need you today: Priya about Thursday (draft ready), the contract from Dana, and a school form due Friday. Twelve newsletters and receipts can wait. Nothing was sent or moved.',
  },
  'follow-up-chaser': {
    ask: 'Who still owes me a reply?',
    opening: 'I’ll look through what you sent in the last two weeks.',
    work: [
      { reach: 'mail', title: 'Searched sent messages from the last two weeks' },
      { reach: 'calendar', title: 'Read next week’s calendar' },
    ],
    question: {
      text: 'Marcus hasn’t replied in nine days. Draft a short nudge?',
      options: ['Yes, draft a nudge', 'Give it more time'],
    },
    answer:
      'Three are waiting: Marcus on the proposal (nine days), the landlord about the lease (five days) and the printer quote (four days). The nudge to Marcus is ready for you to read.',
  },
  'meeting-prep': {
    ask: 'Help me prep for tomorrow’s meetings.',
    opening: 'You have two tomorrow. I’ll pull together who, why and what was said last.',
    work: [
      { reach: 'calendar', title: 'Read tomorrow’s calendar' },
      { reach: 'mail', title: 'Searched your inbox for threads with Dana' },
      { reach: 'files', title: 'Read `q3-plan.md`' },
    ],
    question: {
      text: 'Dana asked for the budget numbers last time. Add them to your notes?',
      options: ['Yes, add them', 'Skip that'],
    },
    answer:
      '10:00 with Dana: the Q3 plan. Last time she asked for budget numbers, and they are in your notes now. 2:00 with the design team: the weekly check-in, where the open question is the launch date.',
  },
  'job-search': {
    ask: 'Find me product roles in Seattle.',
    opening: 'I’ll look at public listings and check each against what you want.',
    work: [
      { reach: 'web', title: 'Searched the web for product roles in Seattle' },
      { reach: 'browser', title: 'Opened three job listings' },
      { reach: 'files', title: 'Updated `applications.md`' },
    ],
    question: {
      text: 'One asks for a cover letter. Shall I draft one from your CV?',
      options: ['Yes, draft it', 'Not for this one'],
    },
    answer:
      'Three fit well: a senior PM at a health startup, a platform PM at a logistics company, and a hybrid growth role. They are on your list now. Nothing was applied for.',
  },
  'research-analyst': {
    ask: 'Are heat pumps worth it in a cold climate?',
    opening: 'Good question. I’ll read the studies and say how sure each answer is.',
    work: [
      { reach: 'web', title: 'Searched the web for cold-climate heat pump studies' },
      { reach: 'web', title: 'Read four pages, two from government labs' },
      { reach: 'files', title: 'Wrote `heat-pumps.md`' },
    ],
    question: {
      text: 'Two sources disagree on running costs. Include both?',
      options: ['Yes, show both', 'Just the stronger one'],
    },
    answer:
      'Mostly yes. Modern cold-climate units keep working well below freezing, and two field studies found lower heating bills in most homes. Savings depend on your electricity price, where the two sources disagree. Every claim has its source in the note.',
  },
  'fact-checker': {
    ask: 'Is it true that you lose most of your heat through your head?',
    opening: 'I’ll check what the research actually says.',
    work: [
      { reach: 'web', title: 'Searched the web for the original study' },
      { reach: 'web', title: 'Read two pages from medical journals' },
    ],
    question: {
      text: 'Want the short answer or the full trail of sources?',
      options: ['The short answer', 'The full trail'],
    },
    answer:
      'Mostly false. The head loses heat about in proportion to its surface area, roughly 10%. The idea goes back to a 1950s army study where only the head was left uncovered.',
  },
  'writer-editor': {
    ask: 'Can you tighten this email to the landlord?',
    opening: 'Sure. I’ll keep your voice and make it shorter.',
    work: [
      { reach: 'memory', title: 'Used what you told me about how you write' },
      { reach: 'files', title: 'Read `landlord-draft.md`' },
    ],
    question: {
      text: 'It reads a little sharp in the second line. Soften it?',
      options: ['Yes, soften it', 'Keep it firm'],
    },
    answer:
      'Down from 210 words to 95. It opens with the leak and the date you reported it, asks for a repair date this week, and ends warmly. It’s ready for you to read before you send it.',
  },
  'trip-planner': {
    ask: 'Plan four days in Lisbon in May.',
    opening: 'Lovely. I’ll check your dates, then lay out the days.',
    work: [
      { reach: 'calendar', title: 'Read your calendar for May' },
      { reach: 'web', title: 'Searched the web for flights to Lisbon' },
      { reach: 'browser', title: 'Opened two hotels in Alfama' },
    ],
    question: {
      text: 'May 14 to 18 is free. Plan around those dates?',
      options: ['Yes, those dates', 'Pick other dates'],
    },
    answer:
      'Day one, Alfama and the castle at sunset. Day two, Belém and pastries. Day three, a day trip to Sintra. Day four, a slow morning and the LX Factory. Flights from $640 return. Nothing is booked until you say so.',
  },
  'travel-day': {
    ask: 'What do I need for tomorrow’s flight?',
    opening: 'I’ll gather your booking and timings in one place.',
    work: [
      { reach: 'mail', title: 'Searched your inbox for the booking confirmation' },
      { reach: 'calendar', title: 'Read tomorrow’s calendar' },
    ],
    question: {
      text: 'You like to be there two hours early. Plan to leave at 6:15?',
      options: ['Yes, 6:15', 'A bit later'],
    },
    answer:
      'Your flight leaves at 9:05 from terminal 3, seat 14C. Leave at 6:15. Your bag is included, and hotel check-in is from 3:00, with the confirmation in your inbox.',
  },
  'habit-keeper': {
    ask: 'How did I do this week?',
    opening: 'Let me look at your check-ins.',
    work: [
      { reach: 'memory', title: 'Used what you told me about your habits' },
      { reach: 'calendar', title: 'Read this week’s calendar' },
    ],
    question: {
      text: 'Evenings were busy. Move the reading check-in to the morning?',
      options: ['Yes, try mornings', 'Keep evenings'],
    },
    answer:
      'A good week: water every day, a walk five times, and reading three nights out of seven. Tuesday and Thursday evenings were busy, so mornings may suit reading better.',
  },
  'health-admin': {
    ask: 'When is my next prescription refill due?',
    opening: 'I’ll check your list and your inbox.',
    work: [
      { reach: 'files', title: 'Read `health-list.md`' },
      { reach: 'mail', title: 'Searched your inbox for the pharmacy' },
    ],
    question: {
      text: 'It runs out on the 12th. Add a reminder for the 8th?',
      options: ['Yes, remind me', 'No reminder'],
    },
    answer:
      'Your refill is due on the 12th, and the pharmacy says it can be ready in two days. Your dental cleaning is on the 20th at 9:30.',
  },
  'study-coach': {
    ask: 'Quiz me on Spanish verbs.',
    opening: 'Let’s go. Five quick ones on the past tense, then we’ll look at what tripped you up.',
    work: [
      { reach: 'memory', title: 'Used what you told me about your level' },
      { reach: 'files', title: 'Read `spanish-notes.md`' },
    ],
    question: {
      text: 'How do you say “I went” in Spanish?',
      options: ['Fui', 'Iba'],
    },
    answer:
      'Right, “fui”. “Iba” is “I used to go”. You got four of five, and the one you missed was “hice”. Tomorrow we’ll start there.',
  },
  'reading-list': {
    ask: 'Save this article for later.',
    opening: 'I’ll read it and give you the gist.',
    work: [
      { reach: 'web', title: 'Read the page you sent' },
      { reach: 'files', title: 'Updated `reading-list.md`' },
    ],
    question: {
      text: 'It is long. Want the three-line summary now?',
      options: ['Yes, now', 'Save it for Sunday'],
    },
    answer:
      'About a 20-minute read. The gist: short daily walks did more for sleep than weekend exercise. It’s on your list with nine others, and I’ll pick the best three on Sunday.',
  },
  'code-helper': {
    ask: 'Write a script that renames my photos by date.',
    opening: 'I’ll write it on my own computer and test it before you run it.',
    work: [
      { reach: 'computer', title: 'Wrote `rename_photos.py`' },
      { reach: 'computer', title: 'Ran `python rename_photos.py --dry-run`' },
    ],
    question: {
      text: 'Two photos have no date. Leave them as they are?',
      options: ['Yes, leave them', 'Use the file date'],
    },
    answer:
      'The script works. A dry run on 48 test photos renamed 46 to names like 2026-05-14_093012.jpg and skipped the two with no date. Nothing on your own computer was touched.',
  },
  'repo-tidier': {
    ask: 'What needs tidying in the project?',
    opening: 'I’ll look at open issues, branches and the docs.',
    work: [
      { reach: 'computer', title: 'Ran `git branch --merged`' },
      { reach: 'files', title: 'Read `README.md`' },
    ],
    question: {
      text: 'Seven branches are already merged. List them for you to delete?',
      options: ['Yes, list them', 'Leave them'],
    },
    answer:
      'Seven merged branches, four issues with no reply in a month, and a README that still gives the old install step. Nothing was closed or deleted.',
  },
  bookkeeping: {
    ask: 'Sort last month’s receipts.',
    opening: 'I’ll collect them from your inbox and add each to the sheet.',
    work: [
      { reach: 'mail', title: 'Searched your inbox for receipts from last month' },
      { reach: 'files', title: 'Updated `bookkeeping.csv`' },
    ],
    question: {
      text: 'The $42 coffee shop receipt: meals or office?',
      options: ['Meals', 'Office'],
    },
    answer:
      '23 receipts, $1,846 in all. The biggest are software at $612 and travel at $480. Two invoices have no receipt yet, and they are listed at the bottom of the sheet.',
  },
  'invoice-chaser': {
    ask: 'Which invoices are overdue?',
    opening: 'Let me check your list against what has been paid.',
    work: [
      { reach: 'files', title: 'Read `invoices.md`' },
      { reach: 'mail', title: 'Searched your inbox for payment confirmations' },
    ],
    question: {
      text: 'Invoice 1042 is 12 days late. Draft a friendly reminder?',
      options: ['Yes, draft it', 'Wait a week'],
    },
    answer:
      'One is overdue: invoice 1042, $2,400, due on the 1st. Two more are due this week. The reminder quotes the invoice number, amount and date, and it is ready for you to read.',
  },
  'subscription-watcher': {
    ask: 'What am I subscribed to?',
    opening: 'I’ll go through your receipts and renewal emails.',
    work: [
      { reach: 'mail', title: 'Searched your inbox for receipts and renewals' },
      { reach: 'browser', title: 'Opened the streaming plan’s pricing page' },
    ],
    question: {
      text: 'You have two music plans. Want to see how to cancel one?',
      options: ['Yes, show me', 'Keep both'],
    },
    answer:
      'Nine subscriptions, $134 a month. Two music plans overlap, and the streaming plan goes up $3 next month. Cloud storage renews yearly on the 9th for $99.',
  },
  'price-watcher': {
    ask: 'Tell me when these headphones drop under $250.',
    opening: 'Got it. I’ll check the page now and keep an eye on it.',
    work: [
      { reach: 'web', title: 'Read the product page' },
      { reach: 'memory', title: 'Remembered your target price' },
    ],
    question: {
      text: 'They are $279 today. Check every morning?',
      options: ['Yes, every morning', 'Once a week'],
    },
    answer:
      'They are $279 today and in stock. I’ll check each morning and tell you when they reach $250, with the link. Nothing will be bought.',
  },
};
