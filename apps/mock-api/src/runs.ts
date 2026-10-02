/**
 * Long work in the mock: three pieces seeded at different stages (one well
 * under way with tries, helpers and an update; one waiting on the person; one
 * finished), plus whatever is started through POST /runs. Pausing, resuming,
 * stopping, replying and setting a limit change the view the way the service
 * does, and the record pages and exports like the service's.
 */
import * as C from '@melete/contracts';
import { newId } from './store.ts';

type Entry = C.RunEntry & { seq: number };
type Stored = { view: C.RunView; entries: Entry[]; paused: boolean };
type Experiment = C.RunView['experiments']['recent'][number];

/** What the export calls each part of the record, as the service does. */
const ENTRY_LABELS: Record<C.RunEntryKind, string> = {
  plan: 'Plan',
  note: 'Note',
  finding: 'Found',
  decision: 'Decided',
  experiment: 'Tried',
  report: 'Update',
  checkpoint: 'Progress saved',
  step_started: 'Helper started',
  step_finished: 'Helper finished',
  finished: 'Done',
};

/** Entries per page of the record, small so paging shows with the fixtures. */
export const RECORD_PAGE = 8;

export class MockRunError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** The service's one plain line on where the work stands. */
export function runStatusLine(view: C.RunView, paused: boolean): string {
  const { count, best } = view.experiments;
  const tried =
    count > 0
      ? `${count} ${count === 1 ? 'try' : 'tries'}${
          best?.value != null
            ? `, best ${view.metric ? `${view.metric.name} ` : ''}${best.value}`
            : ''
        }`
      : null;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  switch (view.status) {
    case 'done':
      return join('Done', tried);
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'It could not go on';
    case 'needs_you':
      return view.question ?? 'Waiting for you';
    case 'working':
      return join('Working on it', tried);
    default: {
      if (paused) return join('Paused', tried);
      const helpers = view.steps.filter((step) => step.status === 'working').length;
      if (helpers > 0)
        return join(`Waiting for ${helpers} helper${helpers === 1 ? '' : 's'}`, tried);
      return join(view.next_shift_at ? 'Picks up again later' : 'Waiting', tried);
    }
  }
}

export class MockRuns {
  readonly runs = new Map<string, Stored>();

  constructor(private readonly clock: () => Date) {}

  private iso(minutesAgo = 0) {
    return new Date(this.clock().getTime() - minutesAgo * 60_000).toISOString();
  }

  private required(id: string): Stored {
    const run = this.runs.get(id);
    if (!run) throw new MockRunError(404, 'This work is no longer available.');
    return run;
  }

  private refresh(run: Stored) {
    run.view.status_line = runStatusLine(run.view, run.paused);
    return { run: C.runView.parse(run.view) };
  }

  private add(
    run: Stored,
    minutesAgo: number,
    kind: C.RunEntryKind,
    title: string,
    body = '',
    data: Record<string, unknown> = {},
    stepId: string | null = null,
  ) {
    const seq = run.entries.length + 1;
    run.entries.push({
      seq,
      id: `entry_${seq}_${run.view.id}`,
      kind,
      title,
      body,
      step_id: stepId,
      data,
      created_at: this.iso(minutesAgo),
    });
  }

  private blank(input: {
    title: string;
    goal: string;
    done_when?: string | null;
    status: C.RunStatus;
    conversation_id?: string | null;
    agent_id?: string | null;
    started: number;
    metric?: C.RunMetric | null;
  }): Stored {
    const view: C.RunView = {
      id: newId('job'),
      title: input.title,
      goal: input.goal,
      done_when: input.done_when ?? null,
      status: input.status,
      status_line: '',
      conversation_id: input.conversation_id ?? null,
      agent_id: input.agent_id ?? null,
      started_at: this.iso(input.started),
      finished_at: null,
      next_shift_at: null,
      shifts: 0,
      metric: input.metric ?? null,
      limit: null,
      plan: null,
      latest_report: null,
      next: null,
      result: null,
      experiments: { count: 0, best: null, recent: [] },
      findings: 0,
      steps: [],
      question: null,
    };
    const run: Stored = { view, entries: [], paused: false };
    this.runs.set(view.id, run);
    return run;
  }

  private tried(
    run: Stored,
    minutesAgo: number,
    title: string,
    value: number,
    outcome: 'kept' | 'discarded' | 'failed',
    checked: boolean,
    hypothesis: string,
  ): Experiment {
    this.add(run, minutesAgo, 'experiment', title, '', { hypothesis, value, outcome, checked });
    return {
      id: run.entries.at(-1)?.id ?? newId('entry'),
      title,
      value,
      outcome,
      checked,
      created_at: this.iso(minutesAgo),
    };
  }

  /** Three pieces of work at different stages; the first belongs to `conversationId`. */
  seed(conversationId: string | null, agentId: string | null) {
    // Well under way: tries, two helpers, an update and what comes next.
    const kyoto = this.blank({
      title: 'Kyoto trip under budget',
      goal: 'Find the cheapest good way to do two weeks in Japan in October: flights, three nights in a ryokan, and rail between the cities.',
      done_when: 'A full itinerary under $3,200 with every booking link checked',
      status: 'working',
      conversation_id: conversationId,
      agent_id: agentId,
      started: 26 * 60,
      metric: { name: 'price', direction: 'lower' },
    });
    const plan =
      '1. Price flights for a few date pairs and both airports.\n2. Shortlist ryokan with October openings.\n3. Compare a rail pass with single tickets.\n4. Put the cheapest full trip together and check every link.';
    kyoto.view.plan = plan;
    this.add(kyoto, 26 * 60 - 2, 'plan', 'How I’ll go about it', plan);
    this.add(
      kyoto,
      25 * 60,
      'finding',
      'Osaka is cheaper to fly into than Tokyo',
      'Across six date pairs, Osaka (KIX) averaged $310 less than Tokyo for the same dates.',
    );
    const ryokanId = newId('job');
    const railId = newId('job');
    this.add(kyoto, 24 * 60, 'step_started', 'Compare ryokan prices', '', {}, ryokanId);
    this.add(
      kyoto,
      24 * 60,
      'step_started',
      'Check a rail pass against single tickets',
      '',
      {},
      railId,
    );
    const recent: Experiment[] = [];
    recent.push(
      this.tried(
        kyoto,
        22 * 60,
        'Fly into Tokyo, single train tickets',
        3412,
        'discarded',
        true,
        'The obvious route, as a baseline.',
      ),
    );
    recent.push(
      this.tried(
        kyoto,
        20 * 60,
        'Fly into Osaka, single train tickets',
        3104,
        'kept',
        true,
        'Osaka flights are cheaper; trains cost the same.',
      ),
    );
    this.add(
      kyoto,
      19 * 60,
      'step_finished',
      'Compare ryokan prices',
      'Three ryokan under $210 a night with October openings. Kinoya has the best reviews.',
      {},
      ryokanId,
    );
    this.add(
      kyoto,
      18 * 60,
      'decision',
      'Book Kinoya for the ryokan nights',
      'Best reviewed of the three and within $15 of the cheapest.',
    );
    this.add(
      kyoto,
      17 * 60,
      'checkpoint',
      'Flights and ryokan priced',
      'Osaka route kept. Ryokan chosen.',
      {
        next: 'Price the rail pass and try a midweek return.',
      },
    );
    recent.push(
      this.tried(
        kyoto,
        3 * 60,
        'Osaka, 7-day rail pass',
        2948,
        'kept',
        true,
        'The pass should cover every long leg.',
      ),
    );
    recent.push(
      this.tried(
        kyoto,
        2 * 60,
        'Osaka, Tuesday return',
        2991,
        'discarded',
        false,
        'Midweek returns are often cheaper.',
      ),
    );
    const report = {
      title: 'Down to $2,948',
      body: 'Flying into Osaka instead of Tokyo saves $310, and a 7-day rail pass covers every long leg. Kinoya is held for the ryokan nights. Still checking whether a later return is cheaper.',
    };
    this.add(kyoto, 90, 'report', report.title, report.body);
    kyoto.view.latest_report = { ...report, created_at: this.iso(90) };
    kyoto.view.next = 'Try a Thursday return and price the ryokan with breakfast included.';
    kyoto.view.experiments = {
      count: 14,
      best: recent[2] ?? null,
      recent: [...recent].reverse(),
    };
    kyoto.view.findings = 3;
    kyoto.view.shifts = 6;
    kyoto.view.steps = [
      {
        id: ryokanId,
        title: 'Compare ryokan prices',
        status: 'done',
        result:
          'Three ryokan under $210 a night with October openings. Kinoya has the best reviews.',
      },
      {
        id: railId,
        title: 'Check a rail pass against single tickets',
        status: 'working',
        result: null,
      },
    ];
    this.refresh(kyoto);

    // Waiting on the person.
    const fence = this.blank({
      title: 'Quotes for the garden fence',
      goal: 'Get three quotes to replace the back garden fence and book the best one for a site visit.',
      done_when: 'A site visit booked with the fencer you pick',
      status: 'needs_you',
      agent_id: agentId,
      started: 3 * 24 * 60,
    });
    this.add(
      fence,
      3 * 24 * 60 - 5,
      'plan',
      'How I’ll go about it',
      'Ask four local fencers for a quote, compare like for like, then book a visit.',
    );
    this.add(
      fence,
      2 * 24 * 60,
      'finding',
      'Oakline is $400 cheaper for the same panels',
      'Oakline $1,850, Hartwood $2,250, Greenline $2,410. Same height and post spacing.',
    );
    const report2 = {
      title: 'Three quotes in',
      body: 'Oakline ($1,850), Hartwood ($2,250) and Greenline ($2,410). Oakline and Hartwood can both come next week.',
    };
    this.add(fence, 5 * 60, 'report', report2.title, report2.body);
    fence.view.latest_report = { ...report2, created_at: this.iso(5 * 60) };
    fence.view.question =
      'Oakline and Hartwood can both come next week. Should I book both for a site visit, or only Oakline, who’s $400 cheaper?';
    fence.view.next = 'Book the site visit you pick.';
    fence.view.findings = 1;
    fence.view.shifts = 3;
    this.refresh(fence);

    // Finished.
    const tutor = this.blank({
      title: 'A Spanish tutor for spring',
      goal: 'Find a Spanish tutor for two evenings a week, under $35 an hour.',
      status: 'done',
      agent_id: agentId,
      started: 6 * 24 * 60,
      metric: { name: 'rating', direction: 'higher' },
    });
    this.add(
      tutor,
      6 * 24 * 60 - 3,
      'plan',
      'How I’ll go about it',
      'Search the main tutoring sites, keep anyone under $35 with evening slots, and compare reviews.',
    );
    const tries = [
      this.tried(tutor, 5 * 24 * 60, 'Tutors on Preply', 4.7, 'discarded', true, ''),
      this.tried(tutor, 5 * 24 * 60 - 60, 'Tutors on italki', 4.9, 'kept', true, ''),
    ];
    const result =
      'Lucía Romero is the best fit: $30 an hour, Tuesday and Thursday evenings, and 4.9 stars from 120 students. Her first trial lesson is free.';
    this.add(tutor, 26 * 60, 'finished', 'Found a tutor', result);
    tutor.view.result = result;
    tutor.view.finished_at = this.iso(26 * 60);
    tutor.view.experiments = { count: 9, best: tries[1] ?? null, recent: [...tries].reverse() };
    tutor.view.findings = 2;
    tutor.view.shifts = 4;
    this.refresh(tutor);
  }

  create(input: Record<string, unknown>) {
    const value = C.runCreateRequest.parse(input);
    const run = this.blank({
      title: value.title ?? value.goal.slice(0, 80),
      goal: value.goal,
      done_when: value.done_when ?? null,
      status: 'working',
      agent_id: value.agent_id ?? null,
      started: 0,
      metric: value.metric ?? null,
    });
    run.view.limit = value.limit ?? null;
    run.view.next = 'Make a plan and start on the first part.';
    return this.refresh(run);
  }

  /** Answers a /runs operation, or undefined for any other. */
  handle(key: string, id: string, input: Record<string, unknown>, query: Record<string, string>) {
    switch (key) {
      case 'GET /runs': {
        const listed = [...this.runs.values()].filter(
          (run) => !query.conversation_id || run.view.conversation_id === query.conversation_id,
        );
        return { runs: listed.map((run) => this.refresh(run).run).reverse() };
      }
      case 'POST /runs':
        return this.create(input);
      case 'GET /runs/{id}':
        return this.refresh(this.required(id));
      case 'GET /runs/{id}/record': {
        const run = this.required(id);
        const after = Number(query.after ?? 0);
        const rest = run.entries.filter((entry) => entry.seq > after);
        const page = rest.slice(0, RECORD_PAGE);
        return {
          entries: page.map(({ seq: _seq, ...entry }) => entry),
          next_cursor: rest.length > RECORD_PAGE ? String(page.at(-1)?.seq ?? after) : null,
        };
      }
      case 'GET /runs/{id}/export':
        return { markdown: this.markdown(this.required(id)) };
      case 'POST /runs/{id}/message': {
        const run = this.required(id);
        if (run.view.status === 'stopped')
          throw new MockRunError(409, 'This work was stopped. Start it again instead.');
        if (run.view.status === 'needs_you') {
          run.view.status = 'working';
          run.view.question = null;
        } else if (run.view.status === 'done' || run.view.status === 'failed') {
          // A message takes finished work up again, out of any pause it ended under.
          run.view.status = 'working';
          run.view.finished_at = null;
          run.paused = false;
        }
        return this.refresh(run);
      }
      case 'POST /runs/{id}/pause': {
        const run = this.required(id);
        if (run.view.status === 'working' || run.view.status === 'waiting') {
          run.paused = true;
          run.view.status = 'waiting';
        }
        return this.refresh(run);
      }
      case 'POST /runs/{id}/resume': {
        const run = this.required(id);
        if (run.paused) {
          run.paused = false;
          run.view.status = 'working';
        }
        return this.refresh(run);
      }
      case 'POST /runs/{id}/stop': {
        const run = this.required(id);
        if (run.view.status !== 'done' && run.view.status !== 'failed') {
          run.view.status = 'stopped';
          run.view.finished_at ??= this.iso();
          run.view.question = null;
          run.paused = false;
          for (const step of run.view.steps)
            if (step.status !== 'done' && step.status !== 'failed') step.status = 'stopped';
        }
        return this.refresh(run);
      }
      case 'PUT /runs/{id}/limit': {
        const run = this.required(id);
        run.view.limit = C.runLimitRequest.parse(input).limit;
        return this.refresh(run);
      }
      default:
        return undefined;
    }
  }

  /** The whole record as one Markdown document, laid out as the service lays it out. */
  markdown(run: Stored): string {
    const view = run.view;
    const steps = new Map(view.steps.map((step) => [step.id, step.title]));
    const lines = [
      `# ${view.title}`,
      '',
      `Goal: ${view.goal}`,
      ...(view.done_when ? [`Done when: ${view.done_when}`] : []),
      `Started: ${view.started_at}`,
      `Status: ${runStatusLine(view, run.paused)}`,
      '',
    ];
    for (const entry of run.entries) {
      const by = entry.step_id ? ` (helper: ${steps.get(entry.step_id) ?? entry.step_id})` : '';
      lines.push(
        `## ${entry.created_at} · ${ENTRY_LABELS[entry.kind] ?? 'Note'}${by}: ${entry.title}`,
        '',
      );
      if (entry.body) lines.push(entry.body, '');
      if (entry.kind === 'experiment') {
        const data = entry.data;
        lines.push(
          ...[
            typeof data.hypothesis === 'string' && data.hypothesis
              ? `Idea: ${data.hypothesis}`
              : null,
            typeof data.value === 'number' ? `Value: ${data.value}` : null,
            `Outcome: ${String(data.outcome ?? '')}`,
            `Confirmed from its output: ${data.checked === true ? 'yes' : 'no'}`,
          ]
            .filter(Boolean)
            .map((fact) => `- ${fact}`),
          '',
        );
      }
      if (entry.kind === 'checkpoint' && typeof entry.data.next === 'string')
        lines.push(`Next: ${entry.data.next}`, '');
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
}
