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
  seq = 0;
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
  now() {
    return this.deps.store.now().toISOString();
  }
  event(chat: Chat, item: C.ExperienceEvent['item']) {
    chat.events.push(
      C.experienceEvent.parse({
        seq: ++this.seq,
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
      events: [],
      cards: [],
      receipts: [],
      drafts: [],
      position: 0,
      pending: [],
      paused: false,
      stopped: false,
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
  finish(chat: Chat, summary: string) {
    this.flush(chat);
    const turn = chat.turns.at(-1);
    if (turn) turn.answer = summary;
    this.event(chat, { type: 'text_delta', text: summary });
    const sources = chat.events.flatMap((event) =>
      event.item.type === 'action' ? event.item.sources : [],
    );
    this.event(chat, {
      type: 'done',
      summary,
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
    if (step.step === 'text') {
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
      if (step.kind === 'email.send' || step.kind === 'email.draft') {
        const to = step.payload.to;
        const draft = C.experienceDraft.parse({
          id: newId('draft'),
          recipient: Array.isArray(to) ? to.join(', ') : plainText(to, 'Recipient'),
          channel: 'email',
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
      this.finish(chat, plainText(step.answer, 'Your request is ready.'));
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
    chat.script = chooseScenario(this.deps.scenarios, `${chat.view.title} ${input.text}`);
    chat.position = 0;
    chat.paused = false;
    chat.stopped = false;
    const result = C.messageAcceptance.parse({
      turn_id: turn.id,
      receipt: { id: newId('sub'), status: 'accepted', received_at: this.now() },
    });
    if (key) this.submissions.set(fingerprint, { text: input.text, result });
    this.state(chat, 'working');
    this.event(chat, {
      type: 'say',
      text: 'Iâ€™ll check what you need and prepare the next step.',
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
      this.event(chat, {
        type: 'note',
        text: 'The send could not be confirmed. It has not been repeated.',
      });
      this.state(chat, 'needs_you');
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
        return C.unavailable('This scenario has no reversible external change.');
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
          upcoming: C.unavailable('No calendar is connected in this scenario.'),
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
