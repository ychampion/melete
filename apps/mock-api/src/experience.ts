import * as C from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { AGENT_TEMPLATES } from '../../melete/src/experience/agents.ts';
import { dayGreeting } from '../../melete/src/experience/home.ts';
import { scheduleSentence } from '../../melete/src/experience/planning.ts';
import {
  type ActionRow,
  answerText,
  appName,
  plainText,
  projectActionGroup,
  projectCards,
} from '../../melete/src/experience/projectors.ts';
import type { AppDeps } from './app.ts';
import { chooseScenario, type Scenario } from './scenario.ts';
import { newId } from './store.ts';

type Turn = ReturnType<typeof C.conversationTurn.parse>;
type Question = ReturnType<typeof C.experienceQuestion.parse>;
type Plan = ReturnType<typeof C.experiencePlan.parse>;
type Chat = {
  view: C.Conversation;
  turns: Turn[];
  /** The store seq of each person message, keyed by turn id, so the agent can react to it. */
  messageSeqs: Map<string, number>;
  events: C.ExperienceEvent[];
  cards: C.ResultCard[];
  receipts: C.ExperienceReceipt[];
  drafts: C.ExperienceDraft[];
  script?: Scenario;
  position: number;
  pending: { action: ActionRow; connection: { id: string; label: string; provider: string } }[];
  timer?: ReturnType<typeof setTimeout>;
  paused: boolean;
  stopped: boolean;
  /** Effects a scenario proposed, keyed by the scenario's ref, awaiting or holding a decision. */
  proposals: Map<string, Proposal>;
  /** The last card a scenario drew, which a following proposal shows as its preview. */
  lastCard: C.ResultCard | null;
};
type Proposal = {
  ref: string;
  kind: string;
  payload: Record<string, unknown>;
  what: string;
  where: string;
  decision: 'allow_once' | 'always' | 'deny' | null;
  onDenied: string | null;
  permissionId: string | null;
  /** The connection the effect goes through; the ledger action names it. */
  connectionId: string;
};

/** Human words for the apps a scenario's evidence names. Never a tool name. */
const SOURCE_APPS: Record<string, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
  gmaps: 'Google Maps',
  whatsapp: 'WhatsApp',
  imessage: 'Messages',
  slack: 'Slack',
  notion: 'Notion',
  gdrive: 'Google Drive',
  linear: 'Linear',
  google: 'Google',
  reddit: 'Reddit',
  yelp: 'Yelp',
  youtube: 'YouTube',
  tripadvisor: 'Tripadvisor',
  globe: 'Web',
  web: 'Web',
};
const SOURCE_KINDS: Record<string, C.ExperienceSource['kind']> = {
  gcal: 'event',
  imessage: 'draft',
  whatsapp: 'draft',
  gdrive: 'file',
  notion: 'page',
};
/** What a proposed change is, in the person's words, by the kind of change. */
const PROPOSAL_WORDS: Record<string, { what: string; where: string; reversible: boolean }> = {
  'calendar.event.create': {
    what: 'Add an event to your calendar',
    where: 'Google Calendar',
    reversible: true,
  },
  'browser.reserve': { what: 'Hold a table through the browser', where: 'Resy', reversible: false },
};

class MockExperienceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
const required = <T>(map: Map<string, T>, id: string): T => {
  const value = map.get(id);
  if (!value) throw new MockExperienceError(404, 'This item is no longer available.');
  return value;
};

/** Scenario records go through the same deterministic presentation functions as real rows. */
export class ExperienceMock {
  readonly agents = new Map<string, C.ExperienceAgent>();
  readonly chats = new Map<string, Chat>();
  readonly permissions = new Map<string, C.PermissionCard>();
  readonly permissionDrafts = new Map<string, string>();
  readonly decisions = new Map<
    string,
    { version: string; result: ReturnType<typeof C.permissionOutcome.parse> }
  >();
  readonly sentReceipts = new Map<string, C.ExperienceReceipt>();
  readonly rules = new Map<string, C.StandingRule>();
  readonly questions = new Map<string, Question>();
  readonly plans = new Map<string, Plan>();
  readonly tasks = new Map<string, ReturnType<typeof C.experienceTask.parse>>();
  readonly automations = new Map<string, ReturnType<typeof C.experienceAutomation.parse>>();
  readonly memories = new Map<string, ReturnType<typeof C.memoryItem.parse>>();
  readonly submissions = new Map<
    string,
    { text: string; result: ReturnType<typeof C.messageAcceptance.parse> }
  >();
  profile = C.profileInput.parse({
    name: 'Alex',
    time_zone: 'UTC',
    day_hours: { start: '08:00', end: '22:00' },
  });
  constructor(readonly deps: AppDeps & { experienceSpeed?: number }) {
    const allowed = [...deps.store.connections.values()]
      .filter((row) => row.space_id === deps.spaceId)
      .map((row) => row.id);
    for (const template of AGENT_TEMPLATES.templates) {
      const agent = C.experienceAgent.parse({
        ...template.agent,
        id: newId('agent'),
        space_id: deps.spaceId,
        allowed_connection_ids: allowed,
        usage: { conversations: 0, last_used: null },
      });
      this.agents.set(agent.id, agent);
    }
    for (const entry of deps.store.knowledge.values()) {
      if (entry.space_id !== deps.spaceId || entry.frontmatter.status !== 'active') continue;
      this.memories.set(
        entry.id,
        C.memoryItem.parse({
          id: entry.id,
          key: plainText(entry.frontmatter.title, 'Saved detail'),
          value: plainText(entry.body, 'Saved detail'),
          source: entry.frontmatter.asserted_by === 'user' ? 'conversation' : 'inferred',
          created: this.now(),
          last_used: null,
          editable: true,
          version: newId('v'),
        }),
      );
    }
  }
  /** Permissions raised by scenario proposals, so a decision knows where to go back to. */
  readonly permissionProposals = new Map<string, { chatId: string; ref: string }>();
  /** Receipts whose change can still be reversed, by receipt id. */
  readonly undoable = new Map<string, { chatId: string; what: string }>();
  /**
   * Effects the connector never confirmed. They rest in the store's ledger at
   * `unknown` and are settled through the broker's resolve route; the chat
   * they belong to waits until then.
   */
  readonly unknownActions = new Map<
    string,
    { chatId: string; draftId: string | null; resume: boolean }
  >();
  /** Calendar events the seed placed, for the home panel. */
  readonly calendarEvents: ReturnType<typeof C.experienceCalendarEvent.parse>[] = [];
  now() {
    return this.deps.store.now().toISOString();
  }
  /** The connection scripted evidence is attributed to: the calendar when seeded, else any. */
  evidenceConnection() {
    const rows = [...this.deps.store.connections.values()].filter(
      (row) => row.space_id === this.deps.spaceId,
    );
    return rows.find((row) => row.provider === 'caldav') ?? rows[0] ?? null;
  }
  isDraftKind(kind: string, payload: Record<string, unknown>) {
    return (
      kind === 'email.send' ||
      kind === 'email.draft' ||
      (kind === 'test.write' && typeof payload.body === 'string')
    );
  }
  /** Reverse a receipt while its undo is valid. The reversal has its own receipt. */
  undo(id: string) {
    const entry = this.undoable.get(id);
    const chat = entry ? this.chats.get(entry.chatId) : undefined;
    const receipt = chat?.receipts.find((row) => row.id === id);
    if (!entry || !chat || !receipt?.undo)
      return C.unavailable('This change cannot be reversed from here.');
    if (Date.parse(receipt.undo.valid_until) < Date.now())
      return C.unavailable('The time to undo this has passed.');
    this.undoable.delete(id);
    const reversal = C.experienceReceipt.parse({
      id: newId('receipt'),
      what: `Removed again: ${receipt.what.replace(/^Added to your calendar: /, '')}`,
      where: receipt.where,
      when: this.now(),
    });
    chat.receipts.push(reversal);
    this.event(chat, { type: 'receipt', receipt: reversal });
    return { receipt: reversal };
  }
  /** Decide a scenario proposal. Returns null when the permission is a draft send. */
  decideProposal(id: string, input: ReturnType<typeof C.permissionDecision.parse>) {
    const link = this.permissionProposals.get(id);
    if (!link) return null;
    const chat = required(this.chats, link.chatId);
    const proposal = chat.proposals.get(link.ref);
    const permission = required(this.permissions, id);
    if (!proposal) return null;
    let rule: C.StandingRule | null = null;
    if (input.option === 'always') {
      if (Date.parse(input.bounds.expires_at) <= Date.now())
        throw new MockExperienceError(400, 'Choose a future expiry.');
      rule = C.standingRule.parse({
        id: newId('rule'),
        text: `${proposal.what.split(':')[0]} without asking, up to ${input.bounds.count_cap} times before ${input.bounds.expires_at.slice(0, 10)}.`,
        kind: proposal.kind.startsWith('calendar') ? 'create_event' : 'send_message',
        connection_id:
          permission.preview?.source_connection ??
          this.evidenceConnection()?.id ??
          this.deps.spaceId,
        recipient_class: proposal.where,
        bounds: input.bounds,
        used: 0,
        created_at: this.now(),
      });
      this.rules.set(rule.id, rule);
    }
    proposal.decision = input.option;
    this.permissions.delete(id);
    if (input.option === 'deny') {
      this.event(chat, { type: 'note', text: 'Nothing was changed.' });
      const target = proposal.onDenied
        ? chat.script?.steps.findIndex((step) => step.label === proposal.onDenied)
        : -1;
      if (target !== undefined && target >= 0) chat.position = target;
    }
    this.state(chat, 'working');
    this.schedule(chat);
    return C.permissionOutcome.parse({ status: 'ok', option: input.option, rule });
  }
  /** Start a scripted conversation without an HTTP round trip, for seeding. */
  start(title: string, agentId: string, text: string, planId?: string) {
    const { conversation } = this.create({ title, agent_id: agentId, plan_id: planId });
    this.message(required(this.chats, conversation.id), { text });
    return conversation;
  }
  /** What the web app needs on first paint. Only the server calls this. */
  seed() {
    const store = this.deps.store;
    const now = store.now();
    const iso = (d: Date) => d.toISOString();
    const at = (dayOffset: number, hour: number, minute = 0) => {
      const d = new Date(now);
      d.setDate(now.getDate() + dayOffset);
      d.setHours(hour, minute, 0, 0);
      return d;
    };
    const connection = (provider: 'caldav' | 'web' | 'files', label: string, scopes: string[]) => {
      const id = newId('conn');
      store.connections.set(id, {
        id,
        space_id: this.deps.spaceId,
        provider,
        label,
        secret_ref: newId('secret'),
        scopes,
        status: 'active',
        health: 'ok',
        last_checked_at: iso(now),
        created_at: iso(now),
      });
      return id;
    };
    const calendar = connection('caldav', 'Google Calendar', ['calendar.read', 'calendar.create']);
    connection('web', 'Web', ['web.fetch']);
    connection('files', 'Files', ['files.read']);
    for (const [offset, hour, minute, title, length] of [
      [0, 11, 0, 'Deep work · review prep', 60],
      [0, 19, 30, 'Dinner with Alex & Priya · Luna Trattoria', 90],
      [1, 7, 0, 'Run club', 45],
    ] as const) {
      const starts = at(offset, hour, minute);
      this.calendarEvents.push(
        C.experienceCalendarEvent.parse({
          id: newId('evt'),
          title,
          starts_at: iso(starts),
          ends_at: iso(new Date(starts.getTime() + length * 60_000)),
          connection_id: calendar,
        }),
      );
    }
    this.profile = C.profileInput.parse({
      name: 'Jamie Davis',
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      day_hours: { start: '08:00', end: '22:00' },
    });
    for (const [title, done] of [
      ['Send Priya the Kyoto list', false],
      ['Renew passport before Oct 3', false],
      ['Read 20 pages', false],
      ['Book the dentist', true],
    ] as const) {
      const task = C.experienceTask.parse({
        id: newId('task'),
        title,
        due_at: null,
        done,
        created_at: iso(now),
        updated_at: iso(now),
      });
      this.tasks.set(task.id, task);
    }
    // One standing rule, as an earlier "always allow" would have left it.
    const rule = C.standingRule.parse({
      id: newId('rule'),
      text: 'Add events to your calendar without asking, up to 10 times before Oct 12.',
      kind: 'create_event',
      connection_id: calendar,
      recipient_class: 'Google Calendar',
      bounds: { count_cap: 10, expires_at: iso(at(30, 0)), reconsent_after_days: 7 },
      used: 1,
      created_at: iso(at(-2, 9)),
    });
    this.rules.set(rule.id, rule);
    const agents = [...this.agents.values()];
    const nova = agents.find((agent) => agent.name === 'Nova') ?? agents[0];
    const sage = agents.find((agent) => agent.name === 'Sage') ?? agents[0];
    const atlas = agents.find((agent) => agent.name === 'Atlas') ?? agents[0];
    if (!nova || !sage || !atlas) return;
    // The designed looks, on the seeded agents.
    Object.assign(nova, {
      role: 'Concierge',
      colour: '#4aa3f7',
      surface: 'blob',
      eye_colour: '#ffffff',
      tone: 'Warm',
      standing_instruction: 'One option first, not five. Confirm before paying.',
    });
    Object.assign(sage, {
      role: 'Coach',
      colour: '#5ab4a0',
      surface: 'octagon',
      eye_colour: '#16181d',
      tone: 'Direct',
      standing_instruction: 'Ask how the last run went before suggesting the next.',
    });
    Object.assign(atlas, {
      role: 'Researcher',
      colour: '#ec8a2b',
      surface: 'diamond',
      eye_colour: '#ffffff',
      tone: 'Direct',
      standing_instruction: 'Cite every claim. Say when the sources disagree.',
    });
    const plan = (
      title: string,
      category: string,
      milestones: [string, boolean, string | null][],
    ) => {
      const value = C.experiencePlan.parse({
        id: newId('plan'),
        title,
        category,
        milestones: milestones.map(([text, done, agentId]) => ({
          id: newId('mile'),
          title: text,
          assignee: agentId ? { kind: 'agent', agent_id: agentId } : { kind: 'person' },
          done,
          status: done ? 'done' : 'idle',
        })),
        next_step: milestones.find(([, done]) => !done)?.[0] ?? null,
        progress_percent: Math.round(
          (milestones.filter(([, done]) => done).length / milestones.length) * 100,
        ),
        conversation_ids: [],
        file_ids: [],
        updated_at: iso(at(-2, 9)),
      });
      this.plans.set(value.id, value);
      return value;
    };
    const japan = plan('Japan, two weeks in October', 'Travel', [
      ['Pick the dates · Oct 10–24', true, null],
      ['Set a budget', true, null],
      ['Book the Kyoto ryokan', false, nova.id],
      ['Find flights', false, nova.id],
      ['Plan two days outside the cities', false, null],
    ]);
    plan('Run a 10K by November', 'Wellbeing', [
      ['Get checked out and pick shoes', true, null],
      ['Weeks 1–4 · run-walk to 3K', true, sage.id],
      ['Weeks 5–8 · steady 5K', false, sage.id],
      ['Weeks 9–11 · long runs to 9K', false, sage.id],
      ['Race day · Nov 15', false, null],
    ]);
    plan('Spanish, conversational by spring', 'Learning', [
      ['Pick a course and a tutor', true, null],
      ['Learn 100 useful phrases', false, atlas.id],
      ['First 15-minute conversation', false, null],
    ]);
    plan('Three-month emergency fund', 'Finances', [
      ['Open the savings account', true, null],
      ['Move 400 into savings on the 1st', false, null],
      ['Month two', false, null],
      ['Month three', false, null],
    ]);
    for (const [title, cron, enabled] of [
      ['Morning brief', '30 8 * * 1,2,3,4,5', true],
      ['Expenses on Fridays', '0 16 * * 5', true],
      ['Long-run check-in', '0 7 * * 0', false],
    ] as const) {
      const routine = C.experienceAutomation.parse({
        id: newId('routine'),
        title,
        schedule: scheduleSentence(cron, this.profile.time_zone),
        enabled,
        runs: [
          {
            id: newId('run'),
            status: 'done',
            started_at: iso(at(0, 8, 30)),
            finished_at: iso(at(0, 8, 31)),
          },
          {
            id: newId('run'),
            status: 'done',
            started_at: iso(at(-1, 8, 30)),
            finished_at: iso(at(-1, 8, 31)),
          },
          {
            id: newId('run'),
            status: 'failed',
            started_at: iso(at(-3, 8, 30)),
            finished_at: iso(at(-3, 8, 32)),
          },
        ],
      });
      this.automations.set(routine.id, routine);
    }
    const kyoto = this.start(
      'Kyoto in October',
      nova.id,
      'Help me plan two weeks in Japan, slow pace.',
      japan.id,
    );
    japan.conversation_ids = [kyoto.id];
    this.start('Passport renewal', atlas.id, 'Which documents do I need to renew in person?');
  }
  /**
   * Every experience event is also a store event on the conversation's job, so
   * its seq is a message id the reaction routes accept and the two streams
   * share one seq space. Streamed text keeps its type; the rest are notices.
   */
  event(chat: Chat, item: C.ExperienceEvent['item']) {
    const mirrored = this.deps.store.append({
      type: item.type === 'text_delta' ? 'text_delta' : 'notice',
      job_id: chat.view.id,
      payload:
        item.type === 'text_delta'
          ? { text: item.text }
          : { level: 'info', title: item.type, body: '', experience: true },
    });
    chat.events.push(
      C.experienceEvent.parse({
        seq: mirrored.seq,
        conversation_id: chat.view.id,
        turn_id: chat.turns.at(-1)?.id ?? null,
        created_at: this.now(),
        item,
      }),
    );
  }
  state(chat: Chat, status: C.Conversation['status']) {
    chat.view.status = status;
    chat.view.composer =
      status === 'paused'
        ? 'resume'
        : ['queued', 'working', 'streaming'].includes(status)
          ? 'stop'
          : 'send';
    chat.view.updated_at = this.now();
    const turn = chat.turns.at(-1);
    if (turn) turn.status = status;
    this.event(chat, { type: 'status', status, composer: chat.view.composer });
  }
  create(raw: unknown) {
    const input = C.conversationCreate.parse(raw);
    required(this.agents, input.agent_id);
    if (input.plan_id) required(this.plans, input.plan_id);
    const view = C.conversation.parse({
      ...input,
      id: newId('job'),
      status: 'idle',
      composer: 'send',
      created_at: this.now(),
      updated_at: this.now(),
      plan_id: input.plan_id ?? null,
    });
    const chat: Chat = {
      view,
      turns: [],
      messageSeqs: new Map(),
      events: [],
      cards: [],
      receipts: [],
      drafts: [],
      position: 0,
      pending: [],
      paused: false,
      stopped: false,
      proposals: new Map(),
      lastCard: null,
    };
    this.chats.set(view.id, chat);
    if (input.plan_id) required(this.plans, input.plan_id).conversation_ids.push(view.id);
    return { conversation: view };
  }
  flush(chat: Chat) {
    if (!chat.pending.length) return;
    const group = projectActionGroup(chat.pending);
    if (group) this.event(chat, group);
    for (const entry of chat.pending)
      for (const card of projectCards(entry.action, entry.connection)) {
        chat.cards.push(card);
        this.event(chat, { type: 'card', card });
      }
    chat.pending = [];
  }
  schedule(chat: Chat) {
    if (chat.paused || chat.stopped) return;
    const delay =
      (chat.script?.steps[chat.position]?.delay_ms ?? 100) * (this.deps.experienceSpeed ?? 1);
    chat.timer = setTimeout(() => this.step(chat), delay);
  }
  /** End the turn. An empty summary means the agent said nothing in words (it reacted instead). */
  finish(chat: Chat, summary: string) {
    this.flush(chat);
    const turn = chat.turns.at(-1);
    if (turn && !turn.answer && summary) {
      turn.answer = summary;
      this.event(chat, { type: 'text_delta', text: summary });
    }
    // The resting line counts this turn's sources, not the whole conversation's.
    const sources = chat.events.flatMap((event) =>
      event.item.type === 'action' && event.turn_id === (turn?.id ?? null)
        ? event.item.sources
        : [],
    );
    this.event(chat, {
      type: 'done',
      summary: summary || 'Answered with a reaction.',
      elapsed_ms: Math.max(0, Date.now() - Date.parse(turn?.created_at ?? this.now())),
      apps: [...new Set(sources.map((source) => source.app))],
      source_count: sources.length,
    });
    this.state(chat, 'done');
  }
  step(chat: Chat) {
    if (chat.paused || chat.stopped) return;
    const step = chat.script?.steps[chat.position++];
    if (!step) {
      this.finish(chat, 'Your request is ready.');
      return;
    }
    if (step.step === 'say') {
      this.flush(chat);
      this.event(chat, { type: 'say', text: plainText(step.text, 'Working on it.', 600) });
    } else if (step.step === 'react') {
      // The agent answers the person's message with a glyph: a reaction event on
      // the job stream, by the assistant, on the seq of the message it read.
      const turn = chat.turns.at(-1);
      const target = turn ? chat.messageSeqs.get(turn.id) : undefined;
      if (target !== undefined)
        this.deps.store.append({
          type: 'reaction',
          job_id: chat.view.id,
          payload: { message_id: String(target), emoji: step.emoji, by: 'assistant' },
        });
    } else if (step.step === 'tool' && step.sources.length) {
      // Scripted evidence with human labels: one action, its sources with their apps.
      this.flush(chat);
      const connection = this.evidenceConnection();
      this.event(chat, {
        type: 'action',
        label: plainText(step.title, 'Checked something', 4000),
        meta: step.meta,
        sources: step.sources.map((source) =>
          C.experienceSource.parse({
            app: SOURCE_APPS[source.app] ?? plainText(source.app, 'Web'),
            title: plainText(source.label, 'Source'),
            kind: SOURCE_KINDS[source.app] ?? 'page',
            connection_id: connection?.id ?? `${this.deps.spaceId}:${source.app}`,
            ...(source.url ? { url: source.url } : {}),
          }),
        ),
      });
    } else if (step.step === 'card') {
      this.flush(chat);
      const card = C.resultCard.parse({
        id: `${chat.view.id}:${step.id}`,
        title: step.title,
        meta: [step.overline, step.rating ? `★ ${step.rating}` : '', ...step.facts]
          .filter(Boolean)
          .join(' · '),
        facts: [
          ...(step.description ? [{ label: 'About', value: step.description }] : []),
          ...step.chips.map((chip) => ({ label: 'When', value: chip })),
        ].slice(0, 20),
        primary_action: null,
        secondary_actions: [],
        source_connection: this.evidenceConnection()?.id ?? null,
      });
      chat.cards.push(card);
      chat.lastCard = card;
      this.event(chat, { type: 'card', card });
    } else if (step.step === 'draft') {
      this.flush(chat);
      const connection = this.evidenceConnection();
      const draft = C.experienceDraft.parse({
        id: newId('draft'),
        recipient: step.recipient.name,
        channel: 'message',
        body: step.body,
        connection_id: connection?.id ?? `${this.deps.spaceId}:messages`,
        status: 'draft',
      });
      chat.drafts.push(draft);
      const card = C.resultCard.parse({
        id: draft.id,
        title: `Message to ${draft.recipient}`,
        meta: `${step.channel_label} · nothing is sent until you confirm`,
        facts: [{ label: 'Draft', value: draft.body }],
        primary_action: { label: `Send via ${step.channel_label}`, kind: 'send', handle: draft.id },
        secondary_actions: [],
        source_connection: connection?.id ?? null,
      });
      chat.cards.push(card);
      this.event(chat, { type: 'card', card });
    } else if (step.step === 'ask') {
      this.flush(chat);
      const question = C.experienceQuestion.parse({
        id: newId('q'),
        conversation_id: chat.view.id,
        text: plainText(step.question, 'What should happen next?'),
        why: ['Your answer decides the next step.'],
        if_ignored: 'This conversation waits for your answer.',
        options: step.options.map((option, index) => ({
          id: `option-${index + 1}`,
          label: option.description
            ? `${option.label} · ${option.description}`.slice(0, 4000)
            : option.label,
        })),
      });
      this.questions.set(question.id, question);
      this.event(chat, { type: 'question', question });
      this.state(chat, 'needs_you');
      return;
    } else if (step.step === 'browser') {
      // The contract has no way to announce a browser session yet; nothing is drawn.
    } else if (step.step === 'propose' && !this.isDraftKind(step.kind, step.payload)) {
      this.flush(chat);
      const words = PROPOSAL_WORDS[step.kind] ?? {
        what: 'Make a change through a connected app',
        where: 'a connected app',
        reversible: false,
      };
      const title = plainText(step.payload.title, '');
      const rows = [...this.deps.store.connections.values()].filter(
        (row) => row.space_id === this.deps.spaceId,
      );
      const source =
        rows.find((row) => row.label === step.connection || row.scopes.includes(step.kind)) ??
        this.evidenceConnection() ??
        rows[0];
      chat.proposals.set(step.ref, {
        ref: step.ref,
        kind: step.kind,
        payload: step.payload,
        what: title ? `${words.what}: ${title}` : words.what,
        where: words.where,
        decision: null,
        onDenied: null,
        permissionId: null,
        connectionId: source?.id ?? '',
      });
    } else if (step.step === 'await_approval') {
      const proposal = chat.proposals.get(step.ref);
      if (proposal && proposal.decision === null) {
        proposal.onDenied = step.on_denied;
        const detail = [step.ref, ...Object.entries(proposal.payload)]
          .slice(1)
          .map(([key, value]) => `${key}: ${plainText(value, '')}`)
          .filter((line) => !line.endsWith(': '));
        const permission = C.permissionCard.parse({
          id: newId('permission'),
          conversation_id: chat.view.id,
          what: proposal.what,
          why: detail.length ? detail : ['You asked for this.'],
          options: ['allow_once', 'always', 'deny'],
          version: newId('v'),
          preview: chat.lastCard,
        });
        proposal.permissionId = permission.id;
        this.permissions.set(permission.id, permission);
        this.permissionProposals.set(permission.id, { chatId: chat.view.id, ref: step.ref });
        this.event(chat, { type: 'permission', permission });
        this.state(chat, 'needs_you');
        return;
      }
    } else if (step.step === 'dispatch') {
      const proposal = chat.proposals.get(step.ref);
      if (proposal && proposal.decision !== 'deny' && step.outcome === 'succeeded') {
        const words = PROPOSAL_WORDS[proposal.kind];
        const receipt = C.experienceReceipt.parse({
          id: newId('receipt'),
          what: proposal.what
            .replace(/^Add an event to your calendar/, 'Added to your calendar')
            .replace(/^Hold a table/, 'Held a table'),
          where: proposal.where,
          when: this.now(),
          ...(words?.reversible
            ? {
                undo: {
                  handle: newId('undo'),
                  valid_until: new Date(Date.now() + 10 * 60_000).toISOString(),
                },
              }
            : {}),
        });
        chat.receipts.push(receipt);
        this.undoable.set(receipt.id, { chatId: chat.view.id, what: proposal.what });
        this.event(chat, { type: 'receipt', receipt });
      } else if (proposal && step.outcome !== 'succeeded') {
        this.restUnknown(chat, {
          kind: proposal.kind,
          connectionId: proposal.connectionId,
          payload: proposal.payload,
          draftId: null,
          what: 'The change',
          resume: true,
        });
        return;
      }
    } else if (step.step === 'text') {
      this.flush(chat);
      const text = answerText(step.text);
      if (text) {
        const turn = chat.turns.at(-1);
        if (turn) turn.answer += text;
        this.event(chat, { type: 'text_delta', text });
        this.state(chat, 'streaming');
      }
    } else if (step.step === 'tool') {
      const provider = step.name.startsWith('email.')
        ? 'imap'
        : step.name.startsWith('calendar.')
          ? 'caldav'
          : step.name.split('.')[0];
      const source = [...this.deps.store.connections.values()].find(
        (row) => row.space_id === this.deps.spaceId && row.provider === provider,
      );
      if (source)
        chat.pending.push({
          connection: source,
          action: {
            id: newId('act'),
            jobId: chat.view.id,
            attemptId: newId('att'),
            connectionId: source.id,
            kind: step.name,
            effectClass: 'read',
            canonicalPayload: {},
            receipt: { detail: step.result },
            status: 'succeeded',
            createdAt: new Date(),
            resolvedAt: new Date(),
          },
        });
    } else if (step.step === 'propose') {
      this.flush(chat);
      const source = [...this.deps.store.connections.values()].find(
        (row) =>
          row.space_id === this.deps.spaceId &&
          (row.label === step.connection || row.scopes.includes(step.kind)),
      );
      if (!source) {
        this.finish(chat, 'Connect the app to continue.');
        return;
      }
      if (
        step.kind === 'email.send' ||
        step.kind === 'email.draft' ||
        (step.kind === 'test.write' && typeof step.payload.body === 'string')
      ) {
        const to = step.payload.to;
        const draft = C.experienceDraft.parse({
          id: newId('draft'),
          recipient: Array.isArray(to) ? to.join(', ') : plainText(to, 'Recipient'),
          channel: step.kind === 'test.write' ? 'message' : 'email',
          body: plainText(step.payload.body, ''),
          subject: plainText(step.payload.subject, 'Draft'),
          connection_id: source.id,
          status: 'draft',
        });
        chat.drafts.push(draft);
        const card = C.resultCard.parse({
          id: draft.id,
          title: draft.subject,
          meta: `To ${draft.recipient}`,
          facts: [{ label: 'Draft', value: draft.body || 'Empty draft' }],
          primary_action: { label: 'Review and send', kind: 'send', handle: draft.id },
          secondary_actions: [],
          source_connection: source.id,
        });
        chat.cards.push(card);
        this.event(chat, { type: 'card', card });
        this.finish(chat, 'Your draft is ready to review.');
        return;
      }
      this.finish(chat, 'This scenario needs a supported connection before it can continue.');
      return;
    } else if (step.step === 'await_input') {
      const question = C.experienceQuestion.parse({
        id: newId('q'),
        conversation_id: chat.view.id,
        text: plainText(step.question, 'What should happen next?'),
        why: ['Your answer is needed to continue.'],
        if_ignored: 'This conversation waits for your answer.',
        options: [
          { id: 'continue', label: 'Continue' },
          { id: 'stop', label: 'Stop here' },
        ],
      });
      this.questions.set(question.id, question);
      this.event(chat, { type: 'question', question });
      this.state(chat, 'needs_you');
      return;
    } else if (step.step === 'notice')
      this.event(chat, {
        type: 'note',
        text: plainText(step.body || step.title, 'There is an update.'),
      });
    else if (step.step === 'complete') {
      const reacted = chat.script?.steps.some((entry) => entry.step === 'react');
      this.finish(
        chat,
        reacted && !step.answer.trim() ? '' : plainText(step.answer, 'Your request is ready.'),
      );
      return;
    } else if (step.step === 'fail') {
      this.event(chat, { type: 'note', text: 'This request could not be completed.' });
      this.state(chat, 'failed');
      return;
    }
    this.schedule(chat);
  }
  message(chat: Chat, raw: unknown, key?: string) {
    const input = C.conversationMessage.parse(raw);
    const fingerprint = `${chat.view.id}:${key}`;
    const previous = key ? this.submissions.get(fingerprint) : undefined;
    if (previous) {
      if (previous.text !== input.text)
        throw new MockExperienceError(
          409,
          'That message was already accepted with different text.',
        );
      return previous.result;
    }
    if (['queued', 'working', 'streaming', 'paused'].includes(chat.view.status))
      throw new MockExperienceError(409, 'Finish the current request first.');
    const turn = C.conversationTurn.parse({
      id: newId('turn'),
      conversation_id: chat.view.id,
      agent_id: chat.view.agent_id,
      text: input.text,
      answer: '',
      status: 'queued',
      delivery: null,
      created_at: this.now(),
    });
    chat.turns.push(turn);
    // The person's message is an event too, so a reaction can land on it.
    const spoken = this.deps.store.append({
      type: 'notice',
      job_id: chat.view.id,
      payload: { kind: 'user_message', text: input.text },
    });
    // The service stores both records in one transaction with the same creation timestamp.
    turn.created_at = spoken.created_at;
    chat.messageSeqs.set(turn.id, spoken.seq);
    chat.script = chooseScenario(this.deps.scenarios, `${chat.view.title} ${input.text}`);
    chat.position = 0;
    chat.paused = false;
    chat.stopped = false;
    const result = C.messageAcceptance.parse({
      turn_id: turn.id,
      receipt: { id: newId('sub'), status: 'accepted', received_at: turn.created_at },
    });
    if (key) this.submissions.set(fingerprint, { text: input.text, result });
    this.state(chat, 'working');
    // A scenario that opens with its own words, or with a glyph, gets no generic opener.
    const opening = chat.script?.steps[0]?.step;
    if (opening !== 'say' && opening !== 'react')
      this.event(chat, {
        type: 'say',
        text: 'I’ll check what you need and prepare the next step.',
      });
    this.schedule(chat);
    return result;
  }
  findDraft(id: string) {
    for (const chat of this.chats.values()) {
      const draft = chat.drafts.find((entry) => entry.id === id);
      if (draft) return { chat, draft };
    }
    throw new MockExperienceError(404, 'This draft is no longer available.');
  }
  deliver(chat: Chat, draft: C.ExperienceDraft) {
    const outcome = chat.script?.steps.find((step) => step.step === 'dispatch');
    if (outcome?.step === 'dispatch' && outcome.outcome !== 'succeeded') {
      const proposed = chat.script?.steps.find(
        (step) => step.step === 'propose' && step.ref === outcome.ref,
      );
      this.restUnknown(chat, {
        kind: proposed?.step === 'propose' ? proposed.kind : 'message.send',
        connectionId: draft.connection_id,
        payload:
          proposed?.step === 'propose'
            ? proposed.payload
            : { to: draft.recipient, subject: draft.subject ?? '', body: draft.body },
        draftId: draft.id,
        what: 'The send',
        resume: false,
      });
      return null;
    }
    draft.status = 'sent';
    const receipt = C.experienceReceipt.parse({
      id: newId('receipt'),
      what: `Sent a message to ${draft.recipient}`,
      where: 'Mail',
      when: this.now(),
    });
    chat.receipts.push(receipt);
    this.sentReceipts.set(draft.id, receipt);
    this.event(chat, { type: 'receipt', receipt });
    this.finish(chat, 'Your message was sent.');
    return receipt;
  }
  /**
   * Record an effect whose outcome never came back. It rests in the ledger at
   * `unknown` (GET /actions?job_id=) until a person settles it through
   * POST /actions/{id}/resolve; nothing is repeated meanwhile.
   */
  restUnknown(
    chat: Chat,
    input: {
      kind: string;
      connectionId: string;
      payload: Record<string, unknown>;
      draftId: string | null;
      what: string;
      resume: boolean;
    },
  ) {
    const { canonical, hash } = C.canonicalizePayload(input.payload);
    const now = this.now();
    const id = newId('act');
    const action: C.Action = {
      id,
      job_id: chat.view.id,
      attempt_id: newId('att'),
      connection_id: input.connectionId,
      kind: input.kind,
      effect_class: 'write_external',
      canonical_payload: canonical,
      payload_hash: hash,
      intent_key: null,
      status: 'unknown',
      authorization_ref: null,
      budget_reservation: null,
      idempotency_key: id,
      dispatched_at: now,
      receipt: null,
      resolved_at: null,
      reconciliation: null,
      repair_trace: [],
      repair_counters: {},
      repair_disposition: null,
      retry_after_at: null,
      created_at: now,
    };
    this.deps.store.actions.set(id, action);
    this.unknownActions.set(id, {
      chatId: chat.view.id,
      draftId: input.draftId,
      resume: input.resume,
    });
    this.event(chat, {
      type: 'note',
      text: `${input.what} could not be confirmed. It has not been repeated.`,
    });
    this.state(chat, 'needs_you');
  }
  /** The person settled an unknown action through the broker; the chat says so and moves on. */
  actionResolved(action: C.Action) {
    const rest = this.unknownActions.get(action.id);
    const chat = rest ? this.chats.get(rest.chatId) : undefined;
    if (!rest || !chat) return;
    const draft = rest.draftId ? chat.drafts.find((entry) => entry.id === rest.draftId) : null;
    if (action.status === 'unresolved') {
      this.event(chat, {
        type: 'note',
        text: 'Still unconfirmed. Nothing will be repeated until you say what happened.',
      });
      return;
    }
    this.unknownActions.delete(action.id);
    if (draft) draft.status = action.status === 'succeeded' ? 'sent' : 'draft';
    this.event(chat, {
      type: 'note',
      text:
        action.status === 'succeeded'
          ? 'You said it arrived. Nothing was sent again.'
          : 'You said it did not arrive. Nothing was sent again; the draft is still yours.',
    });
    if (rest.resume && chat.script && chat.position < chat.script.steps.length) {
      this.state(chat, 'working');
      this.schedule(chat);
    } else this.state(chat, 'done');
  }
  send(id: string) {
    const { chat, draft } = this.findDraft(id);
    const existing = [...this.permissions.values()].find(
      (permission) => this.permissionDrafts.get(permission.id) === id,
    );
    if (draft.status === 'sent')
      return { draft, permission: null, receipt: this.sentReceipts.get(draft.id) ?? null };
    if (draft.status === 'awaiting_permission')
      return existing
        ? { draft, permission: existing, receipt: null }
        : C.unavailable('The send could not be confirmed. It has not been repeated.');
    const rule = [...this.rules.values()].find(
      (rule) =>
        rule.connection_id === draft.connection_id &&
        rule.recipient_class === draft.recipient &&
        rule.used < rule.bounds.count_cap &&
        Date.parse(rule.bounds.expires_at) > Date.now() &&
        Date.parse(rule.created_at) + rule.bounds.reconsent_after_days * 86400000 > Date.now(),
    );
    draft.status = 'awaiting_permission';
    if (rule) {
      rule.used++;
      return { draft, permission: null, receipt: this.deliver(chat, draft) };
    }
    const permission = C.permissionCard.parse({
      id: newId('permission'),
      conversation_id: chat.view.id,
      what: `Send this draft to ${draft.recipient}`,
      why: ['You asked to send this reviewed draft.'],
      options:
        chat.script?.id === 'approved-send'
          ? ['allow_once', 'always', 'deny']
          : ['allow_once', 'deny'],
      version: newId('v'),
      draft,
      preview: chat.cards.find((card) => card.id === id) ?? null,
    });
    this.permissions.set(permission.id, permission);
    this.permissionDrafts.set(permission.id, id);
    this.event(chat, { type: 'permission', permission });
    return { draft, permission, receipt: null };
  }
  decide(id: string, raw: unknown) {
    const input = C.permissionDecision.parse(raw);
    if (this.permissionProposals.has(id)) {
      const permission = this.permissions.get(id);
      if (!permission) throw new MockExperienceError(409, 'This request was already answered.');
      if (input.version !== permission.version)
        throw new MockExperienceError(409, 'Review the current permission before deciding.');
      const outcome = this.decideProposal(id, input);
      if (outcome) return outcome;
    }
    const previous = this.decisions.get(id);
    if (previous) {
      if (previous.version !== input.version || previous.result.option !== input.option)
        throw new MockExperienceError(409, 'This request was already answered.');
      return previous.result;
    }
    const permission = required(this.permissions, id);
    if (input.version !== permission.version)
      throw new MockExperienceError(409, 'Review the current permission before deciding.');
    if (!permission.options.includes(input.option))
      throw new MockExperienceError(400, 'That choice is not available.');
    const { chat, draft } = this.findDraft(required(this.permissionDrafts, id));
    let rule: C.StandingRule | null = null;
    if (input.option === 'always') {
      if (Date.parse(input.bounds.expires_at) <= Date.now())
        throw new MockExperienceError(400, 'Choose a future expiry.');
      rule = C.standingRule.parse({
        id: newId('rule'),
        text: `Send messages to ${draft.recipient}, up to ${input.bounds.count_cap} times before ${input.bounds.expires_at}.`,
        kind: 'send_message',
        connection_id: draft.connection_id,
        recipient_class: draft.recipient,
        bounds: input.bounds,
        used: 0,
        created_at: this.now(),
      });
      this.rules.set(rule.id, rule);
    }
    if (input.option === 'deny') {
      draft.status = 'draft';
      this.event(chat, { type: 'note', text: 'The message was not sent.' });
    } else this.deliver(chat, draft);
    this.permissions.delete(id);
    const result = C.permissionOutcome.parse({ status: 'ok', option: input.option, rule });
    this.decisions.set(id, { version: input.version, result });
    return result;
  }
  eventPage(chatId: string | undefined, since: number, limit = 100) {
    const all = (chatId ? [required(this.chats, chatId)] : [...this.chats.values()])
      .flatMap((chat) => chat.events)
      .filter((event) => event.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const events = all.slice(0, limit);
    return { events, next_cursor: events.at(-1)?.seq ?? since, has_more: all.length > limit };
  }
  events(c: Context, id?: string) {
    const cursor = c.req.header('Last-Event-ID') ?? c.req.query('since') ?? '0';
    if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      throw new MockExperienceError(400, 'Choose a valid position.');
    let since = Number(cursor);
    const page = this.eventPage(id, since, Number(c.req.query('limit') ?? 100));
    if (!c.req.header('Accept')?.includes('text/event-stream')) return page;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let close: (() => void) | undefined;
    const stop = () => {
      clearInterval(timer);
      c.req.raw.signal.removeEventListener('abort', stop);
      close?.();
      close = undefined;
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const push = () => {
          for (const event of this.eventPage(id, since).events) {
            since = event.seq;
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: ${event.item.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          }
        };
        close = () => controller.close();
        push();
        timer = setInterval(() => {
          if ((controller.desiredSize ?? 0) > 0) push();
        }, 50);
        c.req.raw.signal.addEventListener('abort', stop, { once: true });
      },
      cancel: () => {
        close = undefined;
        stop();
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }
  connections() {
    return [...this.deps.store.connections.values()]
      .filter((row) => row.space_id === this.deps.spaceId)
      .map((row) =>
        C.experienceConnection.parse({
          id: row.id,
          app: row.provider === 'smtp' ? 'Mail' : appName(row),
          label: plainText(row.label, 'Connected app'),
          status: row.status === 'active' ? 'connected' : 'error',
          access: row.scopes.some((scope) => /send|create|write/.test(scope))
            ? 'asks_before_acting'
            : 'read_only',
        }),
      );
  }
  automation(raw: unknown) {
    const input = C.automationCreate.parse(raw);
    required(this.agents, input.agent_id);
    const [hour, minute] = input.at.split(':');
    const value = C.experienceAutomation.parse({
      id: newId('routine'),
      title: input.title,
      enabled: true,
      schedule: scheduleSentence(
        `${Number(minute)} ${Number(hour)} * * ${[...new Set(input.weekdays)].sort().join(',')}`,
        this.profile.time_zone,
      ),
      runs: [],
    });
    this.automations.set(value.id, value);
    return { automation: value };
  }
  handle(key: string, c: Context, input: Record<string, unknown>): unknown {
    const id = c.req.param('id') ?? '';
    switch (key) {
      case 'GET /agents/templates':
        return AGENT_TEMPLATES;
      case 'GET /agents':
        return {
          agents: [...this.agents.values()].map((agent) => ({
            ...agent,
            usage: {
              conversations: [...this.chats.values()].filter(
                (chat) => chat.view.agent_id === agent.id,
              ).length,
              last_used:
                [...this.chats.values()].filter((chat) => chat.view.agent_id === agent.id).at(-1)
                  ?.view.updated_at ?? null,
            },
          })),
        };
      case 'POST /agents':
      case 'PATCH /agents/{id}': {
        if (id) required(this.agents, id);
        const allowed = C.agentInput.parse(input).allowed_connection_ids;
        if (allowed.some((id) => !this.connections().some((connection) => connection.id === id)))
          throw new MockExperienceError(400, 'Choose connections from this space.');
        const agent = C.experienceAgent.parse({
          ...input,
          id: id || newId('agent'),
          space_id: this.deps.spaceId,
          usage: { conversations: 0, last_used: null },
        });
        this.agents.set(agent.id, agent);
        return { agent };
      }
      case 'GET /conversations':
        return { conversations: [...this.chats.values()].map((chat) => chat.view) };
      case 'POST /conversations':
        return this.create(input);
      case 'GET /conversations/{id}':
        return { conversation: required(this.chats, id).view };
      case 'PATCH /conversations/{id}/agent': {
        const chat = required(this.chats, id);
        required(this.agents, String(input.agent_id));
        chat.view.agent_id = String(input.agent_id);
        return { conversation: chat.view };
      }
      case 'GET /conversations/{id}/messages':
        return { turns: required(this.chats, id).turns };
      case 'POST /conversations/{id}/messages':
        return this.message(required(this.chats, id), input, c.req.header('Idempotency-Key'));
      case 'GET /conversations/{id}/events':
        return this.events(c, id);
      case 'GET /conversations/{id}/cards':
        return { cards: required(this.chats, id).cards };
      case 'GET /conversations/{id}/receipts':
        return { receipts: required(this.chats, id).receipts };
      case 'GET /conversations/{id}/drafts':
        return { drafts: required(this.chats, id).drafts };
      case 'POST /conversations/{id}/pause':
      case 'POST /conversations/{id}/resume':
      case 'POST /conversations/{id}/stop': {
        const chat = required(this.chats, id);
        clearTimeout(chat.timer);
        if (key.endsWith('/resume')) {
          chat.paused = false;
          this.state(chat, 'working');
          this.schedule(chat);
        } else if (key.endsWith('/pause')) {
          chat.paused = true;
          this.state(chat, 'paused');
        } else {
          chat.stopped = true;
          this.state(chat, 'stopped');
        }
        return { conversation: chat.view };
      }
      case 'GET /permissions':
        return { permissions: [...this.permissions.values()] };
      case 'POST /permissions/{id}':
        return this.decide(id, input);
      case 'GET /rules':
        return { rules: [...this.rules.values()] };
      case 'DELETE /rules/{id}':
        required(this.rules, id);
        this.rules.delete(id);
        return { status: 'ok' };
      case 'POST /drafts/{id}/send':
        return this.send(id);
      case 'POST /receipts/{id}/undo':
        return this.undo(id);
      case 'GET /quick-answers':
        return { questions: [...this.questions.values()] };
      case 'POST /quick-answers/{id}': {
        const question = required(this.questions, id);
        if (!question.options.some((choice) => choice.id === input.option_id))
          throw new MockExperienceError(400, 'Choose an offered answer.');
        this.questions.delete(id);
        if (question.conversation_id) {
          const chat = required(this.chats, question.conversation_id);
          if (input.option_id === 'stop') {
            chat.stopped = true;
            this.state(chat, 'stopped');
          } else this.schedule(chat);
        }
        return { status: 'ok' };
      }
      case 'GET /memory/items':
        return { items: [...this.memories.values()] };
      case 'PATCH /memory/items/{id}': {
        const item = required(this.memories, id);
        if (input.version !== item.version)
          throw new MockExperienceError(409, 'This detail has changed.');
        item.value = String(input.value);
        item.version = newId('v');
        return { status: 'ok' };
      }
      case 'DELETE /memory/items/{id}':
        required(this.memories, id);
        this.memories.delete(id);
        return { status: 'ok' };
      case 'GET /memory/items/{id}/why': {
        const item = required(this.memories, id);
        return { reasons: [`You saved this detail: ${item.value}`], output: null, used_at: null };
      }
      case 'GET /profile':
        return { profile: this.profile };
      case 'PATCH /profile':
        this.profile = C.profileInput.parse(input);
        return { profile: this.profile };
      case 'GET /home': {
        const tasks = [...this.tasks.values()].filter((task) => !task.done);
        return {
          ...dayGreeting(this.profile, this.deps.store.now()),
          upcoming: this.calendarEvents.length
            ? this.calendarEvents.filter((event) => Date.parse(event.ends_at) > Date.now())
            : C.unavailable('No calendar is connected in this scenario.'),
          tasks,
          open_task_count: tasks.length,
        };
      }
      case 'GET /tasks':
        return { tasks: [...this.tasks.values()] };
      case 'POST /tasks':
      case 'PATCH /tasks/{id}': {
        const previous = id ? required(this.tasks, id) : undefined;
        const task = C.experienceTask.parse({
          ...input,
          id: id || newId('task'),
          created_at: previous?.created_at ?? this.now(),
          updated_at: this.now(),
        });
        this.tasks.set(task.id, task);
        return { task };
      }
      case 'DELETE /tasks/{id}':
        required(this.tasks, id);
        this.tasks.delete(id);
        return { status: 'ok' };
      case 'GET /plans':
        return { plans: [...this.plans.values()] };
      case 'POST /plans': {
        const value = C.planCreate.parse(input);
        for (const milestone of value.milestones)
          if (milestone.assignee.kind === 'agent')
            required(this.agents, milestone.assignee.agent_id);
        const plan = C.experiencePlan.parse({
          ...value,
          id: newId('plan'),
          milestones: value.milestones.map((item) => ({
            ...item,
            id: newId('mile'),
            done: false,
            status: 'idle',
          })),
          next_step: value.milestones[0]?.title ?? null,
          progress_percent: 0,
          conversation_ids: [],
          file_ids: [],
          updated_at: this.now(),
        });
        this.plans.set(plan.id, plan);
        return { plan };
      }
      case 'GET /plans/{id}':
        return { plan: required(this.plans, id) };
      case 'PATCH /plans/{id}/milestones/{milestoneId}': {
        const plan = required(this.plans, id);
        const step = plan.milestones.find((item) => item.id === c.req.param('milestoneId'));
        if (!step) throw new MockExperienceError(404, 'Step not found.');
        if (step.assignee.kind === 'agent')
          return C.unavailable('This step is completed when the assigned assistant finishes it.');
        step.done = Boolean(input.done);
        step.status = step.done ? 'done' : 'idle';
        plan.next_step = plan.milestones.find((item) => !item.done)?.title ?? null;
        plan.progress_percent = Math.round(
          (plan.milestones.filter((item) => item.done).length / plan.milestones.length) * 100,
        );
        return { plan };
      }
      case 'POST /plans/{id}/conversation':
        return this.create({
          title: required(this.plans, id).title,
          agent_id: input.agent_id,
          plan_id: id,
        });
      case 'POST /plans/{id}/share':
        required(this.plans, id);
        return C.unavailable('Sharing is not available yet.');
      case 'GET /automations':
        return { automations: [...this.automations.values()] };
      case 'POST /automations':
        return this.automation(input);
      case 'POST /automations/morning-brief':
        return this.automation({
          ...input,
          title: 'Your morning brief',
          instruction: 'Summarize today',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        });
      case 'POST /automations/{id}/test':
        required(this.automations, id).runs.unshift({
          id: newId('run'),
          status: 'done',
          started_at: this.now(),
          finished_at: this.now(),
        });
        return { status: 'ok' };
      case 'GET /experience/connections':
        return { connections: this.connections() };
      case 'GET /search': {
        const q = (c.req.query('q') ?? '').toLowerCase();
        const results = [
          ...[...this.chats.values()].map((chat) => ({
            id: chat.view.id,
            kind: 'conversation',
            title: chat.view.title,
            meta: 'Conversation',
            conversation_id: chat.view.id,
          })),
          ...[...this.plans.values()].map((plan) => ({
            id: plan.id,
            kind: 'plan',
            title: plan.title,
            meta: plan.category,
            conversation_id: null,
          })),
          ...[...this.tasks.values()].map((task) => ({
            id: task.id,
            kind: 'task',
            title: task.title,
            meta: 'Task',
            conversation_id: null,
          })),
          ...this.connections().map((connection) => ({
            id: connection.id,
            kind: 'connection',
            title: connection.label,
            meta: connection.app,
            conversation_id: null,
          })),
          ...[...this.chats.values()].flatMap((chat) =>
            chat.events.flatMap((event) =>
              event.item.type === 'action'
                ? [
                    {
                      id: String(event.seq),
                      kind: 'action',
                      title: event.item.label,
                      meta: event.item.meta,
                      conversation_id: chat.view.id,
                    },
                  ]
                : [],
            ),
          ),
        ];
        return {
          results: results
            .filter((row) => `${row.title} ${row.meta}`.toLowerCase().includes(q))
            .slice(0, 100),
        };
      }
      default:
        return C.unavailable(
          key.includes('signin')
            ? 'Use the mock password session; this scenario does not send sign-in mail.'
            : key.includes('browser')
              ? 'Browser tasks are not connected yet.'
              : 'This feature is not connected yet.',
        );
    }
  }
}

export function mountExperienceMock(
  app: Hono,
  deps: AppDeps & { experienceSpeed?: number },
): ExperienceMock {
  const experience = new ExperienceMock(deps);
  for (const [key, operation] of Object.entries(C.experienceOperations)) {
    const [method, path] = key.split(' ') as [string, string];
    app.on(method, path.replace(/\{([^}]+)\}/g, ':$1'), async (c) => {
      let input: Record<string, unknown> = {};
      if ('request' in operation) {
        const parsed = operation.request.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success)
          return c.json(
            { error: { code: 'invalid_request', message: 'Check the information and try again.' } },
            400,
          );
        input = parsed.data;
      }
      if ('query' in operation && !operation.query.safeParse(c.req.query()).success)
        return c.json(
          { error: { code: 'invalid_request', message: 'Check the request and try again.' } },
          400,
        );
      try {
        const body = experience.handle(key, c, input);
        return body instanceof Response
          ? body
          : c.json(C.experienceResult(operation.response).parse(body));
      } catch (error) {
        if (!(error instanceof MockExperienceError)) throw error;
        return c.json(
          { error: { code: 'experience_request_refused', message: error.message } },
          error.status,
        );
      }
    });
  }
  app.get('/events', (c, next) =>
    c.req.query('view') === 'experience'
      ? (() => {
          const result = experience.events(c);
          return result instanceof Response ? result : c.json(result);
        })()
      : next(),
  );
  return experience;
}
