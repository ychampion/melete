/**
 * The designed surfaces, served in memory under /experience.
 *
 * A conversation here is a view over jobs: every message a person sends is a
 * job played by a scenario through the real state machine, and the trail,
 * cards, permissions and receipts the interface shows are derived from that
 * job's persisted events. The approval card is built from the action record
 * and decided against its hash; an unknown outcome rests until a person says
 * what they found. Nothing in this file invents a state the machine did not
 * reach.
 *
 * The shapes match apps/web/src/experience/types.ts, which follow
 * docs/design/INTEGRATION.md. When the experience contract lands, these routes
 * are the ones it describes.
 */

import type { ApiEvent } from '@melete/contracts';
import { SSE_KEEPALIVE } from '@melete/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Runner } from './runner.ts';
import type { Scenario } from './scenario.ts';
import { newId, type Store } from './store.ts';

type Json = Record<string, unknown>;

export type ExperienceDeps = {
  store: Store;
  runner: Runner;
  scenarios: Scenario[];
  spaceId: string;
  /** The contract app, so decisions and answers go through its routes. */
  api: Hono;
  options?: { browser?: boolean; fresh?: boolean; seed?: boolean };
};

type ConversationRecord = {
  id: string;
  title: string;
  agent_id: string | null;
  pinned: boolean;
  preview: string;
  created_at: string;
  updated_at: string;
  job_ids: string[];
  deleted: boolean;
};

type ConversationEvent = {
  seq: number;
  conversation_id: string;
  type: string;
  payload: Json;
  created_at: string;
};

/** What a connector kind means to a person. Tool names never reach the screen. */
const KINDS: Record<
  string,
  { verb: string; past: string; app: string; label: string; where: string }
> = {
  'calendar.event.create': {
    verb: 'add an event to Google Calendar',
    past: 'Added to your calendar',
    app: 'gcal',
    label: 'Google Calendar',
    where: 'Google Calendar',
  },
  'email.send': {
    verb: 'send an email from your mailbox',
    past: 'Sent from your mailbox',
    app: 'gmail',
    label: 'mailbox',
    where: 'Mail',
  },
  'messages.send': {
    verb: 'send a message via Messages',
    past: 'Sent via Messages',
    app: 'imessage',
    label: 'Messages',
    where: 'Messages',
  },
  'test.write': {
    verb: 'write one line to the test destination',
    past: 'Written to the test destination',
    app: 'globe',
    label: 'test destination',
    where: 'Test destination',
  },
  'browser.reserve': {
    verb: 'reserve a table through the sandboxed browser',
    past: 'Reserved',
    app: 'globe',
    label: 'sandboxed browser',
    where: 'Resy',
  },
};

const APP_WORDS: Record<string, string> = {
  gcal: 'calendar',
  gmail: 'Mail',
  gmaps: 'Maps',
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  slack: 'Slack',
  notion: 'Notion',
  linear: 'Linear',
  google: 'web',
  reddit: 'web',
  yelp: 'web',
  youtube: 'web',
  tripadvisor: 'web',
  web: 'web',
  globe: 'the browser',
};

const humanKind = (kind: string) =>
  KINDS[kind] ?? {
    verb: `use ${kind.split('.')[0] ?? 'a connection'}`,
    past: 'Done',
    app: 'globe',
    label: 'a connection',
    where: kind.split('.')[0] ?? 'a connection',
  };

const seconds = (from: string, to: string) =>
  Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));

function formatWhen(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createExperience(deps: ExperienceDeps) {
  const { store, runner, spaceId, api } = deps;
  const browserAvailable = deps.options?.browser ?? true;
  const app = new Hono();
  const now = () => store.now().toISOString();
  const today = () => store.now();

  // ------------------------------------------------------------------
  // fixtures
  // ------------------------------------------------------------------

  const state = {
    signedIn: !deps.options?.fresh,
    onboarded: !deps.options?.fresh,
    profile: {
      name: 'Jamie Davis',
      short_name: 'Jamie',
      email: 'jamie@example.com',
      timezone: 'New York · GMT−4',
      day_start: '8:00 AM',
      day_end: '10:00 PM',
      morning_brief: true,
      space: 'Personal',
    },
  };

  const agents: Json[] = [
    {
      id: 'nova',
      name: 'Nova',
      role: 'Concierge',
      blurb: 'Meetings, dinners, trips and bookings. Confirms before anything is paid.',
      look: { color: '#4aa3f7', eyes: 'white', shape: 'blob', image: null },
      tone: 'warm',
      standing_instruction: 'One option first, not five. Confirm before paying.',
      allowed_connections: ['gcal', 'gmaps', 'imessage', 'browser'],
      asks_before_acting: true,
      reaches: ['calendar', 'places', 'messages', 'the web'],
      stats: { chats: 3, last_used: 'today' },
    },
    {
      id: 'sage',
      name: 'Sage',
      role: 'Coach',
      blurb: 'Keeps the 10K plan honest. Direct, no fluff.',
      look: { color: '#5ab4a0', eyes: 'black', shape: 'octagon', image: null },
      tone: 'direct',
      standing_instruction: 'Ask how the last run went before suggesting the next.',
      allowed_connections: ['gcal'],
      asks_before_acting: true,
      reaches: ['calendar', 'plans'],
      stats: { chats: 1, last_used: 'Monday' },
    },
    {
      id: 'atlas',
      name: 'Atlas',
      role: 'Researcher',
      blurb: 'Reads everything and answers with sources.',
      look: { color: '#ec8a2b', eyes: 'white', shape: 'diamond', image: null },
      tone: 'direct',
      standing_instruction: 'Cite every claim. Say when the sources disagree.',
      allowed_connections: ['notion', 'gdrive'],
      asks_before_acting: true,
      reaches: ['the web', 'files'],
      stats: { chats: 2, last_used: 'yesterday' },
    },
    {
      id: 'pip',
      name: 'Pip',
      role: 'Helper',
      blurb: 'Reminders, small errands and the odd joke.',
      look: { color: '#c9c1f5', eyes: 'black', shape: 'square', image: null },
      tone: 'playful',
      standing_instruction: 'Keep reminders to one line.',
      allowed_connections: ['imessage', 'gcal'],
      asks_before_acting: true,
      reaches: ['messages', 'calendar'],
      stats: { chats: 0, last_used: null },
    },
  ];

  const agentTemplates: Json[] = [
    {
      id: 'planner',
      title: 'Planner',
      description: 'Breaks goals into milestones',
      agent: {
        name: 'Planner',
        role: 'Planner',
        blurb: 'Turns an objective into milestones and keeps the next step in view.',
        look: { color: '#5ab4a0', eyes: 'white', shape: 'square', image: null },
        tone: 'direct',
        standing_instruction: 'Three milestones at most to start.',
        allowed_connections: ['gcal'],
        asks_before_acting: true,
        reaches: ['plans', 'calendar'],
      },
    },
    {
      id: 'travel',
      title: 'Travel concierge',
      description: 'Flights, stays, reservations',
      agent: {
        name: 'Journey',
        role: 'Travel concierge',
        blurb: 'Flights, stays and reservations, always with a fallback.',
        look: { color: '#f4c430', eyes: 'white', shape: 'blob', image: null },
        tone: 'warm',
        standing_instruction: 'Never book anything non-refundable without asking.',
        allowed_connections: ['gcal', 'gmail', 'browser'],
        asks_before_acting: true,
        reaches: ['calendar', 'mail', 'the browser'],
      },
    },
    {
      id: 'study',
      title: 'Study buddy',
      description: 'Quizzes and daily practice',
      agent: {
        name: 'Quill',
        role: 'Study buddy',
        blurb: 'Daily practice, short quizzes, honest scores.',
        look: { color: '#a43fc8', eyes: 'black', shape: 'gear', image: null },
        tone: 'playful',
        standing_instruction: 'Ten minutes a day, no guilt trips.',
        allowed_connections: ['gcal'],
        asks_before_acting: true,
        reaches: ['calendar', 'plans'],
      },
    },
  ];

  const plans: Json[] = [
    {
      id: 'japan',
      title: 'Japan, two weeks in October',
      description: 'Kyoto, Tokyo, and a few days somewhere quiet.',
      category: 'travel',
      next_step: 'Book the Kyoto ryokan',
      progress: 40,
      status: 'in_progress',
      milestones: [
        {
          id: 'm1',
          text: 'Pick the dates · Oct 10–24',
          done: true,
          assignee: { kind: 'person', name: 'Jamie' },
        },
        { id: 'm2', text: 'Set a budget', done: true, assignee: { kind: 'person', name: 'Jamie' } },
        {
          id: 'm3',
          text: 'Book the Kyoto ryokan',
          done: false,
          assignee: { kind: 'agent', agent_id: 'nova' },
        },
        {
          id: 'm4',
          text: 'Find flights',
          done: false,
          assignee: { kind: 'agent', agent_id: 'nova' },
        },
        { id: 'm5', text: 'Plan two days outside the cities', done: false, assignee: null },
      ],
      linked: [
        { kind: 'chat', id: 'kyoto', title: 'Kyoto in October', sub: 'Chat · yesterday' },
        { kind: 'file', id: 'kyoto-notes', title: 'kyoto-notes.md', sub: 'File · 4 KB' },
      ],
      updated_at: '2 days ago',
      needs_you: null,
    },
    {
      id: '10k',
      title: 'Run a 10K by November',
      description: 'Twelve weeks, three runs a week.',
      category: 'wellbeing',
      next_step: 'Week 6 of 12 · long run Sunday',
      progress: 60,
      status: 'in_progress',
      milestones: [
        {
          id: 'm1',
          text: 'Get checked out and pick shoes',
          done: true,
          assignee: { kind: 'person', name: 'Jamie' },
        },
        {
          id: 'm2',
          text: 'Weeks 1–4 · run-walk to 3K',
          done: true,
          assignee: { kind: 'agent', agent_id: 'sage' },
        },
        {
          id: 'm3',
          text: 'Weeks 5–8 · steady 5K',
          done: false,
          assignee: { kind: 'agent', agent_id: 'sage' },
        },
        {
          id: 'm4',
          text: 'Weeks 9–11 · long runs to 9K',
          done: false,
          assignee: { kind: 'agent', agent_id: 'sage' },
        },
        {
          id: 'm5',
          text: 'Race day · Nov 15',
          done: false,
          assignee: { kind: 'person', name: 'Jamie' },
        },
      ],
      linked: [],
      updated_at: 'yesterday',
      needs_you: 'Sage needs the long-run route confirmed before Sunday.',
    },
    {
      id: 'spanish',
      title: 'Spanish, conversational by spring',
      description: 'Enough to order, ask, and argue a little.',
      category: 'learning',
      next_step: 'Learn 100 useful phrases',
      progress: 45,
      status: 'in_progress',
      milestones: [
        {
          id: 'm1',
          text: 'Pick a course and a tutor',
          done: true,
          assignee: { kind: 'person', name: 'Jamie' },
        },
        {
          id: 'm2',
          text: 'Learn 100 useful phrases',
          done: false,
          assignee: { kind: 'agent', agent_id: 'atlas' },
        },
        { id: 'm3', text: 'First 15-minute conversation', done: false, assignee: null },
      ],
      linked: [],
      updated_at: '4 days ago',
      needs_you: null,
    },
    {
      id: 'fund',
      title: 'Three-month emergency fund',
      description: 'A cushion, built on the first of every month.',
      category: 'finance',
      next_step: 'Move 400 into savings on the 1st',
      progress: 25,
      status: 'in_progress',
      milestones: [
        {
          id: 'm1',
          text: 'Open the savings account',
          done: true,
          assignee: { kind: 'person', name: 'Jamie' },
        },
        {
          id: 'm2',
          text: 'Move 400 into savings on the 1st',
          done: false,
          assignee: { kind: 'agent', agent_id: 'pip' },
        },
        { id: 'm3', text: 'Month two', done: false, assignee: { kind: 'agent', agent_id: 'pip' } },
        {
          id: 'm4',
          text: 'Month three',
          done: false,
          assignee: { kind: 'agent', agent_id: 'pip' },
        },
      ],
      linked: [],
      updated_at: 'a week ago',
      needs_you: null,
    },
  ];

  const planTemplates: Json[] = [
    {
      id: 'travel',
      category: 'travel',
      title: 'Travel itinerary',
      description: 'Destinations, dates, and a budget.',
    },
    {
      id: 'routine',
      category: 'wellbeing',
      title: 'Weekly routine',
      description: 'A schedule you can keep.',
    },
    {
      id: 'learning',
      category: 'learning',
      title: 'Learning roadmap',
      description: 'A skill, broken into milestones.',
    },
  ];

  const automations: Json[] = [
    {
      id: 'brief',
      name: 'Morning brief',
      trigger: 'Every weekday at 8:30 AM',
      cron: '30 8 * * 1-5',
      description: 'Today’s events, open tasks, and the weather',
      enabled: true,
      runs: [
        { id: 'r1', status: 'ok', when: 'Today at 8:30 AM', note: '' },
        { id: 'r2', status: 'ok', when: 'Yesterday at 8:30 AM', note: '' },
        { id: 'r3', status: 'failed', when: 'Mon at 8:30 AM', note: 'Google Calendar timed out' },
      ],
      next_run: 'Next run tomorrow at 8:30 AM',
    },
    {
      id: 'expenses',
      name: 'Expenses on Fridays',
      trigger: 'Every Friday at 4:00 PM',
      cron: '0 16 * * 5',
      description: 'Collects the week’s receipts into a draft report for you to submit',
      enabled: true,
      runs: [
        { id: 'r1', status: 'ok', when: 'Fri at 4:00 PM', note: '6 receipts' },
        { id: 'r2', status: 'ok', when: 'Last Fri at 4:00 PM', note: '4 receipts' },
      ],
      next_run: 'Next run Friday at 4:00 PM',
    },
    {
      id: 'run-check',
      name: 'Long-run check-in',
      trigger: 'Every Sunday at 7:00 AM',
      cron: '0 7 * * 0',
      description: 'Sage asks how the long run went and adjusts the week',
      enabled: false,
      runs: [{ id: 'r1', status: 'ok', when: 'Sun at 7:00 AM', note: '' }],
      next_run: 'Off',
    },
  ];

  const memory: Json[] = [
    {
      id: 'mem1',
      key: 'Home',
      value: 'New York · Eastern time',
      source: 'onboarding',
      created: 'Sep 1',
      last_used: 'today',
      why: 'Used for time zones, weather and how far things are.',
    },
    {
      id: 'mem2',
      key: 'People',
      value: 'Alex and Priya · friends, both in the Village',
      source: 'onboarding',
      created: 'Sep 1',
      last_used: 'today',
      why: 'So “Alex” and “Priya” mean the right people, with their preferences.',
    },
    {
      id: 'mem3',
      key: 'Alex',
      value: 'Vegetarian, hates loud rooms, mentioned pasta last time',
      source: 'conversation',
      created: 'Sep 4',
      last_used: 'today',
      why: 'Learned while picking a restaurant; used to shortlist quiet Italian places.',
    },
    {
      id: 'mem4',
      key: 'Stand-up',
      value: 'Team stand-up · 9:30 daily, never move it',
      source: 'conversation',
      created: 'Aug 22',
      last_used: 'Monday',
      why: 'Keeps scheduling suggestions clear of the one meeting that cannot move.',
    },
    {
      id: 'mem5',
      key: 'Check-ins',
      value: 'Morning brief at 8:30, nothing before 8',
      source: 'onboarding',
      created: 'Sep 1',
      last_used: 'today',
      why: 'Sets the hours Melete may nudge you.',
    },
    {
      id: 'mem6',
      key: 'Priya',
      value: 'Prefers WhatsApp over email',
      source: 'inferred',
      created: 'Sep 6',
      last_used: 'yesterday',
      why: 'Three of the last four replies came from WhatsApp; drafts go there first.',
    },
  ];

  const connections: Json[] = [
    {
      id: 'gcal',
      app: 'gcal',
      name: 'Google Calendar',
      what: 'See your day, add events',
      state: 'connected',
      access: 'write',
      error: null,
    },
    {
      id: 'gmaps',
      app: 'gmaps',
      name: 'Google Maps',
      what: 'Places, hours and travel time',
      state: 'connected',
      access: 'read',
      error: null,
    },
    {
      id: 'imessage',
      app: 'imessage',
      name: 'Messages',
      what: 'Draft texts · you always send',
      state: 'connected',
      access: 'draft',
      error: null,
    },
    {
      id: 'gmail',
      app: 'gmail',
      name: 'Gmail',
      what: 'Find bookings and receipts',
      state: 'error',
      access: 'read',
      error: 'Access expired on Sep 8 · receipts stopped syncing',
    },
    {
      id: 'whatsapp',
      app: 'whatsapp',
      name: 'WhatsApp',
      what: 'Draft texts · you always send',
      state: 'available',
      access: 'draft',
      error: null,
    },
    {
      id: 'notion',
      app: 'notion',
      name: 'Notion',
      what: 'Read your notes and docs',
      state: 'available',
      access: 'read',
      error: null,
    },
    {
      id: 'slack',
      app: 'slack',
      name: 'Slack',
      what: 'Work threads and reminders',
      state: 'available',
      access: 'draft',
      error: null,
    },
    {
      id: 'gdrive',
      app: 'gdrive',
      name: 'Google Drive',
      what: 'Files, PDFs and forms',
      state: 'available',
      access: 'read',
      error: null,
    },
  ];

  const rules: Json[] = [
    {
      id: 'rule1',
      text: 'Pip may send a message via Messages without asking',
      connection: { app: 'imessage', label: 'Messages' },
      agent_id: 'pip',
      created: 'Sep 4',
    },
  ];

  const tasks: Json[] = [
    { id: 't1', text: 'Send Priya the Kyoto list', done: false },
    { id: 't2', text: 'Renew passport before Oct 3', done: false },
    { id: 't3', text: 'Read 20 pages', done: false },
    { id: 't4', text: 'Book the dentist', done: true },
  ];

  const files: Json[] = [
    { id: 'kyoto-notes', name: 'kyoto-notes.md', size: '4 KB', updated_at: 'Yesterday' },
  ];

  const dayPanel = (): Json => {
    const base = today();
    const dow = (base.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(base);
    monday.setDate(base.getDate() - dow);
    const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const dayAt = (offset: number) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + offset);
      return d;
    };
    const thu = dayAt(dow + 1 > 6 ? dow : dow + 1);
    const events = [
      {
        id: 'e1',
        day: 'Today',
        time: '11:00 AM',
        title: 'Deep work · review prep',
        duration: '1 hour',
        place: null,
        tint: 'sage',
        date: iso(base),
      },
      {
        id: 'e2',
        day: '',
        time: '7:30 PM',
        title: 'Dinner with Alex & Priya',
        duration: '1.5 hours',
        place: 'Luna Trattoria',
        tint: 'primary',
        date: iso(base),
      },
      {
        id: 'e3',
        day: thu.toLocaleDateString('en-US', { weekday: 'short' }),
        time: '7:00 AM',
        title: 'Run club',
        duration: '45 minutes',
        place: null,
        tint: 'sage',
        date: iso(thu),
      },
    ];
    const eventDates = new Set(events.map((e) => e.date));
    return {
      today: base.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      month: base.toLocaleDateString('en-US', { month: 'long' }),
      week: labels.map((label, i) => {
        const d = dayAt(i);
        return {
          label,
          num: d.getDate(),
          date: iso(d),
          has_events: eventDates.has(iso(d)),
          today: i === dow,
        };
      }),
      events,
      tasks,
      connections_synced: connections.filter((c) => c.state === 'connected').length,
    };
  };

  // ------------------------------------------------------------------
  // conversations: a view over jobs
  // ------------------------------------------------------------------

  const conversations = new Map<string, ConversationRecord>();
  const jobToConversation = new Map<string, string>();
  const events: ConversationEvent[] = [];
  let seq = 0;
  const subscribers = new Set<(event: ConversationEvent) => void>();

  /** Turn text as it streams, so a stop or a completion can settle it. */
  const turnText = new Map<string, string>();
  const turnStarted = new Map<string, string>();
  const turnSources = new Map<string, { app: string; label: string }[]>();
  const pendingTool = new Map<string, string>();
  const alwaysApprovals = new Set<string>();
  const receiptState = new Map<string, { undone: boolean }>();
  const draftState = new Map<
    string,
    { status: string; body: string; conversation_id: string; turn_id: string }
  >();
  const questionState = new Map<string, { job_id: string; answered: string | null }>();
  const browserState = new Map<string, { job_id: string; status: string }>();
  const unknownState = new Map<string, { job_id: string }>();

  const emit = (
    conversation_id: string,
    type: string,
    payload: Json,
    durable = true,
  ): ConversationEvent => {
    const event: ConversationEvent = {
      seq: ++seq,
      conversation_id,
      type,
      payload,
      created_at: now(),
    };
    if (durable) events.push(event);
    const record = conversations.get(conversation_id);
    if (record && durable) record.updated_at = event.created_at;
    for (const subscriber of subscribers) subscriber(event);
    return event;
  };

  const substitute = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const item = memory.find(
        (m) => String(m.key).toLowerCase().replace(/\s+/g, '_') === key.toLowerCase(),
      );
      return item ? String(item.value) : '';
    });

  const agentName = (agentId: string | null) =>
    (agents.find((a) => a.id === agentId)?.name as string | undefined) ?? 'Melete';

  const approvalFor = (actionId: string) =>
    [...store.approvals.values()].find((approval) => approval.action_id === actionId) ?? null;

  const permissionBlock = (approvalId: string, conversationId: string): Json | null => {
    const approval = store.approvals.get(approvalId);
    if (!approval) return null;
    const action = store.actions.get(approval.action_id);
    if (!action) return null;
    const record = conversations.get(conversationId);
    const kind = humanKind(action.kind);
    const payload = action.canonical_payload as Json;
    const detail = [payload.title, payload.summary, payload.subject, payload.when, payload.duration]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' · ');
    const status =
      approval.decision === null
        ? 'pending'
        : approval.decision === 'denied'
          ? 'denied'
          : alwaysApprovals.has(approvalId)
            ? 'allowed_always'
            : 'allowed_once';
    return {
      id: approvalId,
      title: `${agentName(record?.agent_id ?? null)} wants to ${kind.verb}`,
      detail,
      connection: { app: kind.app, label: kind.label },
      rule_text: `Runs through your ${kind.label} connection. “Always allow” creates a rule you can change in Settings.`,
      fields: payload,
      payload_hash: approval.payload_hash,
      status,
    };
  };

  const doneSummary = (turnId: string, started: string, ended: string): string => {
    const sources = turnSources.get(turnId) ?? [];
    const apps = [...new Set(sources.map((s) => APP_WORDS[s.app] ?? s.app))];
    const parts = [`Worked for ${seconds(started, ended)}s`];
    if (apps.length) parts.push(apps.join(', '));
    if (sources.length) parts.push(`${sources.length} source${sources.length === 1 ? '' : 's'}`);
    return parts.join(' · ');
  };

  const streamWords = (conversationId: string, turnId: string, text: string) => {
    const words = text.split(' ');
    words.forEach((word, index) => {
      setTimeout(
        () =>
          emit(
            conversationId,
            'text_delta',
            { turn_id: turnId, text: (index ? ' ' : '') + word },
            false,
          ),
        index * 28,
      );
    });
  };

  const onJobEvent = (event: ApiEvent) => {
    if (!event.job_id) return;
    const conversationId = jobToConversation.get(event.job_id);
    if (!conversationId) return;
    const record = conversations.get(conversationId);
    if (!record) return;
    const turnId = event.job_id;
    const payload = event.payload as Json;

    switch (event.type) {
      case 'job_created': {
        const text = typeof payload.objective === 'string' ? payload.objective : '';
        if (!text.startsWith('__')) {
          emit(conversationId, 'user_message', {
            id: `u_${event.seq}`,
            text,
            at: event.created_at,
            delivery: 'sent',
            attachments: [],
          });
        }
        turnStarted.set(turnId, event.created_at);
        turnText.set(turnId, '');
        turnSources.set(turnId, []);
        emit(conversationId, 'turn_started', {
          turn_id: turnId,
          agent_id: record.agent_id,
          at: event.created_at,
        });
        return;
      }
      case 'turn_started': {
        // A person answered a question the job asked.
        if (payload.from === 'owner' && typeof payload.text === 'string') {
          emit(conversationId, 'user_message', {
            id: `u_${event.seq}`,
            text: payload.text,
            at: event.created_at,
            delivery: 'sent',
            attachments: [],
          });
        }
        return;
      }
      case 'attempt_started':
        emit(conversationId, 'turn_status', { turn_id: turnId, status: 'running' });
        return;
      case 'text_delta': {
        if (typeof payload.text !== 'string') return;
        const previous = turnText.get(turnId) ?? '';
        turnText.set(turnId, previous ? `${previous} ${payload.text}` : payload.text);
        emit(conversationId, 'turn_status', { turn_id: turnId, status: 'streaming' });
        streamWords(conversationId, turnId, (previous ? ' ' : '') + substitute(payload.text));
        return;
      }
      case 'tool_call_proposed': {
        const stepId = `s_${event.seq}`;
        pendingTool.set(turnId, stepId);
        emit(conversationId, 'trail_step', {
          turn_id: turnId,
          step: {
            kind: 'action',
            id: stepId,
            label:
              typeof payload.active_label === 'string'
                ? payload.active_label
                : typeof payload.label === 'string'
                  ? payload.label
                  : 'Working on it',
            meta: '',
            sources: [],
            status: 'running',
          },
        });
        return;
      }
      case 'tool_result': {
        const stepId = pendingTool.get(turnId) ?? `s_${event.seq}`;
        pendingTool.delete(turnId);
        const sources = Array.isArray(payload.sources)
          ? (payload.sources as { app: string; label: string }[])
          : [];
        turnSources.set(turnId, [...(turnSources.get(turnId) ?? []), ...sources]);
        emit(conversationId, 'trail_step_updated', {
          turn_id: turnId,
          step_id: stepId,
          patch: {
            label: typeof payload.label === 'string' ? payload.label : 'Checked something',
            meta: typeof payload.meta === 'string' ? payload.meta : '',
            sources,
            status: 'done',
          },
        });
        return;
      }
      case 'notice': {
        const kind = typeof payload.kind === 'string' ? payload.kind : '';
        if (kind === 'say') {
          emit(conversationId, 'trail_step', {
            turn_id: turnId,
            step: { kind: 'say', id: `s_${event.seq}`, text: substitute(String(payload.title)) },
          });
          return;
        }
        if (kind === 'card') {
          const card = payload.card as Json;
          const primary = card.primary as Json;
          const actionId = typeof primary.action_id === 'string' ? primary.action_id : null;
          const approval = actionId ? approvalFor(actionId) : null;
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'card',
              card: {
                ...card,
                primary: {
                  label: primary.label,
                  icon: primary.icon ?? null,
                  done_label: primary.done_label ?? null,
                  effect: approval
                    ? { kind: 'permission', permission_id: approval.id }
                    : { kind: 'none' },
                },
              },
            },
          });
          return;
        }
        if (kind === 'draft') {
          const draft = payload.draft as Json;
          draftState.set(String(draft.id), {
            status: 'draft',
            body: String(draft.body),
            conversation_id: conversationId,
            turn_id: turnId,
          });
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: { kind: 'draft', draft: { ...draft, status: 'draft' } },
          });
          return;
        }
        if (kind === 'question') {
          const id = `q_${event.seq}`;
          questionState.set(id, { job_id: event.job_id, answered: null });
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'question',
              question: { id, title: payload.title, options: payload.options, answered: null },
            },
          });
          return;
        }
        if (kind === 'browser') {
          if (!browserAvailable) return;
          const browser = payload.browser as Json;
          browserState.set(String(browser.id), {
            job_id: event.job_id,
            status: String(browser.status),
          });
          emit(conversationId, 'block', { turn_id: turnId, block: { kind: 'browser', browser } });
          return;
        }
        if (payload.title === 'Done' || payload.title === 'Cancelled') return;
        if (
          payload.level === 'problem' &&
          typeof payload.title === 'string' &&
          payload.title.includes('unknown')
        ) {
          return; // the unknown block carries this
        }
        emit(conversationId, 'block', {
          turn_id: turnId,
          block: {
            kind: 'notice',
            level: payload.level ?? 'info',
            title: payload.title ?? '',
            body: payload.body ?? '',
          },
        });
        return;
      }
      case 'approval_requested': {
        const block = permissionBlock(String(payload.approval_id), conversationId);
        if (!block) return;
        const standing = rules.find(
          (rule) =>
            (rule.connection as { app: string }).app ===
              (block.connection as { app: string }).app && rule.agent_id === record.agent_id,
        );
        if (standing) {
          // A rule the person created earlier answers this one. The card still
          // says what happened and which rule allowed it.
          alwaysApprovals.add(String(block.id));
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'permission',
              permission: {
                ...block,
                status: 'allowed_always',
                rule_text: `Allowed by your rule: ${String(standing.text)}.`,
              },
            },
          });
          setTimeout(() => {
            void api.request(`/approvals/${String(block.id)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ decision: 'approved', payload_hash: block.payload_hash }),
            });
          }, 400);
          return;
        }
        emit(conversationId, 'block', {
          turn_id: turnId,
          block: { kind: 'permission', permission: block },
        });
        emit(conversationId, 'turn_status', { turn_id: turnId, status: 'waiting' });
        return;
      }
      case 'approval_decided': {
        const block = permissionBlock(String(payload.approval_id), conversationId);
        if (block) {
          emit(conversationId, 'block_updated', {
            turn_id: turnId,
            block_id: block.id,
            patch: { status: block.status },
          });
        }
        return;
      }
      case 'action_status_changed': {
        const action = store.actions.get(String(payload.action_id));
        if (!action) return;
        const kind = humanKind(action.kind);
        const fields = action.canonical_payload as Json;
        if (action.status === 'succeeded') {
          receiptState.set(`rcpt_${action.id}`, { undone: false });
          const when = [formatWhen(fields.when), formatWhen(fields.duration)]
            .filter(Boolean)
            .join(' · ');
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'receipt',
              receipt: {
                id: `rcpt_${action.id}`,
                what: kind.past,
                where: kind.where,
                when: when || 'just now',
                undo: { until: 'the next 10 minutes' },
                undone: false,
              },
            },
          });
          return;
        }
        if (action.status === 'unknown') {
          unknownState.set(action.id, { job_id: event.job_id });
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'unknown',
              unknown: { id: action.id, what: `${kind.verb} (${kind.where})`, resolution: null },
            },
          });
          emit(conversationId, 'turn_status', { turn_id: turnId, status: 'waiting' });
          return;
        }
        if (
          action.status === 'failed' &&
          action.reconciliation &&
          'reason' in action.reconciliation
        ) {
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'error',
              what: `Couldn’t ${kind.verb}.`,
              done_about_it: 'Nothing was sent. Tell me what to change and I will try again.',
            },
          });
        }
        return;
      }
      case 'attempt_ended': {
        const outcome = payload.outcome;
        if (outcome === 'completed') {
          // The text settles here; "done" waits for the job itself to complete,
          // because an unknown action outranks a happy summary.
          const final = turnText.get(turnId) ?? '';
          const answer = typeof payload.answer === 'string' ? payload.answer : '';
          const text = final || substitute(answer);
          turnText.set(turnId, text);
          emit(conversationId, 'text_final', { turn_id: turnId, text });
          return;
        }
        if (outcome === 'failed') {
          emit(conversationId, 'text_final', { turn_id: turnId, text: turnText.get(turnId) ?? '' });
          emit(conversationId, 'block', {
            turn_id: turnId,
            block: {
              kind: 'error',
              what: 'I stopped without finishing.',
              done_about_it:
                typeof payload.reason === 'string' ? payload.reason : 'Here is how far I got.',
            },
          });
          emit(conversationId, 'turn_status', {
            turn_id: turnId,
            status: 'failed',
            ended_at: event.created_at,
          });
          return;
        }
        if (outcome === 'waiting_for_input' || outcome === 'waiting_for_approval') {
          emit(conversationId, 'turn_status', { turn_id: turnId, status: 'waiting' });
        }
        return;
      }
      case 'job_state_changed': {
        if (payload.to === 'completed') {
          const started = turnStarted.get(turnId) ?? event.created_at;
          emit(conversationId, 'trail_step', {
            turn_id: turnId,
            step: {
              kind: 'done',
              id: `s_${event.seq}`,
              summary: doneSummary(turnId, started, event.created_at),
            },
          });
          emit(conversationId, 'turn_status', {
            turn_id: turnId,
            status: 'done',
            ended_at: event.created_at,
          });
        }
        if (payload.to === 'cancelled') {
          emit(conversationId, 'text_final', { turn_id: turnId, text: turnText.get(turnId) ?? '' });
          emit(conversationId, 'turn_status', {
            turn_id: turnId,
            status: 'stopped',
            ended_at: event.created_at,
          });
        }
        if (payload.to === 'needs_reconciliation') {
          emit(conversationId, 'turn_status', { turn_id: turnId, status: 'waiting' });
        }
        return;
      }
      default:
        return;
    }
  };
  store.subscribe(onJobEvent);

  const summary = (record: ConversationRecord): Json => ({
    id: record.id,
    title: record.title,
    agent_id: record.agent_id,
    preview: record.preview,
    updated_at: record.updated_at,
    pinned: record.pinned,
  });

  const latestJob = (record: ConversationRecord) => {
    const id = record.job_ids[record.job_ids.length - 1];
    return id ? (store.jobs.get(id) ?? null) : null;
  };

  const createJob = async (title: string, objective: string) => {
    const response = await api.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ space_id: spaceId, title: title.slice(0, 80), objective }),
    });
    const body = (await response.json()) as { job?: { id: string }; error?: { message: string } };
    if (!response.ok || !body.job)
      throw new Error(body.error?.message ?? 'could not start the job');
    return body.job.id;
  };

  /** Register the job before creating it, so its first event maps to the conversation. */
  const startTurn = async (record: ConversationRecord, text: string, title = record.title) => {
    // The job id is only known after creation; map by subscribing for the
    // next job_created and binding it to this conversation.
    let bound = false;
    const unsubscribe = store.subscribe((event) => {
      if (bound || event.type !== 'job_created' || !event.job_id) return;
      bound = true;
      jobToConversation.set(event.job_id, record.id);
      record.job_ids.push(event.job_id);
      // The mapper saw this event before the binding existed; replay it now.
      onJobEvent(event);
    });
    // Bind before the runner appends: store.subscribe fires synchronously in
    // append order, and the binding subscriber was added first.
    try {
      const jobId = await createJob(title, text);
      unsubscribe();
      if (!jobToConversation.has(jobId)) {
        jobToConversation.set(jobId, record.id);
        record.job_ids.push(jobId);
      }
      return jobId;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  };

  const newConversation = (
    title: string,
    agentId: string | null,
    preview: string,
  ): ConversationRecord => {
    const record: ConversationRecord = {
      id: newId('conv'),
      title,
      agent_id: agentId,
      pinned: false,
      preview,
      created_at: now(),
      updated_at: now(),
      job_ids: [],
      deleted: false,
    };
    conversations.set(record.id, record);
    return record;
  };

  const titleFor = (text: string): string => {
    const lower = text.toLowerCase();
    if (lower.includes('dinner')) return 'Dinner with friends';
    if (lower.includes('kyoto') || lower.includes('japan')) return 'Kyoto in October';
    if (lower.includes('passport')) return 'Passport renewal';
    if (lower.includes('launch') || lower.includes('pricing')) return 'Pricing page launch';
    const clean = text.replace(/[.!?].*$/, '').trim();
    return clean.length > 42 ? `${clean.slice(0, 40)}…` : clean || 'New chat';
  };

  // ------------------------------------------------------------------
  // routes
  // ------------------------------------------------------------------

  const fail = (status: 400 | 404 | 409, message: string) =>
    Response.json({ error: { code: 'experience', message } }, { status });

  const body = async <T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<z.infer<T> | null> => {
    try {
      const raw: unknown = await request.json();
      const parsed = schema.safeParse(raw ?? {});
      return parsed.success ? parsed.data : null;
    } catch {
      const parsed = schema.safeParse({});
      return parsed.success ? parsed.data : null;
    }
  };

  const session = () => ({
    signed_in: state.signedIn,
    onboarded: state.onboarded,
    profile: state.signedIn ? state.profile : null,
  });

  app.get('/capabilities', (c) =>
    c.json({
      browser: browserAvailable ? 'available' : 'unavailable',
      oauth_google: 'available',
      oauth_apple: 'unavailable',
      magic_link: 'available',
      voice: 'unavailable',
      attachments: 'available',
      tour_stages: browserAvailable
        ? ['calendar', 'drafting', 'browser', 'plans', 'memory']
        : ['calendar', 'drafting', 'plans', 'memory'],
    }),
  );

  app.get('/session', (c) => c.json(session()));
  app.post('/session/sign-in', async (c) => {
    const parsed = await body(c.req.raw, z.object({ email: z.string().email() }));
    if (!parsed) return fail(400, 'Enter an email address to send the link to.');
    state.profile.email = parsed.email;
    return c.json({ sent: true });
  });
  app.post('/session/complete', async (c) => {
    const parsed = await body(c.req.raw, z.object({ email: z.string().email().optional() }));
    if (parsed?.email) state.profile.email = parsed.email;
    state.signedIn = true;
    return c.json(session());
  });
  app.post('/session/oauth', async (c) => {
    const parsed = await body(c.req.raw, z.object({ provider: z.enum(['google', 'apple']) }));
    if (!parsed || parsed.provider === 'apple')
      return fail(409, 'That sign-in method is not available on this instance.');
    state.signedIn = true;
    return c.json(session());
  });
  app.post('/session/sign-out', (c) => {
    state.signedIn = false;
    return c.json(session());
  });
  app.post('/session/profile', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        name: z.string().optional(),
        short_name: z.string().optional(),
        timezone: z.string().optional(),
        day_start: z.string().optional(),
        day_end: z.string().optional(),
        morning_brief: z.boolean().optional(),
      }),
    );
    if (!parsed) return fail(400, 'Could not read the profile.');
    Object.assign(
      state.profile,
      Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)),
    );
    return c.json(session());
  });

  app.post('/onboarding/answers', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        answers: z.array(z.object({ key: z.string().min(1), value: z.string().min(1) })),
      }),
    );
    if (!parsed) return fail(400, 'Could not read the answers.');
    const items: Json[] = [];
    for (const answer of parsed.answers) {
      const existing = memory.find((m) => m.key === answer.key && m.source === 'onboarding');
      if (existing) {
        existing.value = answer.value;
        items.push(existing);
        continue;
      }
      const item = {
        id: newId('mem'),
        key: answer.key,
        value: answer.value,
        source: 'onboarding',
        created: 'today',
        last_used: null,
        why: 'You told Melete this during setup.',
      };
      memory.push(item);
      items.push(item);
    }
    return c.json({ items });
  });

  app.post('/onboarding/complete', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        agent_id: z.string().nullable().default(null),
        first_message: z.string().nullable().default(null),
      }),
    );
    if (!parsed) return fail(400, 'Could not finish setup.');
    state.signedIn = true;
    state.onboarded = true;
    let conversationId: string | null = null;
    const record = newConversation('New chat', parsed.agent_id, 'Setting up');
    await startTurn(record, '__welcome__', 'Welcome');
    conversationId = record.id;
    return c.json({ session: session(), conversation_id: conversationId });
  });

  app.get('/home', (c) => {
    const hour = today().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return c.json({
      greeting: `${greeting}, ${state.profile.short_name}`,
      date_line: `${dayPanel().today} · ${state.profile.space}`,
      prompts: [
        {
          label: 'Plan my day',
          icon: 'calendar',
          text: 'Plan my day around what is already on the calendar.',
        },
        { label: 'Explore an idea', icon: 'sparkles', text: 'Help me think through an idea.' },
        {
          label: 'Plan a trip',
          icon: 'compass',
          text: 'Plan a trip: two weeks in Japan, slow pace.',
        },
      ],
      recent: [...conversations.values()]
        .filter((r) => !r.deleted)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 5)
        .map(summary),
      files,
    });
  });

  app.get('/day', (c) => c.json(dayPanel()));
  app.post('/day/tasks', async (c) => {
    const parsed = await body(c.req.raw, z.object({ text: z.string().min(1) }));
    if (!parsed) return fail(400, 'A task needs a few words.');
    tasks.push({ id: newId('task'), text: parsed.text, done: false });
    return c.json(dayPanel());
  });
  app.post('/day/tasks/:id', async (c) => {
    const parsed = await body(c.req.raw, z.object({ done: z.boolean() }));
    const task = tasks.find((t) => t.id === c.req.param('id'));
    if (!task || !parsed) return fail(404, 'No such task.');
    task.done = parsed.done;
    return c.json(dayPanel());
  });

  app.get('/conversations', (c) =>
    c.json({
      conversations: [...conversations.values()]
        .filter((r) => !r.deleted)
        .sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
        )
        .map(summary),
    }),
  );

  app.post('/conversations', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        text: z.string().min(1),
        agent_id: z.string().nullable().default(null),
        plan_id: z.string().optional(),
      }),
    );
    if (!parsed) return fail(400, 'Say what you want done.');
    const record = newConversation(titleFor(parsed.text), parsed.agent_id, parsed.text);
    try {
      await startTurn(record, parsed.text);
    } catch (error) {
      return fail(409, error instanceof Error ? error.message : 'Could not start.');
    }
    return c.json(
      {
        conversation: {
          ...summary(record),
          events: events.filter((e) => e.conversation_id === record.id),
        },
      },
      201,
    );
  });

  app.get('/conversations/:id', (c) => {
    const record = conversations.get(c.req.param('id'));
    if (!record || record.deleted) return fail(404, 'That chat is gone.');
    return c.json({
      ...summary(record),
      events: events.filter((e) => e.conversation_id === record.id),
    });
  });

  app.get('/conversations/:id/events', (c) => {
    const record = conversations.get(c.req.param('id'));
    if (!record || record.deleted) return fail(404, 'That chat is gone.');
    const header = c.req.raw.headers.get('last-event-id');
    const after =
      header && /^\d+$/.test(header) ? Number(header) : Number(c.req.query('after') ?? 0) || 0;
    const encoder = new TextEncoder();
    let release: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const push = (event: ConversationEvent) => {
          if (!open) return;
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          } catch {
            open = false;
          }
        };
        for (const event of events) {
          if (event.conversation_id === record.id && event.seq > after) push(event);
        }
        const subscriber = (event: ConversationEvent) => {
          if (event.conversation_id === record.id) push(event);
        };
        subscribers.add(subscriber);
        const keepalive = setInterval(() => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(SSE_KEEPALIVE));
          } catch {
            open = false;
          }
        }, 20_000);
        release = () => {
          open = false;
          subscribers.delete(subscriber);
          clearInterval(keepalive);
        };
      },
      cancel() {
        release?.();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  });

  app.post('/conversations/:id/messages', async (c) => {
    const record = conversations.get(c.req.param('id'));
    if (!record || record.deleted) return fail(404, 'That chat is gone.');
    const parsed = await body(c.req.raw, z.object({ text: z.string().min(1) }));
    if (!parsed) return fail(400, 'Type a message first.');
    const job = latestJob(record);
    if (job?.state === 'waiting_for_input') {
      const response = await api.request(`/jobs/${job.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: parsed.text }),
      });
      if (!response.ok) return fail(409, 'That question was already answered.');
      for (const [id, q] of questionState) {
        if (q.job_id === job.id && q.answered === null) {
          q.answered = parsed.text;
          emit(record.id, 'block_updated', {
            turn_id: job.id,
            block_id: id,
            patch: { answered: parsed.text },
          });
        }
      }
      return c.json({ conversation: summary(record) });
    }
    try {
      await startTurn(record, parsed.text);
    } catch (error) {
      return fail(409, error instanceof Error ? error.message : 'Could not send.');
    }
    return c.json({ conversation: summary(record) });
  });

  app.post('/conversations/:id/pause', (c) => {
    const record = conversations.get(c.req.param('id'));
    const job = record ? latestJob(record) : null;
    if (!record || !job) return fail(404, 'Nothing is running.');
    runner.pauseJob(job.id);
    emit(record.id, 'turn_status', { turn_id: job.id, status: 'paused' });
    return c.json({ ok: true });
  });
  app.post('/conversations/:id/resume', (c) => {
    const record = conversations.get(c.req.param('id'));
    const job = record ? latestJob(record) : null;
    if (!record || !job) return fail(404, 'Nothing is paused.');
    runner.resumeJob(job.id);
    emit(record.id, 'turn_status', { turn_id: job.id, status: 'running' });
    return c.json({ ok: true });
  });
  app.post('/conversations/:id/stop', async (c) => {
    const record = conversations.get(c.req.param('id'));
    const job = record ? latestJob(record) : null;
    if (!record || !job) return fail(404, 'Nothing is running.');
    runner.resumeJob(job.id);
    const response = await api.request(`/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Stopped by the owner.' }),
    });
    if (!response.ok) return fail(409, 'That turn had already finished.');
    return c.json({ ok: true });
  });
  app.post('/conversations/:id/agent', async (c) => {
    const record = conversations.get(c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ agent_id: z.string().nullable() }));
    if (!record || !parsed) return fail(404, 'That chat is gone.');
    record.agent_id = parsed.agent_id;
    return c.json({ conversation: summary(record) });
  });
  app.post('/conversations/:id/reactions', async (c) => {
    const record = conversations.get(c.req.param('id'));
    const parsed = await body(
      c.req.raw,
      z.object({ turn_id: z.string(), reaction: z.enum(['up', 'down']).nullable() }),
    );
    if (!record || !parsed) return fail(404, 'That chat is gone.');
    emit(record.id, 'reaction', { turn_id: parsed.turn_id, reaction: parsed.reaction });
    return c.json({ ok: true });
  });
  app.post('/conversations/:id/rename', async (c) => {
    const record = conversations.get(c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ title: z.string().min(1) }));
    if (!record || !parsed) return fail(404, 'That chat is gone.');
    record.title = parsed.title;
    return c.json({ conversation: summary(record) });
  });
  app.post('/conversations/:id/pin', async (c) => {
    const record = conversations.get(c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ pinned: z.boolean() }));
    if (!record || !parsed) return fail(404, 'That chat is gone.');
    record.pinned = parsed.pinned;
    return c.json({ conversation: summary(record) });
  });
  app.delete('/conversations/:id', (c) => {
    const record = conversations.get(c.req.param('id'));
    if (!record) return fail(404, 'That chat is gone.');
    record.deleted = true;
    return c.json({ ok: true });
  });

  app.post('/permissions/:id', async (c) => {
    const approvalId = c.req.param('id');
    const parsed = await body(
      c.req.raw,
      z.object({ decision: z.enum(['allow_once', 'always', 'deny']), payload_hash: z.string() }),
    );
    if (!parsed) return fail(400, 'Could not read the decision.');
    const approval = store.approvals.get(approvalId);
    if (!approval) return fail(404, 'That request is gone.');
    if (parsed.decision === 'always') alwaysApprovals.add(approvalId);
    const response = await api.request(`/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: parsed.decision === 'deny' ? 'denied' : 'approved',
        payload_hash: parsed.payload_hash,
      }),
    });
    if (!response.ok) {
      alwaysApprovals.delete(approvalId);
      const failure = (await response.json()) as { error?: { code?: string } };
      const action = store.actions.get(approval.action_id);
      const conversationId = action ? jobToConversation.get(action.job_id) : null;
      if (failure.error?.code === 'approval_hash_mismatch' && conversationId && action) {
        emit(conversationId, 'block_updated', {
          turn_id: action.job_id,
          block_id: approvalId,
          patch: { status: 'changed' },
        });
        return fail(
          409,
          'This changed while you were reading it. Take another look and decide again.',
        );
      }
      return fail(409, 'That was already decided.');
    }
    if (parsed.decision === 'always') {
      const action = store.actions.get(approval.action_id);
      const kind = humanKind(action?.kind ?? '');
      const conversationId = action ? jobToConversation.get(action.job_id) : null;
      const record = conversationId ? conversations.get(conversationId) : null;
      rules.push({
        id: newId('rule'),
        text: `${agentName(record?.agent_id ?? null)} may ${kind.verb} without asking`,
        connection: { app: kind.app, label: kind.label },
        agent_id: record?.agent_id ?? null,
        created: 'today',
      });
    }
    return c.json({ ok: true });
  });

  app.post('/receipts/:id/undo', (c) => {
    const id = c.req.param('id');
    const receipt = receiptState.get(id);
    const action = store.actions.get(id.replace(/^rcpt_/, ''));
    if (!receipt || !action) return fail(404, 'Nothing to undo.');
    if (receipt.undone) return fail(409, 'Already undone.');
    receipt.undone = true;
    const conversationId = jobToConversation.get(action.job_id);
    if (conversationId) {
      emit(conversationId, 'block_updated', {
        turn_id: action.job_id,
        block_id: id,
        patch: { undone: true, undo: null },
      });
    }
    return c.json({ ok: true });
  });

  app.post('/drafts/:id/send', (c) => {
    const draft = draftState.get(c.req.param('id'));
    if (!draft) return fail(404, 'That draft is gone.');
    draft.status = 'sent';
    emit(draft.conversation_id, 'block_updated', {
      turn_id: draft.turn_id,
      block_id: c.req.param('id'),
      patch: { status: 'sent' },
    });
    const receiptId = `sent_${c.req.param('id')}`;
    emit(draft.conversation_id, 'block', {
      turn_id: draft.turn_id,
      block: {
        kind: 'receipt',
        receipt: {
          id: receiptId,
          what: 'Sent via Messages',
          where: 'Messages',
          when: 'just now',
          undo: null,
          undone: false,
        },
      },
    });
    return c.json({ ok: true });
  });
  app.post('/drafts/:id', async (c) => {
    const draft = draftState.get(c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ body: z.string().min(1) }));
    if (!draft || !parsed) return fail(404, 'That draft is gone.');
    draft.body = parsed.body;
    emit(draft.conversation_id, 'block_updated', {
      turn_id: draft.turn_id,
      block_id: c.req.param('id'),
      patch: { body: parsed.body },
    });
    return c.json({ ok: true });
  });

  app.post('/questions/:id/answer', async (c) => {
    const question = questionState.get(c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ text: z.string().min(1) }));
    if (!question || !parsed) return fail(404, 'That question is gone.');
    if (question.answered !== null) return fail(409, 'That question was already answered.');
    const response = await api.request(`/jobs/${question.job_id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: parsed.text }),
    });
    if (!response.ok) return fail(409, 'That question was already answered.');
    question.answered = parsed.text;
    const conversationId = jobToConversation.get(question.job_id);
    if (conversationId) {
      emit(conversationId, 'block_updated', {
        turn_id: question.job_id,
        block_id: c.req.param('id'),
        patch: { answered: parsed.text },
      });
    }
    return c.json({ ok: true });
  });

  app.post('/unknown/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const entry = unknownState.get(id);
    const parsed = await body(
      c.req.raw,
      z.object({
        resolution: z.enum(['succeeded', 'failed', 'unresolved']),
        note: z.string().default(''),
      }),
    );
    if (!entry || !parsed) return fail(404, 'Nothing to settle.');
    const response = await api.request(`/actions/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolution: parsed.resolution, note: parsed.note }),
    });
    if (!response.ok) return fail(409, 'That was already settled.');
    const conversationId = jobToConversation.get(entry.job_id);
    if (conversationId) {
      emit(conversationId, 'block_updated', {
        turn_id: entry.job_id,
        block_id: id,
        patch: { resolution: parsed.resolution },
      });
    }
    return c.json({ ok: true });
  });

  const browserPatch = (id: string, patch: Json) => {
    const entry = browserState.get(id);
    if (!entry) return null;
    const conversationId = jobToConversation.get(entry.job_id);
    if (typeof patch.status === 'string') entry.status = patch.status;
    if (conversationId)
      emit(conversationId, 'block_updated', { turn_id: entry.job_id, block_id: id, patch });
    return entry;
  };
  app.post('/browser/:id/take-control', (c) => {
    const entry = browserState.get(c.req.param('id'));
    if (!entry) return fail(404, 'No browser session.');
    runner.pauseJob(entry.job_id);
    browserPatch(c.req.param('id'), {
      status: 'needs-you',
      attention: 'You have the browser. Hand it back when you are done.',
    });
    return c.json({ ok: true });
  });
  app.post('/browser/:id/hand-back', (c) => {
    const entry = browserState.get(c.req.param('id'));
    if (!entry) return fail(404, 'No browser session.');
    runner.resumeJob(entry.job_id);
    browserPatch(c.req.param('id'), { status: 'working', attention: null });
    return c.json({ ok: true });
  });
  app.post('/browser/:id/stop', async (c) => {
    const entry = browserState.get(c.req.param('id'));
    if (!entry) return fail(404, 'No browser session.');
    runner.resumeJob(entry.job_id);
    browserPatch(c.req.param('id'), { status: 'stopped', attention: null });
    await api.request(`/jobs/${entry.job_id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Stopped the browser task.' }),
    });
    return c.json({ ok: true });
  });

  const planProgress = (plan: Json) => {
    const milestones = plan.milestones as { done: boolean }[];
    plan.progress = milestones.length
      ? Math.round((milestones.filter((m) => m.done).length / milestones.length) * 100)
      : 0;
    const next = milestones.find((m) => !m.done) as { text: string } | undefined;
    plan.next_step = next?.text ?? 'All milestones done';
    plan.updated_at = 'just now';
  };
  app.get('/plans', (c) => c.json({ plans, templates: planTemplates }));
  app.get('/plans/:id', (c) => {
    const plan = plans.find((p) => p.id === c.req.param('id'));
    return plan ? c.json(plan) : fail(404, 'No such plan.');
  });
  app.post('/plans', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        title: z.string().min(1),
        category: z.enum(['travel', 'wellbeing', 'learning', 'finance']).default('wellbeing'),
        why: z.string().default(''),
      }),
    );
    if (!parsed) return fail(400, 'A plan needs a title.');
    const plan: Json = {
      id: newId('plan'),
      title: parsed.title,
      description: parsed.why,
      category: parsed.category,
      next_step: 'Add the first milestone',
      progress: 0,
      status: 'in_progress',
      milestones: [],
      linked: [],
      updated_at: 'just now',
      needs_you: null,
    };
    plans.unshift(plan);
    return c.json({ plan }, 201);
  });
  app.post('/plans/:id/milestones', async (c) => {
    const plan = plans.find((p) => p.id === c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ text: z.string().min(1) }));
    if (!plan || !parsed) return fail(404, 'No such plan.');
    (plan.milestones as Json[]).push({
      id: newId('ms'),
      text: parsed.text,
      done: false,
      assignee: null,
    });
    planProgress(plan);
    return c.json(plan);
  });
  app.post('/plans/:id/milestones/:mid', async (c) => {
    const plan = plans.find((p) => p.id === c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ done: z.boolean() }));
    const milestone = (plan?.milestones as Json[] | undefined)?.find(
      (m) => m.id === c.req.param('mid'),
    );
    if (!plan || !parsed || !milestone) return fail(404, 'No such milestone.');
    milestone.done = parsed.done;
    planProgress(plan);
    return c.json(plan);
  });
  app.post('/plans/:id/complete', (c) => {
    const plan = plans.find((p) => p.id === c.req.param('id'));
    if (!plan) return fail(404, 'No such plan.');
    plan.status = 'completed';
    for (const m of plan.milestones as Json[]) m.done = true;
    planProgress(plan);
    return c.json(plan);
  });

  app.get('/agents', (c) => c.json({ agents, templates: agentTemplates }));
  app.post('/agents', async (c) => {
    const parsed = await body(
      c.req.raw,
      z.object({
        id: z.string().nullable().default(null),
        name: z.string().min(1),
        role: z.string().min(1),
        blurb: z.string().default(''),
        look: z.object({
          color: z.string(),
          eyes: z.enum(['white', 'black', 'none']),
          shape: z.enum(['square', 'blob', 'diamond', 'octagon', 'gear']),
          image: z.string().nullable().optional(),
        }),
        tone: z.enum(['warm', 'direct', 'playful']),
        standing_instruction: z.string().default(''),
        allowed_connections: z.array(z.string()).default([]),
        asks_before_acting: z.boolean().default(true),
        reaches: z.array(z.string()).default([]),
      }),
    );
    if (!parsed) return fail(400, 'An agent needs a name and a role.');
    const existing = parsed.id ? agents.find((a) => a.id === parsed.id) : null;
    if (existing) {
      Object.assign(existing, {
        ...parsed,
        id: existing.id,
        look: { image: null, ...parsed.look },
      });
      return c.json({ agent: existing });
    }
    const agent = {
      ...parsed,
      id: newId('agent').toLowerCase(),
      look: { image: null, ...parsed.look },
      stats: { chats: 0, last_used: null },
    };
    agents.push(agent);
    return c.json({ agent }, 201);
  });
  app.delete('/agents/:id', (c) => {
    const index = agents.findIndex((a) => a.id === c.req.param('id'));
    if (index === -1) return fail(404, 'No such agent.');
    agents.splice(index, 1);
    return c.json({ ok: true });
  });

  app.get('/automations', (c) => c.json({ automations }));
  app.post('/automations/:id', async (c) => {
    const automation = automations.find((a) => a.id === c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ enabled: z.boolean() }));
    if (!automation || !parsed) return fail(404, 'No such routine.');
    automation.enabled = parsed.enabled;
    automation.next_run = parsed.enabled
      ? `Next run ${String(automation.trigger).replace(/^Every /, 'next ')}`
      : 'Off';
    return c.json(automation);
  });
  app.post('/automations/:id/test-run', (c) => {
    const automation = automations.find((a) => a.id === c.req.param('id'));
    if (!automation) return fail(404, 'No such routine.');
    const run: Json = { id: newId('run'), status: 'running', when: 'Just now', note: 'test run' };
    (automation.runs as Json[]).unshift(run);
    setTimeout(() => {
      run.status = 'ok';
    }, 2500);
    return c.json(automation);
  });
  app.post('/automations/:id/runs/:rid/retry', (c) => {
    const automation = automations.find((a) => a.id === c.req.param('id'));
    const run = (automation?.runs as Json[] | undefined)?.find((r) => r.id === c.req.param('rid'));
    if (!automation || !run) return fail(404, 'No such run.');
    run.status = 'running';
    run.note = 'retrying';
    setTimeout(() => {
      run.status = 'ok';
      run.note = '';
    }, 2500);
    return c.json(automation);
  });

  app.get('/memory', (c) => c.json({ items: memory }));
  app.post('/memory/:id', async (c) => {
    const item = memory.find((m) => m.id === c.req.param('id'));
    const parsed = await body(c.req.raw, z.object({ value: z.string().min(1) }));
    if (!item || !parsed) return fail(404, 'No such item.');
    item.value = parsed.value;
    return c.json(item);
  });
  app.delete('/memory/:id', (c) => {
    const index = memory.findIndex((m) => m.id === c.req.param('id'));
    if (index === -1) return fail(404, 'No such item.');
    memory.splice(index, 1);
    return c.json({ ok: true });
  });

  app.get('/connections', (c) => c.json({ connections }));
  app.post('/connections/:id/connect', (c) => {
    const connection = connections.find((x) => x.id === c.req.param('id'));
    if (!connection) return fail(404, 'No such connection.');
    connection.state = 'connecting';
    connection.error = null;
    setTimeout(() => {
      connection.state = 'connected';
    }, 1400);
    return c.json(connection);
  });
  app.post('/connections/:id/disconnect', (c) => {
    const connection = connections.find((x) => x.id === c.req.param('id'));
    if (!connection) return fail(404, 'No such connection.');
    connection.state = 'available';
    connection.error = null;
    return c.json(connection);
  });

  app.get('/rules', (c) => c.json({ rules }));
  app.delete('/rules/:id', (c) => {
    const index = rules.findIndex((r) => r.id === c.req.param('id'));
    if (index === -1) return fail(404, 'No such rule.');
    rules.splice(index, 1);
    return c.json({ ok: true });
  });

  app.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').toLowerCase().trim();
    const hits: Json[] = [];
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    for (const record of conversations.values()) {
      if (!record.deleted && match(`${record.title} ${record.preview}`)) {
        hits.push({
          kind: 'chat',
          id: record.id,
          title: record.title,
          meta: record.preview,
          href: `/chat/${record.id}`,
        });
      }
    }
    for (const plan of plans) {
      if (match(String(plan.title)))
        hits.push({
          kind: 'plan',
          id: plan.id,
          title: plan.title,
          meta: plan.next_step,
          href: `/plans/${plan.id}`,
        });
    }
    for (const task of tasks) {
      if (match(String(task.text)))
        hits.push({
          kind: 'task',
          id: task.id,
          title: task.text,
          meta: task.done ? 'Done' : 'Open',
          href: '/',
        });
    }
    for (const event of dayPanel().events as Json[]) {
      if (match(String(event.title)))
        hits.push({
          kind: 'event',
          id: event.id,
          title: event.title,
          meta: `${event.day || 'Today'} ${event.time} · ${event.duration}`,
          href: '/',
        });
    }
    for (const connection of connections) {
      if (match(String(connection.name)))
        hits.push({
          kind: 'connection',
          id: connection.id,
          title: connection.name,
          meta: connection.state,
          href: '/settings/connections',
        });
    }
    hits.push({ kind: 'action', id: 'new-chat', title: 'New chat', meta: '', href: '/chat/new' });
    hits.push({
      kind: 'action',
      id: 'new-plan',
      title: 'New plan',
      meta: '',
      href: '/plans?new=1',
    });
    return c.json({ hits: hits.slice(0, 12) });
  });

  // ------------------------------------------------------------------
  // seed conversations, so the first screen has a history
  // ------------------------------------------------------------------

  const seedConversations = async () => {
    const kyoto = newConversation(
      'Kyoto in October',
      'nova',
      'Help me plan two weeks in Japan, slow pace.',
    );
    await startTurn(kyoto, 'Help me plan two weeks in Japan, slow pace.');
    const passport = newConversation(
      'Passport renewal',
      null,
      'Which documents do I need to renew in person?',
    );
    await startTurn(passport, 'Which documents do I need to renew in person?');
    (plans[0] as Json).linked = [
      { kind: 'chat', id: kyoto.id, title: 'Kyoto in October', sub: 'Chat · yesterday' },
      { kind: 'file', id: 'kyoto-notes', title: 'kyoto-notes.md', sub: 'File · 4 KB' },
    ];
  };
  return { app, seed: seedConversations };
}
