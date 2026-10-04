/**
 * "What I believe about you" in the mock: a realistic set of beliefs with
 * sources, trust and history, and the same operations the service offers
 * (correct, forget, don't learn again, rewind a day and undo the rewind, the
 * weekly digest, export and import). Days are the profile's local days.
 */
import * as C from '@melete/contracts';
import { newId } from './store.ts';

type Version = { value: string; at: string; source: C.BeliefSource; current: boolean };
type MockBelief = {
  id: string;
  subject: string;
  label: string;
  category: C.BeliefCategory;
  trust: C.BeliefTrust;
  kind: string;
  /** Oldest first; the last one is the current value. */
  versions: Omit<Version, 'current'>[];
  setAside: boolean;
  version: string;
  last_used: string | null;
};
type Step = { belief_id: string; label: string; from: string | null; to: string | null };
type MockRewind = C.MemoryRewind & {
  window: { start: number; end: number; beliefIds: string[] | null };
  /** Per belief, the state before the rewind, so it can be undone exactly. */
  before: Map<string, { versions: number; setAside: boolean }>;
};

const TRUST_LABEL: Record<C.BeliefTrust, string> = {
  yours: 'Your own words',
  connected: 'From an account you connected',
  outside: 'From someone else, not checked',
  worked_out: 'Worked out by me, not confirmed',
};
const CATEGORY_TITLE: Record<C.BeliefCategory, string> = {
  people: 'People',
  preferences: 'Preferences',
  accounts: 'Accounts and bills',
  routines: 'Routines and dates',
  work: 'Work',
  other: 'Everything else',
};

/** Words too common to tie an action to a belief. */
const COMMON = new Set(['your', 'with', 'from', 'this', 'that', 'have', 'will', 'about', 'there']);

export class MockBeliefError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export class MockBeliefs {
  readonly beliefs = new Map<string, MockBelief>();
  readonly blocks = new Map<
    string,
    { id: string; label: string; subject: string; created_at: string }
  >();
  readonly rewinds = new Map<string, MockRewind>();
  /** Notes Melete kept for itself, newest first. */
  readonly notes = new Map<string, C.AgentNote>();
  digest: C.MemoryDigest | null = null;

  constructor(
    readonly now: () => Date,
    readonly timeZone: () => string,
  ) {}

  private day(at: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timeZone(),
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  private short(at: Date) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.timeZone(),
      month: 'short',
      day: 'numeric',
    }).format(at);
  }
  /** The source wording the service uses, for a mock source kind. */
  source(kind: C.BeliefSource['kind'], at: string, link: C.BeliefSource['link'] = null) {
    const day = this.short(new Date(at));
    const text: Record<C.BeliefSource['kind'], string> = {
      setup: `you told me during setup, ${day}`,
      chat: `you told me in chat, ${day}`,
      correction: `you corrected this, ${day}`,
      import: `you imported this, ${day}`,
      email: `from your email, ${day}`,
      calendar: `from your calendar, ${day}`,
      contacts: `from your contacts, ${day}`,
      connected: `from an account you connected, ${day}`,
      receipt: `from a receipt, ${day}`,
      message: `from a message someone sent you, ${day}`,
      document: `from a document, ${day}`,
      assistant: `an assistant you connected saved this, ${day}`,
      worked_out: `I worked this out, ${day}`,
    };
    return C.beliefSource.parse({ kind, text: text[kind], at, link });
  }

  /** A believable week of memory, spread over the last days, with a correction and a change. */
  seed(chatId: string | null) {
    const now = this.now().getTime();
    const ago = (days: number, hours = 0) =>
      new Date(now - days * 86_400_000 - hours * 3_600_000).toISOString();
    const chat = chatId
      ? { kind: 'conversation' as const, id: chatId, label: 'Open “Plan the week”' }
      : null;
    const note: C.AgentNote = {
      id: newId('note'),
      text: 'The school portal only takes PDF uploads under 5 MB; photos of forms have to be converted first.',
      created: ago(2, 3),
      chat: chatId ? { id: chatId, title: 'Plan the week' } : null,
    };
    this.notes.set(note.id, note);
    const add = (
      subject: string,
      label: string,
      category: C.BeliefCategory,
      trust: C.BeliefTrust,
      versions: [string, string, C.BeliefSource['kind'], boolean?][],
      kind = 'user_statement',
    ) => {
      const belief: MockBelief = {
        id: newId('k'),
        subject,
        label,
        category,
        trust,
        kind,
        versions: versions.map(([value, at, source, linked]) => ({
          value,
          at,
          source: this.source(source, at, linked ? chat : null),
        })),
        setAside: false,
        version: newId('v'),
        last_used: null,
      };
      this.beliefs.set(belief.id, belief);
      return belief;
    };
    add('person.maya.birthday', "Maya's birthday", 'people', 'yours', [
      ['March 3', ago(12), 'chat', true],
    ]);
    add('person.maya.relation', 'Maya', 'people', 'yours', [
      ['Your sister, lives in Lisbon', ago(12), 'chat', true],
    ]);
    add('contact.sam.email', "Sam's email", 'people', 'connected', [
      ['sam@example.com', ago(9), 'contacts'],
    ]);
    add(
      'pref.coffee.order',
      'Coffee order',
      'preferences',
      'yours',
      [
        ['Flat white', ago(20), 'setup'],
        ['Oat flat white, no sugar', ago(2, 3), 'correction'],
      ],
      'preference',
    );
    add(
      'pref.meetings.time',
      'Meetings',
      'preferences',
      'yours',
      [['No meetings before 10am', ago(6), 'chat', true]],
      'preference',
    );
    add(
      'pref.travel.seat',
      'Travel: seat',
      'preferences',
      'worked_out',
      [['Prefers an aisle seat on long flights', ago(1, 2), 'worked_out']],
      'inferred',
    );
    add('account.electricity.bill', 'Electricity bill', 'accounts', 'connected', [
      ['About $84 a month, due on the 18th', ago(8), 'email'],
    ]);
    add('account.streaming.plan', 'Streaming subscription', 'accounts', 'connected', [
      ['$11.99 a month, renews on the 2nd', ago(30), 'receipt'],
      ['$13.99 a month, renews on the 2nd', ago(1, 5), 'email'],
    ]);
    add('account.rent', 'Rent', 'accounts', 'yours', [
      ['$2,150, paid on the 1st', ago(15), 'chat', true],
    ]);
    add('routine.gym', 'Gym', 'routines', 'yours', [
      ['Tuesdays and Thursdays at 7am', ago(4), 'chat', true],
    ]);
    add('event.dentist.date', 'Dentist date', 'routines', 'connected', [
      ['Oct 14, 9:30am', ago(1, 1), 'calendar'],
    ]);
    add('work.employer', 'Employer', 'work', 'yours', [
      ['Product designer at a small studio', ago(25), 'setup'],
    ]);
    add('work.standup', 'Team standup', 'work', 'outside', [
      ['Mondays at 9:30, moved from 9:00', ago(0, 2), 'message'],
    ]);
    add('assistant.book.club', 'Book club', 'other', 'outside', [
      ['Reading a new novel for the 20th', ago(3), 'assistant'],
    ]);
    const week = this.digestWeek();
    this.digest = C.memoryDigest.parse({
      id: newId('dgs'),
      week_of: week.weekOf,
      title: "Here's what I learned this week",
      window_start: new Date(week.start).toISOString(),
      window_end: new Date(week.end).toISOString(),
      created_at: new Date(week.end).toISOString(),
      seen_at: null,
      items: this.changesBetween(week.start, week.end).slice(0, 50),
    });
  }

  /** The most recent Sunday 08:00 in the profile's zone, and the week before it. */
  digestWeek() {
    let at = this.now().getTime();
    for (let i = 0; i < 8; i++) {
      const probe = new Date(at);
      const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timeZone(),
        weekday: 'short',
      }).format(probe);
      if (weekday === 'Sun') break;
      at -= 86_400_000;
    }
    const day = this.day(new Date(at));
    const end = Date.parse(`${day}T08:00:00Z`);
    return { weekOf: day, start: end - 7 * 86_400_000, end };
  }

  private current(belief: MockBelief) {
    return belief.versions.at(-1) as Omit<Version, 'current'>;
  }
  view(belief: MockBelief): C.Belief | null {
    if (belief.setAside) return null;
    const current = this.current(belief);
    const trust = current.source.kind === 'correction' ? 'yours' : belief.trust;
    return C.belief.parse({
      id: belief.id,
      label: belief.label,
      value: current.value,
      category: belief.category,
      source: current.source,
      trust,
      trust_label: TRUST_LABEL[trust],
      learned_at: belief.versions[0]?.at ?? current.at,
      changed_at: current.at,
      last_used: belief.last_used,
      corrected: current.source.kind === 'correction',
      disputed: false,
      earlier: belief.versions.length - 1,
      version: belief.version,
    });
  }
  list() {
    return [...this.beliefs.values()]
      .flatMap((belief) => this.view(belief) ?? [])
      .sort((a, b) => b.changed_at.localeCompare(a.changed_at));
  }
  required(id: string) {
    const belief = this.beliefs.get(id);
    if (!belief || belief.setAside)
      throw new MockBeliefError(404, 'This belief is no longer available.');
    return belief;
  }
  correct(id: string, value: string, version: string) {
    const belief = this.required(id);
    if (belief.version !== version) throw new MockBeliefError(409, 'This belief has changed.');
    const at = this.now().toISOString();
    belief.versions.push({ value, at, source: this.source('correction', at) });
    belief.trust = 'yours';
    belief.version = newId('v');
  }
  forget(id: string) {
    this.required(id);
    this.beliefs.delete(id);
  }
  block(id: string) {
    const belief = this.required(id);
    const block = {
      id: newId('blk'),
      label: belief.label,
      subject: belief.subject,
      created_at: this.now().toISOString(),
    };
    this.blocks.set(block.id, block);
    this.beliefs.delete(id);
  }

  /** Every revision recorded in a window, as timeline changes, newest first. */
  changesBetween(start: number, end: number, ids: string[] | null = null) {
    const items: C.MemoryDigest['items'] = [];
    for (const belief of this.beliefs.values()) {
      if (ids && !ids.includes(belief.id)) continue;
      const inWindow = belief.versions.filter(
        (v) => Date.parse(v.at) >= start && Date.parse(v.at) < end,
      );
      const newest = inWindow.at(-1);
      if (!newest || belief.setAside) continue;
      const before = belief.versions.filter((v) => Date.parse(v.at) < start).at(-1);
      const current = this.current(belief) === newest;
      items.push({
        belief_id: belief.id,
        label: belief.label,
        change: !before ? 'learned' : newest.source.kind === 'correction' ? 'corrected' : 'changed',
        value: newest.value,
        previous: before?.value ?? null,
        at: newest.at,
        current,
        version: current ? belief.version : null,
      });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  timeline(days: number): C.MemoryTimeline {
    const since = this.now().getTime() - days * 86_400_000;
    const byDay = new Map<string, { changes: C.BeliefChange[]; rewinds: C.MemoryRewind[] }>();
    const bucket = (day: string) => {
      const entry = byDay.get(day) ?? { changes: [], rewinds: [] };
      byDay.set(day, entry);
      return entry;
    };
    for (const belief of this.beliefs.values())
      belief.versions.forEach((version, index) => {
        if (Date.parse(version.at) < since) return;
        bucket(this.day(new Date(version.at))).changes.push({
          belief_id: belief.id,
          label: belief.label,
          change:
            version.source.kind === 'correction' && index > 0
              ? 'corrected'
              : version.source.text.startsWith('restored')
                ? 'restored'
                : index === 0
                  ? 'learned'
                  : 'changed',
          value: version.value,
          previous: index > 0 ? (belief.versions[index - 1]?.value ?? null) : null,
          at: version.at,
        });
      });
    for (const rewind of this.rewinds.values())
      bucket(this.day(new Date(rewind.created_at))).rewinds.push(this.rewindView(rewind));
    const today = this.day(this.now());
    const yesterday = this.day(new Date(this.now().getTime() - 86_400_000));
    return {
      time_zone: this.timeZone(),
      days: [...byDay.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([day, entry]) => ({
          day,
          label:
            day === today
              ? 'Today'
              : day === yesterday
                ? 'Yesterday'
                : this.short(new Date(`${day}T12:00:00Z`)),
          changes: entry.changes.sort((a, b) => b.at.localeCompare(a.at)),
          rewinds: entry.rewinds,
        })),
    };
  }

  private window(target: C.RewindTarget) {
    if ('day' in target) {
      const start = Date.parse(`${target.day}T00:00:00Z`);
      return {
        start,
        end: start + 86_400_000,
        beliefIds: null,
        label: `Undo what I learned on ${this.short(new Date(start + 43_200_000))}`,
      };
    }
    this.required(target.belief_id);
    return {
      start: Date.parse(target.since),
      end: this.now().getTime() + 60_000,
      beliefIds: [target.belief_id],
      label: `Undo a change since ${this.short(new Date(target.since))}`,
    };
  }
  private plan(window: { start: number; end: number; beliefIds: string[] | null }) {
    const steps: (Step & { keep: number })[] = [];
    for (const belief of this.beliefs.values()) {
      if (belief.setAside || (window.beliefIds && !window.beliefIds.includes(belief.id))) continue;
      const touched = belief.versions.some(
        (v) => Date.parse(v.at) >= window.start && Date.parse(v.at) < window.end,
      );
      if (!touched) continue;
      const keep = belief.versions.filter((v) => Date.parse(v.at) < window.start).length;
      steps.push({
        belief_id: belief.id,
        label: belief.label,
        from: this.current(belief).value,
        to: keep ? (belief.versions[keep - 1]?.value ?? null) : null,
        keep,
      });
    }
    return steps;
  }
  preview(target: C.RewindTarget) {
    const window = this.window(target);
    return {
      label: window.label,
      steps: this.plan(window).map(({ keep: _keep, ...step }) => step),
      skipped: [],
    };
  }
  rewind(target: C.RewindTarget) {
    const window = this.window(target);
    const steps = this.plan(window);
    const before = new Map<string, { versions: number; setAside: boolean }>();
    const at = this.now().toISOString();
    for (const step of steps) {
      const belief = this.beliefs.get(step.belief_id);
      if (!belief) continue;
      before.set(belief.id, { versions: belief.versions.length, setAside: belief.setAside });
      if (step.keep === 0) belief.setAside = true;
      else {
        const prior = belief.versions[step.keep - 1];
        if (prior)
          belief.versions.push({
            value: prior.value,
            at,
            source: { ...prior.source, text: `restored: ${prior.source.text}` },
          });
      }
      belief.version = newId('v');
    }
    const rewind: MockRewind = {
      id: newId('rwd'),
      label: window.label,
      created_at: at,
      undone_at: null,
      steps: steps.map(({ keep: _keep, ...step }) => step),
      skipped: [],
      window,
      before,
    };
    this.rewinds.set(rewind.id, rewind);
    return this.rewindView(rewind);
  }
  undo(id: string) {
    const rewind = this.rewinds.get(id);
    if (!rewind) throw new MockBeliefError(404, 'This rewind is no longer available.');
    if (!rewind.undone_at) {
      for (const [beliefId, state] of rewind.before) {
        const belief = this.beliefs.get(beliefId);
        if (!belief) {
          rewind.skipped.push('A belief it moved was forgotten since, so it was left as it is.');
          continue;
        }
        belief.setAside = state.setAside;
        belief.versions = belief.versions.slice(0, state.versions);
        belief.version = newId('v');
      }
      rewind.undone_at = this.now().toISOString();
    }
    return this.rewindView(rewind);
  }
  rewindView(rewind: MockRewind): C.MemoryRewind {
    const { window: _window, before: _before, ...view } = rewind;
    return C.memoryRewind.parse(view);
  }

  history(id: string) {
    const belief = this.required(id);
    return {
      label: belief.label,
      versions: belief.versions
        .map((version, index) => ({ ...version, current: index === belief.versions.length - 1 }))
        .reverse(),
    };
  }

  /** Beliefs the demo's actions rested on: the ones whose words the action shares. */
  becauseFor(text: string): C.BecauseLink[] {
    const words = new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !COMMON.has(w)),
    );
    const all = this.list();
    const overlapping = all.filter((belief) =>
      `${belief.label} ${belief.value}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => words.has(word) && !COMMON.has(word)),
    );
    // With nothing in common, what a turn is usually handed: recent preferences and routines.
    const chosen = overlapping.length
      ? overlapping
      : all.filter((belief) => belief.category === 'preferences' || belief.category === 'routines');
    return chosen.slice(0, 3).map((belief) => ({
      kind: 'belief' as const,
      id: belief.id,
      label: `${belief.label}: ${belief.value}`.slice(0, 120),
      basis: 'recalled' as const,
    }));
  }

  exportFile(): C.BeliefFile {
    return C.beliefFile.parse({
      format: C.BELIEF_FILE_FORMAT,
      version: 1,
      exported_at: this.now().toISOString(),
      beliefs: this.list().map((view) => {
        const belief = this.beliefs.get(view.id) as MockBelief;
        return {
          label: view.label,
          value: view.value,
          category: view.category,
          subject: belief.subject,
          key: C.isMemoryKey(belief.subject) ? belief.subject : null,
          kind: belief.kind,
          trust: view.trust,
          source: view.source.text,
          learned_at: view.learned_at,
          history: belief.versions.slice(0, -1).map(({ value, at }) => ({ value, at })),
        };
      }),
    });
  }
  exportContent(format: 'json' | 'markdown') {
    const file = this.exportFile();
    const day = file.exported_at.slice(0, 10);
    if (format === 'json')
      return {
        format,
        filename: `melete-beliefs-${day}.json`,
        content: `${JSON.stringify(file, null, 2)}\n`,
      };
    const lines = ['# What Melete believes about you', '', `Exported ${day}.`];
    for (const category of C.BELIEF_CATEGORIES) {
      const entries = file.beliefs.filter((entry) => entry.category === category);
      if (!entries.length) continue;
      lines.push('', `## ${CATEGORY_TITLE[category]}`, '');
      for (const entry of entries)
        lines.push(
          `- **${entry.label}**: ${entry.value} (${entry.source}) <!-- ${entry.subject} -->`,
        );
    }
    return { format, filename: `melete-beliefs-${day}.md`, content: `${lines.join('\n')}\n` };
  }
  import(input: { format: 'json' | 'markdown'; content: string }) {
    let entries: {
      label: string;
      value: string;
      subject: string;
      category: C.BeliefCategory;
      kind: string;
    }[] = [];
    if (input.format === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.content);
      } catch {
        throw new MockBeliefError(400, 'This is not a belief file Melete exported.');
      }
      const file = C.beliefFile.safeParse(parsed);
      if (!file.success)
        throw new MockBeliefError(400, 'This is not a belief file Melete exported.');
      entries = file.data.beliefs;
    } else {
      let category: C.BeliefCategory = 'other';
      for (const line of input.content.split(/\r?\n/)) {
        const heading = /^##\s+(.+)$/.exec(line.trim());
        if (heading) {
          category =
            (Object.entries(CATEGORY_TITLE).find(
              ([, title]) => title === heading[1]?.trim(),
            )?.[0] as C.BeliefCategory | undefined) ?? 'other';
          continue;
        }
        const item =
          /^[-*]\s+\*\*(.+?)\*\*:\s*(.+?)\s*(?:\(([^()]*)\))?\s*(?:<!--\s*(.+?)\s*-->)?$/.exec(
            line.trim(),
          );
        if (item?.[1] && item[2])
          entries.push({
            label: item[1],
            value: item[2],
            subject: item[4] ?? `imported.${item[1].toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
            category,
            kind: category === 'preferences' ? 'preference' : 'user_statement',
          });
      }
      if (!entries.length) throw new MockBeliefError(400, 'No beliefs were found in this file.');
    }
    let imported = 0;
    let skipped = 0;
    const notes: string[] = [];
    const at = this.now().toISOString();
    for (const entry of entries) {
      const existing = [...this.beliefs.values()].find(
        (b) => b.subject === entry.subject && !b.setAside,
      );
      if ([...this.blocks.values()].some((block) => block.subject === entry.subject)) {
        skipped++;
        notes.push(`${entry.label}: you asked me not to learn this again.`);
        continue;
      }
      if (existing) {
        skipped++;
        if (this.current(existing).value !== entry.value)
          notes.push(`${entry.label}: you already have a different value, so yours was kept.`);
        continue;
      }
      const belief: MockBelief = {
        id: newId('k'),
        subject: entry.subject,
        label: entry.label,
        category: entry.category,
        trust: 'yours',
        kind: entry.kind,
        versions: [{ value: entry.value, at, source: this.source('import', at) }],
        setAside: false,
        version: newId('v'),
        last_used: null,
      };
      this.beliefs.set(belief.id, belief);
      imported++;
    }
    return { imported, skipped, notes: notes.slice(0, 50) };
  }

  /** The belief operations; undefined for any other key. */
  handle(key: string, id: string, input: Record<string, unknown>, query: Record<string, string>) {
    switch (key) {
      case 'GET /memory/beliefs':
        return { beliefs: this.list(), time_zone: this.timeZone() };
      case 'GET /memory/beliefs/{id}/history':
        return this.history(id);
      case 'POST /memory/beliefs/{id}/block':
        this.block(id);
        return { status: 'ok' };
      case 'GET /memory/notes':
        return {
          notes: [...this.notes.values()].sort((a, b) => b.created.localeCompare(a.created)),
        };
      case 'DELETE /memory/notes/{id}':
        if (!this.notes.delete(id)) throw new MockBeliefError(404, 'This note is already gone.');
        return { status: 'ok' };
      case 'GET /memory/blocks':
        return {
          blocks: [...this.blocks.values()].map(({ subject: _subject, ...block }) => block),
        };
      case 'DELETE /memory/blocks/{id}':
        if (!this.blocks.delete(id)) throw new MockBeliefError(404, 'This is no longer blocked.');
        return { status: 'ok' };
      case 'GET /memory/timeline':
        return this.timeline(Math.min(Math.max(Number(query.days ?? 30), 1), 90));
      case 'POST /memory/rewind/preview':
        return this.preview(C.rewindTarget.parse(input));
      case 'POST /memory/rewind':
        return { rewind: this.rewind(C.rewindTarget.parse(input)) };
      case 'POST /memory/rewinds/{id}/undo':
        return { rewind: this.undo(id) };
      case 'GET /memory/digest': {
        const week = this.digestWeek();
        const digest = this.digest
          ? {
              ...this.digest,
              items: this.digest.items.map((item) => {
                const belief = this.beliefs.get(item.belief_id);
                const current = Boolean(
                  belief && !belief.setAside && this.current(belief).value === item.value,
                );
                return { ...item, current, version: current && belief ? belief.version : null };
              }),
            }
          : null;
        return { digest, next_at: new Date(week.end + 7 * 86_400_000).toISOString() };
      }
      case 'POST /memory/digest/{id}/seen':
        if (!this.digest || this.digest.id !== id)
          throw new MockBeliefError(404, 'This digest is no longer available.');
        this.digest.seen_at ??= this.now().toISOString();
        return { status: 'ok' };
      case 'GET /memory/export':
        return this.exportContent(query.format === 'markdown' ? 'markdown' : 'json');
      case 'POST /memory/import':
        return this.import(C.beliefImport.parse(input));
      case 'PATCH /memory/items/{id}':
        if (!this.beliefs.has(id)) return undefined;
        this.correct(id, String(input.value), String(input.version));
        return { status: 'ok' };
      case 'DELETE /memory/items/{id}':
        if (!this.beliefs.has(id)) return undefined;
        this.forget(id);
        return { status: 'ok' };
      default:
        return undefined;
    }
  }
}
