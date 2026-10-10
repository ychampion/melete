/**
 * The shapes the live benchmark passes around. A job is one task run once in
 * one fresh chat on a live install; its evidence is what the person's own app
 * could see (the event stream, the receipts, the cards and the final answer),
 * plus whatever the task's check read back from the site afterwards.
 */
import type {
  ExperienceEvent,
  ExperienceReceipt,
  ResultCard,
  RunView,
  ToolCall,
} from '@melete/contracts';

export type Category = 'errand' | 'human_check' | 'research' | 'everyday';
export const CATEGORIES: readonly Category[] = ['errand', 'human_check', 'research', 'everyday'];

/** Values made fresh for each job, so a check can tell this job's effect from anyone else's. */
export type Vars = Record<string, string>;

/** How the runner answers what the agent asks the person. */
export type Policy = {
  /** Every permission card is answered this way. */
  approvals: 'allow' | 'deny';
  /** The words sent back to a question that takes free text. */
  answer: string;
};

/** A deterministic verdict, with the reason in plain words. */
export type Verdict = { pass: boolean; reason: string };

/** The result of reading the site before the job, when the task needs to. */
export type Setup = { vars: Vars; cleanup?: () => Promise<void> };

export type Task = {
  id: string;
  category: Category;
  /** One line on what it asks, for the report. */
  title: string;
  /** The public site the task works on, for the preflight and the report. */
  site: string;
  /** Seconds; past it the chat is stopped and the job counts as timed out. */
  budget_s: number;
  /** Names of environment variables the task needs; missing ones skip it with the reason. */
  needs_env?: readonly string[];
  /**
   * A host where a human check (captcha, bot check, 2FA) is expected. A hand-off
   * there is the outcome a human-check task wants, and is timed against the bar.
   */
  challenge_host?: string;
  /** The task starts background work; the job waits for it within the budget. */
  background?: boolean;
  policy?: Partial<Policy>;
  /** Reads the site (or makes unique values) before the job starts. */
  setup?: (env: Env) => Promise<Setup>;
  prompt: (vars: Vars) => string;
  /** The deterministic check: the site's state after the run, or the receipts and answer. */
  check: (evidence: Evidence, vars: Vars, env: Env) => Promise<Verdict> | Verdict;
  /** What a model grader is asked, when `--rubric` is on. */
  rubric?: string;
};

/** What a task may read from the runner's environment, never written anywhere. */
export type Env = Record<string, string | undefined>;

/** A hand-off to the person: a card that says the work needs them, and when it arrived. */
export type HandOff = {
  at: string;
  title: string;
  /** Seconds from the first step that reached the checked page to the card, when it could be told. */
  latency_s: number | null;
  /** What the latency was measured from. */
  /** Seconds from the start of the last step on that page (usually the one that saw the check) to the card. */
  last_step_s: number | null;
  measured_from: 'page' | 'message';
};

export type Evidence = {
  /** The final answer of the turn, plus a background result when there was one. */
  reply: string;
  /** Every tool entry, latest copy per id, in the order first seen. */
  tools: ToolCall[];
  receipts: ExperienceReceipt[];
  cards: ResultCard[];
  runs: RunView[];
  handoffs: HandOff[];
  /** Raw events, kept for the JSON artifact. */
  events: ExperienceEvent[];
};

export type Outcome =
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'handed_off'
  | 'error'
  | 'skipped'
  | 'site_down';

/** One claim in the reply that names an action or a method with nothing behind it. */
export type Claim = {
  kind: 'delivery' | 'action' | 'method';
  phrase: string;
  sentence: string;
  /** What would have backed it. */
  wanted: string;
};

export type JobRecord = {
  job: number;
  task: string;
  category: Category;
  site: string;
  outcome: Outcome;
  reason: string;
  /** Seconds from send to the final answer (or to the stop), minus time spent waiting on answers. */
  wall_s: number | null;
  steps: number;
  approvals: number;
  questions: number;
  handoffs: HandOff[];
  /** True when the steps showed a human check (captcha words) and no hand-off card followed. */
  unshown_check: boolean;
  /** The task meets a human check by design; only these hand-offs are timed against the bar. */
  check_expected: boolean;
  /** Hand-offs given straight back (`--hand-back`). */
  handed_back: number;
  claims: Claim[];
  stopped: boolean;
  rubric: { score: number; reason: string } | null;
  reply: string;
  tools: { kind: string; title: string; status: string }[];
  started_at: string;
  cleanup: string[];
  /** Model spend the install recorded for this account while the job ran, in dollars. */
  spend_usd: number | null;
};

export type BarStatus = 'pass' | 'fail' | 'not_measured';
export type Bar = {
  id: string;
  label: string;
  target: string;
  value: string;
  n: number;
  status: BarStatus;
};

export type RunResult = {
  started_at: string;
  finished_at: string;
  install: { version: string | null; host: string };
  mode: 'once' | 'sample';
  seed: number;
  spend_cap_usd: number;
  spend_usd: number | null;
  stopped_for_spend: boolean;
  jobs: JobRecord[];
  bars: Bar[];
  cleanup: string[];
};
