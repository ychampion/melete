/**
 * How much memory keeps from a realistic half hour of chat, and how it reads.
 *
 * The script follows a person's first thirty minutes: onboarding, a
 * Tokyo trip and its rainy-day follow-up, a landlord email, an explanation, a
 * quick fact, three chats telling it about herself, a correction, a weekly
 * recap skill, a code word, a routine and a reminder. The extraction model is
 * scripted to answer the way the model answered on a hosted install: every
 * clause saved, one-off details marked lasting, the same fact again under a
 * new subject, third-person wording and key-like subjects. Each proposal
 * carries the fact it states and whether that fact is lasting, so the beliefs
 * can be scored.
 *
 * The same answers run through memory twice: once with extraction's quality
 * rules off (`keepNoisyProposals`, which is how memory read them before), and
 * once with them on. The model's answers are the same in both arms, so this
 * measures the service's own rules only; the stricter extraction instructions
 * would change the answers themselves and are not counted here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Belief } from '@melete/contracts';
import { openDatabase } from '../../src/db/client.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { listBeliefs } from '../../src/memory/beliefs.ts';
import { captureChat } from '../../src/memory/capture.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { type ExtractionGateway, proposeExtraction } from '../../src/memory/extract.ts';
import { recall } from '../../src/memory/recall.ts';
import { resetMemorySeams, setMemorySeams } from '../../src/memory/seams.ts';
import { buildViews } from '../../src/memory/views.ts';
import { inPersonsWords } from '../../src/memory/wording.ts';
import { claimWork } from '../../src/memory/work.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
afterAll(async () => {
  resetMemorySeams();
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

/** One thing the person said, and what the scripted model proposed from it. */
type Said = { chat: string; text: string; proposals: Proposed[] };
type Proposed = {
  /** The fact it states; two proposals with one fact are the same detail. */
  fact: string;
  /** Whether the fact is worth keeping past this task: a lasting fact, a preference, a person, a standing instruction. */
  lasting: boolean;
  domain_key: string;
  content: string;
  quote: string;
  kind?: 'preference';
  /** Says again what an earlier message already said: following the instructions, no-op. */
  restates?: true;
  /** Corrects this earlier subject: following the instructions, a supersede of it, worded so. */
  corrects?: string;
  followed?: string;
};

/**
 * How the model answers: as the hosted model did (`as_seen`), or as the new
 * extraction instructions ask (`as_asked`): what is said again is a no-op, a
 * correction supersedes what it corrects, and a detail of the task at hand is
 * marked `this_task_only`. The second is a model doing what it is told, not a
 * measurement of one.
 */
type Answers = 'as_seen' | 'as_asked';

const HALF_HOUR: Said[] = [
  {
    chat: 'onboarding',
    text: "I'm a product designer at Figma and I live in the Mission in San Francisco.",
    proposals: [
      {
        fact: 'job',
        lasting: true,
        domain_key: 'person.me.job',
        content: 'The user is a product designer at Figma',
        quote: "I'm a product designer at Figma",
      },
      {
        fact: 'home',
        lasting: true,
        domain_key: 'person.me.home',
        content: 'The user lives in the Mission in San Francisco',
        quote: 'I live in the Mission in San Francisco',
      },
    ],
  },
  {
    chat: 'onboarding',
    text: 'Email and admin is what eats my week right now. Where do we start?',
    proposals: [],
  },
  {
    chat: 'tokyo',
    text: "Plan a 3-day trip to Tokyo for Nov 12-14. I'm vegetarian and I have about $250/day to spend.",
    proposals: [
      {
        fact: 'vegetarian',
        lasting: true,
        domain_key: 'pref.diet.vegetarian',
        content: 'The user is vegetarian',
        quote: "I'm vegetarian",
        kind: 'preference',
      },
      {
        fact: 'tokyo-budget',
        lasting: false,
        domain_key: 'trip.budget.daily',
        content: 'About $250/day to spend on trips',
        quote: 'I have about $250/day to spend',
      },
      {
        fact: 'tokyo-dates',
        lasting: false,
        domain_key: 'trip.tokyo.dates',
        content: 'Trip to Tokyo on Nov 12-14',
        quote: 'a 3-day trip to Tokyo for Nov 12-14',
      },
    ],
  },
  {
    chat: 'tokyo',
    text: "It's supposed to rain on the 13th, can you rework the plan? Vegetarian places only, please.",
    proposals: [
      {
        fact: 'tokyo-rain',
        lasting: false,
        domain_key: 'trip.tokyo.rainy_day_plan',
        content: 'The user wants an indoor plan for the rainy 13th in Tokyo',
        quote: "It's supposed to rain on the 13th",
      },
      {
        fact: 'vegetarian',
        lasting: true,
        domain_key: 'pref.food.vegetarian',
        restates: true,
        content: 'Vegetarian',
        quote: 'Vegetarian places only',
        kind: 'preference',
      },
    ],
  },
  {
    chat: 'landlord',
    text: 'Write my landlord Mr. Patel an email: the heating has been broken for a week and I need it fixed by Friday.',
    proposals: [
      {
        fact: 'landlord',
        lasting: true,
        domain_key: 'person.landlord.patel',
        content: "The user's landlord is Mr. Patel",
        quote: 'my landlord Mr. Patel',
      },
      {
        fact: 'heating',
        lasting: false,
        domain_key: 'home.heating_issue',
        content: 'Home heating has been broken for a week',
        quote: 'the heating has been broken for a week',
      },
    ],
  },
  { chat: 'roth', text: "Explain a Roth conversion and when it's a bad idea.", proposals: [] },
  {
    chat: 'dst',
    text: 'When does daylight saving time end in the US this year? Give me the source.',
    proposals: [],
  },
  { chat: 'math', text: "What's 15% of 84?", proposals: [] },
  { chat: 'math', text: 'hi', proposals: [] },
  {
    chat: 'about-me-1',
    text: 'Remember that I have a severe shellfish allergy.',
    proposals: [
      {
        fact: 'shellfish',
        lasting: true,
        domain_key: 'pref.diet.shellfish_allergy',
        content: 'The user has a severe shellfish allergy',
        quote: 'I have a severe shellfish allergy',
        kind: 'preference',
      },
    ],
  },
  {
    chat: 'about-me-2',
    text: "My sister Lena lives in Portland and her birthday is March 3. I'm visiting her next month.",
    proposals: [
      {
        fact: 'lena-city',
        lasting: true,
        domain_key: 'person.sister.lena.city',
        content: "Lena, the user's sister, lives in Portland",
        quote: 'My sister Lena lives in Portland',
      },
      {
        fact: 'lena-birthday',
        lasting: true,
        domain_key: 'person.sister.lena.birthday',
        content: "Lena's birthday is March 3",
        quote: 'her birthday is March 3',
      },
      {
        fact: 'oregon-trip',
        lasting: false,
        domain_key: 'trip.oregon.next_month',
        content: 'The user is visiting Oregon next month',
        quote: "I'm visiting her next month",
      },
    ],
  },
  {
    chat: 'about-me-3',
    text: 'Always get me an aisle seat when I fly. My partner Sam hates early flights.',
    proposals: [
      {
        fact: 'seat',
        lasting: true,
        domain_key: 'pref.travel.seat',
        content: 'The user prefers an aisle seat',
        quote: 'Always get me an aisle seat when I fly',
        kind: 'preference',
      },
      {
        fact: 'sam-partner',
        lasting: true,
        domain_key: 'person.partner.sam',
        content: "Sam is the user's partner",
        quote: 'My partner Sam',
      },
      {
        fact: 'sam-flights',
        lasting: true,
        domain_key: 'person.sam.early_flights',
        content: 'Sam hates early flights',
        quote: 'Sam hates early flights',
      },
    ],
  },
  {
    chat: 'seafood',
    text: "What should I avoid at a seafood place, and when is my sister's birthday?",
    proposals: [],
  },
  {
    chat: 'seafood',
    text: 'I have a shellfish allergy, you just told me oysters are the safer bet?! Also Lena moved to Seattle last month.',
    proposals: [
      {
        fact: 'shellfish',
        lasting: true,
        domain_key: 'pref.food.allergy',
        restates: true,
        content: 'The user has a shellfish allergy',
        quote: 'I have a shellfish allergy',
        kind: 'preference',
      },
      {
        fact: 'lena-city',
        lasting: true,
        domain_key: 'person.lena.city',
        corrects: 'person.sister.lena.city',
        followed: 'Sister Lena lives in Seattle',
        content: 'Lena moved to Seattle last month',
        quote: 'Lena moved to Seattle last month',
      },
    ],
  },
  { chat: 'sister', text: 'Where does my sister live these days?', proposals: [] },
  { chat: 'profile', text: 'What do you know about me?', proposals: [] },
  {
    chat: 'flights',
    text: "I'm booking flights to see my sister in Seattle next month.",
    proposals: [
      {
        fact: 'seattle-trip',
        lasting: false,
        domain_key: 'trip.seattle.flights',
        content: 'The user is booking flights to Seattle next month',
        quote: "I'm booking flights to see my sister in Seattle next month",
      },
    ],
  },
  { chat: 'paella', text: 'Find a good paella place near home.', proposals: [] },
  { chat: 'gift', text: "Gift ideas for my sister's birthday?", proposals: [] },
  {
    chat: 'recap',
    text: 'Make a skill: every Friday, summarise my week. This week I shipped the onboarding redesign, ran 3 user interviews, fixed the billing bug and planned Q4.',
    proposals: [
      {
        fact: 'weekly-recap',
        lasting: true,
        domain_key: 'pref.weekly_recap',
        content: 'The user wants a weekly recap every Friday',
        quote: 'every Friday, summarise my week',
        kind: 'preference',
      },
      {
        fact: 'week-redesign',
        lasting: false,
        domain_key: 'work.onboarding_redesign',
        content: 'Shipped the onboarding redesign this week',
        quote: 'This week I shipped the onboarding redesign',
      },
      {
        fact: 'week-interviews',
        lasting: false,
        domain_key: 'work.user_interviews',
        content: 'Ran 3 user interviews this week',
        quote: 'ran 3 user interviews',
      },
      {
        fact: 'week-billing',
        lasting: false,
        domain_key: 'work.billing',
        content: 'Fixed the billing bug',
        quote: 'fixed the billing bug',
      },
      {
        fact: 'week-q4',
        lasting: false,
        domain_key: 'work.q4_planning',
        content: 'Planned Q4',
        quote: 'planned Q4',
      },
    ],
  },
  {
    chat: 'long',
    text: 'Remember this for later: the offsite code word is BLUEBIRD.',
    proposals: [
      {
        fact: 'code-word',
        lasting: true,
        domain_key: 'routines.offsite.code_word',
        content: 'The offsite code word is BLUEBIRD',
        quote: 'the offsite code word is BLUEBIRD',
      },
    ],
  },
  {
    chat: 'routine',
    text: 'Every weekday at 8am, send me a short AI news briefing.',
    proposals: [
      {
        fact: 'ai-news',
        lasting: true,
        domain_key: 'pref.news.ai_briefing',
        content: 'The user wants an AI news briefing every weekday at 8am',
        quote: 'Every weekday at 8am, send me a short AI news briefing',
        kind: 'preference',
      },
    ],
  },
  {
    chat: 'reminder',
    text: 'Remind me in 3 minutes to text Sam about dinner plans tonight.',
    proposals: [
      {
        fact: 'dinner-tonight',
        lasting: false,
        domain_key: 'person.sam.dinner',
        content: 'Dinner plans with Sam tonight',
        quote: 'text Sam about dinner plans tonight',
      },
    ],
  },
  {
    chat: 'later',
    text: 'My sister Lena lives in Seattle now, by the way.',
    proposals: [
      {
        fact: 'lena-city',
        lasting: true,
        domain_key: 'family.sister.location',
        restates: true,
        content: "Lena, the user's sister, lives in Seattle",
        quote: 'My sister Lena lives in Seattle now',
      },
    ],
  },
];

/** The scripted model: for each message, the answer the hosted model gave, or the one asked for. */
const model = (answers: Answers): ExtractionGateway => ({
  async chat({ messages }) {
    const input = JSON.parse(messages[1]?.content ?? '{}') as {
      evidence?: { text?: string };
      claims?: { id: string; domain_key: string; head_revision: number }[];
    };
    const said = HALF_HOUR.find((item) => item.text === input.evidence?.text?.trim());
    if (!said) throw new Error(`no scripted answer for: ${input.evidence?.text}`);
    const asked = answers === 'as_asked';
    return JSON.stringify({
      proposals: said.proposals
        .filter((item) => !(asked && item.restates))
        .map((item) => {
          const corrected =
            asked && item.corrects
              ? input.claims?.find((claim) => claim.domain_key === item.corrects)
              : undefined;
          return {
            op: corrected ? 'supersede' : 'add',
            claim_id: corrected?.id ?? null,
            expected_revision: corrected?.head_revision ?? null,
            domain_key: corrected?.domain_key ?? item.domain_key,
            content: corrected ? (item.followed ?? item.content) : item.content,
            kind: item.kind ?? 'user_statement',
            factual_status: 'attributed',
            valid_from: '2026-10-01T00:00:00Z',
            valid_until: null,
            lasting: true,
            about: asked && !item.lasting ? 'this_task_only' : null,
            sources: [{ quote: item.quote }],
          };
        }),
    });
  },
});

/** How a belief was labelled before: the subject's words in key order. */
function previousLabel(key: string | null, domainKey: string): string {
  const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  if (key) {
    const [kind, subject, field] = key.split('.');
    const name = capitalize((subject ?? '').replaceAll('-', ' '));
    const leaf = (field ?? '').replaceAll('-', ' ');
    if (kind === 'contact') return `${name}'s ${leaf}`;
    if (kind === 'event') return `${name} ${leaf}`;
    if (kind === 'pref') return `${name}: ${leaf}`;
    if (kind === 'constraint') return `${name}: ${leaf}`;
  }
  const parts = (domainKey.split(':exception:')[0] ?? domainKey)
    .split(/[.:]/)
    .map((part) => part.replaceAll(/[_-]+/g, ' ').trim())
    .filter(Boolean);
  const generic = new Set(['fact', 'facts', 'user', 'owner', 'me', 'my', 'self', 'info']);
  const people = new Set([
    'person',
    'people',
    'contact',
    'contacts',
    'family',
    'friend',
    'friends',
  ]);
  const [head = '', ...rest] = parts;
  if (people.has(head.toLowerCase()) && rest.length >= 2)
    return `${capitalize(rest[0] ?? '')}'s ${rest.slice(1).join(' ')}`;
  return capitalize((generic.has(head.toLowerCase()) && rest.length ? rest : parts).join(' '));
}

/** Whether a label is just its subject key's words, as "Sister's lena city" is. */
function keyLike(label: string, domainKey: string): boolean {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/'s\b/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  // "Me's job" and "Pref diet vegetarian" are still the key, whatever head it had.
  const heads = new Set(
    'person people contact contacts family friend friends me my pref prefs user owner fact facts'.split(
      ' ',
    ),
  );
  const meaningful = (text: string) =>
    words(text)
      .filter((word) => !heads.has(word))
      .join(' ');
  return meaningful(label) === meaningful(domainKey.replace(/[._:-]/g, ' '));
}

const scopeFor = (database: TestDatabase, scope: MemoryScope) => async (jobId: string) => {
  const [job] = await database.sql`select space_id from job where id = ${jobId}`;
  if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
  return scope;
};

async function chat(scope: MemoryScope) {
  if (!jobs) throw new Error('no job service');
  const service = jobs;
  const row = await principalContext.run(scope.ownerId, () =>
    service.transaction((tx) =>
      service.createInTransaction(
        tx,
        { space_id: scope.spaceId, title: 'New chat', objective: 'New chat' },
        { kind: 'chat' },
        'owner_request',
      ),
    ),
  );
  return row.id;
}

type Measured = {
  beliefs: number;
  one_off: number;
  duplicates: number;
  lasting_facts_kept: number;
  lasting_facts: number;
  third_person: number;
  key_like_labels: number;
  labels: string[];
};

/** The script, through memory as it reads messages, then scored from the memory page. */
async function halfHour(database: TestDatabase, noisy: boolean, answers: Answers = 'as_seen') {
  resetMemorySeams();
  if (noisy) setMemorySeams({ keepNoisyProposals: true });
  const scope = await createScope(database);
  const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
  const journal = await createJournal();
  try {
    const chats = new Map<string, string>();
    for (const said of HALF_HOUR) {
      const job = chats.get(said.chat) ?? (await chat(scope));
      chats.set(said.chat, job);
      const payload = { kind: 'user_message', text: said.text, principal_id: scope.ownerId };
      await database.sql`insert into event (job_id, type, payload, dedup_key)
        values (${job}, 'notice', ${JSON.stringify(payload)}::text::jsonb, ${`evt:${newId('turn')}`})`;
      await captureChat({
        sql: database.sql,
        journal: journal.journal,
        scopeForJob: scopeFor(database, owner),
        privacyOrigin: async () => null,
      });
      for (let batch = await claimWork(database.sql, scope); batch; ) {
        const proposals = await proposeExtraction(database.sql, scope, batch, model(answers));
        const result = await commitExtraction(database.sql, scope, batch, { proposals });
        expect(result.status).toBe('committed');
        batch = await claimWork(database.sql, scope);
      }
    }
  } finally {
    resetMemorySeams();
    await journal.close();
  }
  const beliefs = await listBeliefs(database.sql, scope, 'America/Los_Angeles');
  const subjects = new Map<string, { domain_key: string; key: string | null }>();
  for (const row of await database.sql`select id, domain_key, key from memory_claims
    where space_id = ${scope.spaceId}`)
    subjects.set(String(row.id), {
      domain_key: String(row.domain_key),
      key: (row.key as string | null) ?? null,
    });
  return { scope, beliefs, measured: score(beliefs, subjects, noisy) };
}

function score(
  beliefs: Belief[],
  subjects: Map<string, { domain_key: string; key: string | null }>,
  noisy: boolean,
): Measured {
  const proposed = HALF_HOUR.flatMap((said) => said.proposals);
  const plain = (text: string) =>
    text
      .toLowerCase()
      .replace(/[\s.!]+$/u, '')
      .trim();
  const facts = new Map<string, Proposed>();
  for (const item of proposed) {
    facts.set(plain(item.content), item);
    facts.set(plain(inPersonsWords(item.content)), item);
    if (item.followed) facts.set(plain(item.followed), item);
  }
  const stated = beliefs.map((belief) => facts.get(plain(belief.value)));
  // Every belief comes from the script: nothing was made up on the way.
  expect(stated.filter((fact) => !fact)).toEqual([]);
  const distinct = new Set(stated.map((fact) => fact?.fact));
  const lasting = new Set(proposed.filter((item) => item.lasting).map((item) => item.fact));
  const labels = beliefs.map((belief) => {
    const subject = subjects.get(belief.id);
    return noisy && subject ? previousLabel(subject.key, subject.domain_key) : belief.label;
  });
  return {
    beliefs: beliefs.length,
    one_off: stated.filter((fact) => fact && !fact.lasting).length,
    duplicates: beliefs.length - distinct.size,
    lasting_facts_kept: [...distinct].filter((fact) => fact && lasting.has(fact)).length,
    lasting_facts: lasting.size,
    third_person: beliefs.filter((belief) => /\bthe user\b/i.test(belief.value)).length,
    key_like_labels: beliefs.filter((belief, index) => {
      const subject = subjects.get(belief.id);
      return subject ? keyLike(labels[index] ?? '', subject.domain_key) : false;
    }).length,
    labels,
  };
}

withDb('a half hour of chat', () => {
  test('keeps fewer, lasting beliefs, each once and in plain words, and loses no lasting fact', async () => {
    if (!db) return;
    const before = await halfHour(db, true);
    const after = await halfHour(db, false);
    // The same rules, with the model answering as the new instructions ask.
    const asked = await halfHour(db, false, 'as_asked');
    const row = (name: keyof Measured) =>
      `${name.padEnd(20)} ${[before, after, asked].map((arm) => String(arm.measured[name]).padStart(8)).join('')}`;
    process.stdout.write(
      [
        '',
        'memory noise, a half hour of chat',
        `${''.padEnd(20)}${['before', 'after', 'asked'].map((name) => name.padStart(8)).join('')}`,
        row('beliefs'),
        row('one_off'),
        row('duplicates'),
        row('lasting_facts_kept'),
        row('lasting_facts'),
        row('third_person'),
        row('key_like_labels'),
        `labels before: ${before.measured.labels.join(' | ')}`,
        `labels after:  ${after.measured.labels.join(' | ')}`,
        `labels asked:  ${asked.measured.labels.join(' | ')}`,
        '',
      ].join('\n'),
    );
    // Answered as asked, memory keeps each lasting fact once and nothing else.
    expect(asked.measured).toMatchObject({
      beliefs: asked.measured.lasting_facts,
      one_off: 0,
      duplicates: 0,
      lasting_facts_kept: asked.measured.lasting_facts,
      third_person: 0,
    });
    const { measured: was } = before;
    const { measured: now } = after;
    expect(now.beliefs).toBeLessThan(was.beliefs);
    expect(now.one_off).toBeLessThan(was.one_off);
    expect(now.duplicates).toBeLessThan(was.duplicates);
    // Nothing worth keeping is lost.
    expect(now.lasting_facts_kept).toBe(was.lasting_facts_kept);
    expect(now.lasting_facts_kept).toBe(now.lasting_facts);
    expect(now.third_person).toBe(0);
    expect(now.key_like_labels).toBeLessThan(was.key_like_labels);

    // Allergies and diets still come first, for a food ask, merged or not.
    await buildViews(db.sql, after.scope);
    const dinner = await recall(
      db.sql,
      after.scope,
      { query: 'Where should we go for a seafood dinner tonight? Oysters maybe?' },
      { includeProfile: true },
    );
    const first = dinner.items.slice(0, 2).map((item) => item.content);
    expect(first).toEqual(expect.arrayContaining(['Has a severe shellfish allergy', 'Vegetarian']));
  });
});
