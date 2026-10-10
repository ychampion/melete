/**
 * Running one job: a fresh chat, the task's message, the chat's event stream
 * followed to the end of the turn (and of any background work it started),
 * every permission and question answered by policy, and a hard time budget
 * after which the chat is stopped. Then the evidence is read back, checked,
 * and the chat deleted.
 */
import { randomUUID } from 'node:crypto';
import type {
  ExperienceEvent,
  ExperienceReceipt,
  ResultCard,
  RunView,
  ToolCall,
} from '@melete/contracts';
import { unsupportedClaims } from './claims.ts';
import type { LiveClient } from './client.ts';
import { CHECK_WORDS, stepText } from './tasks.ts';
import {
  type Env,
  type Evidence,
  type HandOff,
  type JobRecord,
  MODEL_CLASS,
  type Outcome,
  type Policy,
  type Task,
  type Vars,
  WANTED_MODELS,
} from './types.ts';

export const DEFAULT_POLICY: Policy = {
  approvals: 'allow',
  answer: "Go ahead with your best judgement. I can't help further right now.",
};

const TERMINAL_TURN = new Set(['done', 'failed', 'stopped']);
const TERMINAL_RUN = new Set(['done', 'stopped', 'failed']);
/** How long a turn may sit on needs-you with nothing for the person to answer. */
const IDLE_NEEDS_YOU_MS = 20_000;

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

export function isHandOff(card: ResultCard): boolean {
  return card.meta === 'Needs you' || card.primary_action?.kind === 'take_over';
}

/**
 * When the checked page was first in front of the agent: the end of the first
 * step that reached the host, or failing that the start of the turn.
 */
export function handOffLatency(
  card: { at: string },
  tools: readonly ToolCall[],
  host: string | undefined,
  turnStart: string,
): Pick<HandOff, 'latency_s' | 'last_step_s' | 'measured_from'> {
  const needle = host?.toLowerCase();
  // A page in front of the agent: its browser or its computer, not a plain fetch.
  const reached = needle
    ? tools.filter(
        (tool) =>
          (tool.kind === 'browser' || tool.kind === 'sandbox') &&
          Date.parse(tool.started_at) <= Date.parse(card.at) &&
          stepText({ tools: [tool], receipts: [] })
            .toLowerCase()
            .includes(needle),
      )
    : [];
  const first = reached[0];
  const last = reached.at(-1);
  if (first && last) {
    const at =
      first.ended_at && Date.parse(first.ended_at) <= Date.parse(card.at)
        ? first.ended_at
        : first.started_at;
    return {
      latency_s: Math.max(0, seconds(at, card.at)),
      last_step_s: Math.max(0, seconds(last.started_at, card.at)),
      measured_from: 'page',
    };
  }
  return {
    latency_s: Math.max(0, seconds(turnStart, card.at)),
    last_step_s: null,
    measured_from: 'message',
  };
}

export type JobOptions = {
  index: number;
  env: Env;
  keepChat?: boolean;
  /** Hand an unexpected hand-off straight back this many times, to see what the agent does next. */
  handBack?: number;
  rubric?: (
    task: Task,
    request: string,
    reply: string,
  ) => Promise<{ score: number; reason: string } | null>;
  log?: (line: string) => void;
};

export async function runJob(
  client: LiveClient,
  task: Task,
  options: JobOptions,
): Promise<JobRecord> {
  const started = new Date().toISOString();
  const base: JobRecord = {
    job: options.index,
    task: task.id,
    category: task.category,
    site: task.site,
    outcome: 'error',
    reason: '',
    wall_s: null,
    steps: 0,
    approvals: 0,
    questions: 0,
    handoffs: [],
    unshown_check: false,
    check_expected: task.category === 'human_check' || Boolean(task.challenge_host),
    handed_back: 0,
    wanted_model: WANTED_MODELS[MODEL_CLASS[task.category]],
    model: null,
    claims: [],
    stopped: false,
    rubric: null,
    reply: '',
    tools: [],
    started_at: started,
    cleanup: [],
    spend_usd: null,
  };

  const missing = (task.needs_env ?? []).filter((name) => !options.env[name]);
  if (missing.length) return { ...base, outcome: 'skipped', reason: `needs ${missing.join(', ')}` };

  let vars: Vars = {};
  let siteCleanup: (() => Promise<void>) | undefined;
  try {
    const setup = await task.setup?.(options.env);
    vars = setup?.vars ?? {};
    siteCleanup = setup?.cleanup;
  } catch (error) {
    return { ...base, outcome: 'site_down', reason: `setup: ${(error as Error).message}` };
  }

  const policy: Policy = { ...DEFAULT_POLICY, ...task.policy };
  const spendBefore = await client.spend();
  base.model = await client.activeModel();
  const conversation = await client.createChat(task.title);
  const sentAt = Date.now();
  const budgetEnd = sentAt + task.budget_s * 1000;

  const tools = new Map<string, ToolCall>();
  const cards = new Map<string, ResultCard>();
  const events: ExperienceEvent[] = [];
  const handoffs: HandOff[] = [];
  const seenPermissions = new Set<string>();
  const seenGroups = new Set<string>();
  const seenQuestions = new Set<string>();
  let turnStart: string | null = null;
  let finishedAt: number | null = null;
  let turnStatus = 'queued';
  let needsYouSince: number | null = null;
  let timedOut = false;
  let error: string | null = null;
  let waitingMs = 0;
  let handBacks = 0;
  let waitingOnPerson = false;

  /** Answers whatever this chat is waiting on; returns how many it answered. */
  const answerPending = async (): Promise<number> => {
    let answered = 0;
    for (const permission of await client.permissions()) {
      if (permission.conversation_id !== conversation || seenPermissions.has(permission.id))
        continue;
      seenPermissions.add(permission.id);
      const key = permission.group ?? permission.id;
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        base.approvals++;
      }
      const asked = Date.parse(permission.created_at);
      await client.decide(permission, policy.approvals === 'allow' ? 'allow_once' : 'deny');
      if (Number.isFinite(asked)) waitingMs += Math.max(0, Date.now() - asked);
      answered++;
    }
    for (const question of await client.questions()) {
      if (question.conversation_id !== conversation || seenQuestions.has(question.id)) continue;
      seenQuestions.add(question.id);
      base.questions++;
      await client.answer(question, policy.answer);
      answered++;
    }
    return answered;
  };

  const turnId = await client.send(conversation, task.prompt(vars), randomUUID());
  options.log?.(`  sent; following the chat for up to ${task.budget_s} s`);

  const stream = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    stream.abort();
  }, task.budget_s * 1000);
  // Permissions and questions are polled as well as read from the stream, so one
  // raised while the stream reconnects is still answered.
  const poller = (async () => {
    while (!stream.signal.aborted) {
      try {
        if ((await answerPending()) > 0) needsYouSince = null;
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (
        needsYouSince !== null &&
        Date.now() - needsYouSince > IDLE_NEEDS_YOU_MS &&
        !stream.signal.aborted
      ) {
        finishedAt = Date.now();
        stream.abort();
      }
      await Bun.sleep(3000);
    }
  })();

  try {
    for await (const event of client.follow(conversation, 0, stream.signal)) {
      events.push(event);
      turnStart ??= event.created_at;
      const item = event.item;
      if (item.type === 'tool') tools.set(item.tool.id, item.tool);
      else if (item.type === 'action' && item.tool) tools.set(item.tool.id, item.tool);
      else if (item.type === 'card') {
        cards.set(item.card.id, item.card);
        if (isHandOff(item.card)) {
          handoffs.push({
            at: event.created_at,
            title: item.card.title,
            about: item.card.facts.find((fact) => fact.label === 'About')?.value ?? null,
            ...handOffLatency(
              { at: event.created_at },
              [...tools.values()],
              task.challenge_host,
              turnStart,
            ),
          });
          const action = item.card.primary_action;
          if (
            task.category !== 'human_check' &&
            handBacks < (options.handBack ?? 0) &&
            action?.kind === 'take_over'
          ) {
            // A person who looks, finds nothing to do, and hands it straight back.
            const surface = action.surface === 'computer' ? 'sandbox' : 'browser';
            await client.takeOver(surface, action.handle).catch(() => undefined);
            await Bun.sleep(2000);
            await client.handBack(surface, action.handle).catch(() => undefined);
            handBacks++;
            needsYouSince = null;
            continue;
          }
          // Nobody is there to take over: the job ends here, as it would for a person away.
          finishedAt = Date.now();
          waitingOnPerson = true;
          break;
        }
      } else if (item.type === 'permission' || item.type === 'question') {
        void answerPending().catch(() => undefined);
      } else if (item.type === 'status') {
        if (event.turn_id && event.turn_id !== turnId) continue;
        turnStatus = item.status;
        if (TERMINAL_TURN.has(item.status)) {
          finishedAt = Date.now();
          break;
        }
        needsYouSince = item.status === 'needs_you' ? Date.now() : null;
      }
    }
  } catch (caught) {
    error = (caught as Error).message;
  } finally {
    stream.abort();
    clearTimeout(timer);
    await poller;
  }

  // Background work the turn started reports to the chat later; wait for it within the budget.
  let runs: RunView[] = [];
  if (!timedOut && !waitingOnPerson && turnStatus === 'done') {
    try {
      runs = await client.runs(conversation);
      while (runs.some((run) => !TERMINAL_RUN.has(run.status)) && Date.now() < budgetEnd) {
        await answerPending().catch(() => 0);
        await Bun.sleep(10_000);
        runs = await client.runs(conversation);
      }
      if (runs.some((run) => !TERMINAL_RUN.has(run.status))) timedOut = true;
      else if (runs.length) {
        const ends = runs.flatMap((run) => (run.finished_at ? [Date.parse(run.finished_at)] : []));
        if (ends.length) finishedAt = Math.max(finishedAt ?? 0, ...ends);
      }
    } catch (caught) {
      error ??= `runs: ${(caught as Error).message}`;
    }
  }

  if (timedOut || (!finishedAt && !waitingOnPerson)) {
    base.stopped = true;
    await client.stop(conversation).catch(() => undefined);
    for (const run of runs.filter((entry) => !TERMINAL_RUN.has(entry.status)))
      await client.stopRun(run.id).catch(() => undefined);
  } else if (waitingOnPerson) {
    // The hand-off waits on a person who is not coming; stopping releases what it holds.
    base.stopped = true;
    await client.stop(conversation).catch(() => undefined);
  }

  // Read back what the person's own app would show.
  let receipts: ExperienceReceipt[] = [];
  let reply = '';
  try {
    await Bun.sleep(1500);
    const turn = (await client.turns(conversation)).find((entry) => entry.id === turnId);
    reply = turn?.answer ?? '';
    receipts = await client.receipts(conversation);
    for (const card of await client.cards(conversation)) cards.set(card.id, card);
    if (!runs.length) runs = await client.runs(conversation).catch(() => []);
  } catch (caught) {
    error ??= `read back: ${(caught as Error).message}`;
  }
  const results = runs.flatMap((run) => (run.result ? [run.result] : []));
  if (results.length) reply = [reply, ...results].filter(Boolean).join('\n\n');

  const allTools = [...tools.values()];
  const evidence: Evidence = {
    reply,
    tools: allTools,
    receipts,
    cards: [...cards.values()],
    runs,
    handoffs,
    events,
  };

  let outcome: Outcome;
  let reason: string;
  try {
    const verdict = await task.check(evidence, vars, options.env);
    if (task.category === 'human_check') {
      outcome = verdict.pass ? 'pass' : timedOut ? 'timeout' : 'fail';
      reason = verdict.reason;
    } else if (handoffs.length) {
      // Asked of a person is not done end to end, whatever happened after a hand-back.
      outcome = 'handed_off';
      reason = handBacks
        ? `${handoffs[0]?.title ?? ''}; handed back ${handBacks}x with nothing solved, then ${verdict.pass ? 'done' : 'not done'}: ${verdict.reason}`
        : `handed to the person: ${handoffs[0]?.title ?? ''}`;
    } else if (timedOut) {
      outcome = 'timeout';
      reason = `stopped at the ${task.budget_s} s budget (${verdict.reason})`;
    } else if (error && !reply) {
      outcome = 'error';
      reason = error;
    } else {
      outcome = verdict.pass ? 'pass' : 'fail';
      reason =
        turnStatus === 'done' || verdict.pass
          ? verdict.reason
          : `turn ${turnStatus}: ${verdict.reason}`;
    }
  } catch (caught) {
    outcome = 'error';
    reason = `check: ${(caught as Error).message}`;
  }

  const wall =
    finishedAt === null ? (Date.now() - sentAt) / 1000 : (finishedAt - sentAt - waitingMs) / 1000;
  const shownCheck = CHECK_WORDS.test(stepText(evidence)) || CHECK_WORDS.test(reply);

  const cleanup: string[] = [];
  if (siteCleanup)
    await siteCleanup()
      .then(() => cleanup.push(`${task.site}: removed what the job made`))
      .catch((caught) =>
        cleanup.push(`${task.site}: clean-up failed (${(caught as Error).message})`),
      );
  for (const card of evidence.cards)
    if (
      !isHandOff(card) &&
      [card.primary_action, ...card.secondary_actions].some((a) => a?.kind === 'download')
    )
      cleanup.push(`file:${card.title}`);
  if (!options.keepChat)
    await client
      .deleteChat(conversation)
      .catch((caught) => cleanup.push(`chat not deleted (${(caught as Error).message})`));

  const spendAfter = await client.spend();
  return {
    ...base,
    outcome,
    reason,
    wall_s: Math.max(0, Math.round(wall * 10) / 10),
    steps: allTools.filter((tool) => tool.kind !== 'model').length,
    handoffs,
    unshown_check: shownCheck && handoffs.length === 0,
    handed_back: handBacks,
    claims: unsupportedClaims(reply, evidence),
    rubric:
      options.rubric && task.rubric && reply
        ? await options.rubric(task, task.prompt(vars), reply).catch(() => null)
        : null,
    reply,
    tools: allTools.map((tool) => ({ kind: tool.kind, title: tool.title, status: tool.status })),
    cleanup,
    spend_usd:
      spendBefore === null || spendAfter === null
        ? null
        : Math.round((spendAfter - spendBefore) * 10000) / 10000,
  };
}
