import { expect, test } from 'bun:test';
import {
  libraryAnswers,
  libraryRoutine,
  libraryScheduleWords,
} from '@melete/contracts/agent-library';
import type { AgentTemplate } from '../experience/types.ts';
import {
  dayWork,
  kindsOfApp,
  listWords,
  missingNeeds,
  recommend,
  searchLibrary,
  shelvesOf,
  suggests,
} from './agent-library.ts';

const agent = {
  colour: '#7A86D8',
  surface: 'rounded',
  eye_colour: '#161C45',
  tone: 'Calm',
  standing_instruction: 'Help.',
  allowed_connection_ids: [],
  asks_before_acting: true,
  uses_computer: false,
  reads_memory: true,
  writes_memory: true,
} as const;
const entry = (
  id: string,
  name: string,
  category: AgentTemplate['category'],
  more: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id,
  title: name,
  category,
  benefit: `${name} helps.`,
  does: [`Does ${id}`],
  wont: ['Never sends without your yes'],
  works_best_with: ['mail'],
  relies_on: [],
  starter_routine: null,
  questions: [],
  skills: [],
  featured: false,
  day: {
    ask: 'Help me.',
    opening: 'On it.',
    work: [
      { reach: 'mail', title: 'Searched your inbox' },
      { reach: 'files', title: 'Read `notes.md`' },
    ],
    question: { text: 'Go ahead?', options: ['Yes', 'No'] },
    answer: 'Done.',
  },
  agent: { ...agent, allowed_connection_ids: [], name, role: name },
  ...more,
});
const templates: AgentTemplate[] = [
  entry('morning-brief', 'Wren', 'Personal', { works_best_with: ['calendar'] }),
  entry('inbox-triage', 'Iris', 'Work & email', {
    benefit: 'A clear inbox.',
    starter_routine: {
      title: 'Inbox sweep',
      instruction: 'Sweep my inbox.',
      weekdays: [1, 2, 3, 4, 5],
      at: '09:00',
    },
    questions: [
      {
        id: 'important',
        question: 'Whose mail always matters to you?',
        placeholder: 'My manager',
        memory_key: 'pref.inbox.important-senders',
      },
      {
        id: 'voice',
        question: 'How do you like your replies to sound?',
        placeholder: 'Short',
        memory_key: 'pref.inbox.reply-voice',
      },
    ],
  }),
  entry('refund-chaser', 'Remy', 'Money', { benefit: 'Gets a refund back.' }),
  entry('bill-tracker', 'Penny', 'Money', { works_best_with: ['files'] }),
];

test('search matches every word, across name, benefit and what it works with', () => {
  expect(searchLibrary(templates, 'inbox', null).map((t) => t.id)).toContain('inbox-triage');
  expect(searchLibrary(templates, 'IRIS', null).map((t) => t.id)).toEqual(['inbox-triage']);
  expect(searchLibrary(templates, 'refund mail', null).map((t) => t.id)).toContain('refund-chaser');
  expect(searchLibrary(templates, 'zzz nothing', null)).toEqual([]);
  const money = searchLibrary(templates, '', 'Money');
  expect(money.length).toBeGreaterThan(0);
  expect(money.every((t) => t.category === 'Money')).toBe(true);
  expect(shelvesOf(templates)[0]).toBe('Personal');
});

test('connections are suggested by kind, never by being ticked', () => {
  expect(kindsOfApp('Gmail')).toEqual(['mail']);
  expect(kindsOfApp('Google Calendar')).toEqual(['calendar']);
  expect(kindsOfApp('Computer')).toEqual(['computer', 'devices']);
  expect(kindsOfApp('Speech')).toEqual([]);
  expect(kindsOfApp('Code host')).toEqual(['mcp']);
  expect(suggests(['mail'], 'Mail')).toBe(true);
  expect(suggests(['mail'], 'Files')).toBe(false);
});

test('answers become statements on the purpose keys; a routine is for the new agent', () => {
  const inbox = templates.find((t) => t.id === 'inbox-triage');
  if (!inbox?.starter_routine) throw new Error('no inbox template');
  const saved = libraryAnswers(inbox.questions, { important: ' My manager ', voice: '' });
  expect(saved).toEqual([
    {
      key: 'pref.inbox.important-senders',
      value: 'My manager',
      statement: 'Whose mail always matters to you? My manager',
    },
  ]);
  expect(libraryRoutine(inbox.starter_routine, 'agent_1')).toMatchObject({
    agent_id: 'agent_1',
    at: '09:00',
  });
  expect(libraryScheduleWords(inbox.starter_routine)).toBe('Weekdays at 9:00 AM');
  expect(libraryScheduleWords({ weekdays: [0], at: '17:00' })).toBe('Sundays at 5:00 PM');
  expect(libraryScheduleWords({ weekdays: [6, 0], at: '00:05' })).toBe('Weekends at 12:05 AM');
});

test('a connection the job rests on is missing when none it may reach provides it', () => {
  const needs: AgentTemplate['relies_on'] = [
    { kind: 'files', without: 'It keeps your reading list in Files.' },
  ];
  const connections = [
    { id: 'conn_web', app: 'Web' },
    { id: 'conn_files', app: 'Files' },
  ];
  expect(missingNeeds(needs, connections, ['conn_web'])).toEqual(needs);
  expect(missingNeeds(needs, connections, ['conn_web', 'conn_files'])).toEqual([]);
  // Everything ticked reaches every connection, Files included.
  expect(missingNeeds(needs, connections, null)).toEqual([]);
  // Nothing that provides it is connected at all.
  expect(missingNeeds(needs, [{ id: 'conn_web', app: 'Web' }], null)).toEqual(needs);
  expect(missingNeeds([], connections, [])).toEqual([]);
});

test('recommendations rest on what is connected, say why, and keep to one per shelf', () => {
  const mail = [{ app: 'Gmail', status: 'connected' }];
  const mine = recommend(templates, mail);
  // Mail connected: the inbox agent comes first, and the reason names Mail only.
  expect(mine.templates.map((t) => t.id)).toEqual(['inbox-triage', 'refund-chaser']);
  expect(mine.because).toEqual(['mail']);
  // A featured agent comes before an equal fit that is not.
  const featured = templates.map((t) => (t.id === 'refund-chaser' ? { ...t, featured: true } : t));
  expect(recommend(featured, mail).templates[0]?.id).toBe('refund-chaser');
  // Two from the same shelf: only the better one.
  const both = recommend(templates, [...mail, { app: 'Files', status: 'connected' }]);
  expect(both.templates.filter((t) => t.category === 'Money')).toHaveLength(1);
  // Nothing connected, or only a connection that is not ready: nothing to recommend.
  expect(recommend(templates, []).templates).toEqual([]);
  expect(recommend(templates, [{ app: 'Gmail', status: 'error' }]).templates).toEqual([]);
  // Web pages alone never make a recommendation: it rests on the person's own apps.
  const web = [entry('reader', 'Fern', 'Learning', { works_best_with: ['web', 'files'] })];
  expect(recommend(web, [{ app: 'Web', status: 'connected' }]).templates).toEqual([]);
});

test('a template’s example work becomes finished rows of the matching kind', () => {
  const [inbox, notes] = dayWork(templates[1] as AgentTemplate);
  expect(inbox).toMatchObject({ kind: 'connector', title: 'Searched your inbox', status: 'done' });
  expect(notes).toMatchObject({ kind: 'file', title: 'Read `notes.md`' });
  expect(new Set([inbox?.id, notes?.id]).size).toBe(2);
});

test('lists read as a sentence', () => {
  expect(listWords([])).toBe('');
  expect(listWords(['Mail'])).toBe('Mail');
  expect(listWords(['Mail', 'Calendar'])).toBe('Mail and Calendar');
  expect(listWords(['Mail', 'Calendar', 'Files'])).toBe('Mail, Calendar and Files');
});
