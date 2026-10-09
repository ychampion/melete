import type { JsonObject, JsonValue } from '@melete/contracts';

export const SUITES = [
  'asks',
  'approval',
  'unknown',
  'memory',
  'waits',
  'injection',
  'briefing',
  'naturalness',
  'capability',
] as const;
export type Suite = (typeof SUITES)[number];
export type Domain = 'calendar' | 'mail' | 'files' | 'web' | 'watch' | 'server';
/** One argument of a fixture tool. */
export type FixtureField = {
  description: string;
  required?: boolean;
  type?: 'string' | 'integer' | 'number' | 'boolean';
};
/**
 * A tool a capability scenario's fixture connection offers. `mirror` copies the
 * name, description, schema and effect class of a tool the product ships, so
 * the model sees what it would see in a real space; the fixture only supplies
 * what the call returns.
 */
export type FixtureTool = {
  name: string;
  mirror?: string;
  description?: string;
  effect_class?: 'read' | 'write_reversible' | 'write_external' | 'spend';
  fields?: Record<string, FixtureField>;
  /** What a succeeded call returns. A read returns it as its records. */
  result?: JsonValue;
  /** Results chosen by the value of one argument, such as a URL or a path. */
  results_by?: { argument: string; results: Record<string, JsonValue> };
  /**
   * Only a call whose argument matches this pattern (case-insensitive) gets
   * `result` and `delay_ms`. Any other call gets the first `otherwise` entry
   * whose pattern matches, or the one without a pattern, at once.
   */
  when?: {
    argument: string;
    matches: string;
    otherwise: { matches?: string; result: JsonValue }[];
  };
  /** How long the call takes, to measure a long command finishing once. */
  delay_ms?: number;
};
/** What a scenario needs from the product; without it the cell is skipped, never failed. */
export type Requirement = { tool: string } | { feature: 'attachments' | 'browser' };
/**
 * A step of the scripted plan. A string `{"$ref": "a.b"}` reads the latest tool
 * result that has it. `turn` places it in one message of a conversation: 0 is
 * the objective, 1 the first message of `history`, and so on. Left out, a plan
 * is counted across the whole attempt.
 */
export type ScriptedStep = { tool: string; arguments: JsonObject; turn?: number };
/** A deterministic check on the broker's ledger: which tools ran, how often, with what. */
export type CallExpectation = {
  tool: string;
  min?: number;
  max?: number;
  /** Count only actions in this status. */
  status?: string;
  /** Count only actions whose payload has these fields containing these words. */
  where?: Record<string, string>;
  /** Count only actions whose receipt detail has these fields equal to these values. */
  receipt?: Record<string, string>;
  /** Count only actions whose receipt detail has these fields containing these words. */
  receipt_contains?: Record<string, string>;
  /**
   * Where to count. `job` (the default) is the graded job's ledger; `space` is
   * every job in the scenario's space, background work included; `engine` is
   * every tool call the light engine made for the graded job, broker-owned
   * ones such as `memory.search` included, matched on arguments (`where`) and
   * on words in the result (`result_contains`).
   */
  scope?: 'job' | 'space' | 'engine';
  result_contains?: string;
};
/** A detail memory holds before the first message, as if the person had said it in an earlier chat. */
export type MemoryFact = { key: string; content: string };
/**
 * Background work the scenario's conversation starts or owns, driven by the
 * lab: every job of the space is woken until it rests. The scripted provider
 * plays each role with its own plan.
 */
export type Background = {
  /** The plan of the work's first shift. */
  steps?: ScriptedStep[];
  /** After the approval in `approve` is given: the plan of the shift that resumes. */
  after_approval?: ScriptedStep[];
  /** The plan of a separate check of the work's result, when it runs one. */
  check?: ScriptedStep[];
  /** Fire the work's schedule once after the first turn, as its time coming round would. */
  fire_schedule?: boolean;
  /** Approve the first parked proposal of this kind in the work, checking these payload fields. */
  approve?: { kind: string; fields?: Record<string, string> };
};
export type Scenario = {
  id: string;
  suite: Suite;
  domain: Domain;
  title: string;
  objective: string;
  source: JsonObject;
  script: {
    tool: 'read' | 'write' | 'draft' | 'memory' | 'none';
    arguments: JsonObject;
    reply?: string;
  };
  expectation: {
    ask: 'required' | 'forbidden' | 'optional';
    effects: number;
    read?: boolean;
    words?: string[];
    forbidden_words?: string[];
    max_words?: number;
    outcome?: string;
  };
  action?: 'approve' | 'deny' | 'bad_hash' | 'stale_revision' | 'mutate_payload';
  followup?: string;
  drop_ack?: boolean;
  memory?: {
    key: string;
    old: string;
    corrected: string;
    query: string;
    correct_when?: 'waiting';
  };
  trigger?: { name: string; payload: JsonObject };
  rubric: string;
  /**
   * Model turns the engine allows one run of this scenario, when a task needs
   * more steps than the suite's default ceiling (`DEFAULT_MAX_TURNS`).
   */
  max_turns?: number;
  /** Capability scenarios: the fixture connection's own tools. */
  tools?: FixtureTool[];
  requires?: Requirement[];
  /** The scripted provider's plan, one tool call per step, then `script.reply`. */
  steps?: ScriptedStep[];
  /** Held as a conversation, as a chat is, even with no earlier messages. */
  chat?: boolean;
  /** Earlier messages from the person, posted before the first turn. */
  history?: string[];
  /** A PDF, page by page, sent with the last message of `history`. */
  attach?: { name: string; pages: string[] };
  /** Approve the first parked proposal of this kind, checking these payload fields. */
  approve?: { kind: string; fields?: Record<string, string> };
  /** The scripted reply to each earlier message of a conversation whose plan has steps, by turn. */
  replies?: string[];
  /**
   * The fixture connection's provider, when the tier a tool lands in depends on
   * it: `sandbox` is the agent's own computer. Left out, it is `test`.
   */
  provider?: 'test' | 'sandbox';
  /**
   * The space's own agent, set to ask before acting as a new space's is, so the
   * approval policy decides each change as it does in a conversation.
   */
  agent?: { asks_before_acting: boolean };
  /** Built-in connections the product gives a personal space, with their real connectors. */
  builtin?: 'skills'[];
  /** Details memory holds before the first message. */
  memory_facts?: MemoryFact[];
  /** Offer each message the person sends to memory, as the service does, so a request to forget is acted on. */
  capture?: boolean;
  /**
   * After the graded turn, let memory read what the person said, as it does in
   * the background. `reply` is the scripted extractor's answer; a real model
   * reads it with the product's own extraction instructions.
   */
  extract?: { reply: JsonObject };
  background?: Background;
  checks?: {
    calls?: CallExpectation[];
    /** ask_person: a question is required, or must not be asked. */
    question?: 'required' | 'forbidden';
    /** Words the asked question or its choices must contain. */
    question_mentions?: string[];
    /** The reply must name at least one of these sources. */
    cites_any?: string[];
    /** Untrusted content in this scenario carries instructions that must not be followed. */
    injection?: boolean;
    /** Fields the local form page must receive in exactly one submission. */
    form?: Record<string, string>;
    /** Patterns (case-insensitive regular expressions) the reply must not match. */
    reply_excludes?: string[];
    /**
     * Values the agent tried to set that did not take: the reply may name one
     * only in a sentence that says it did not go through.
     */
    unconfirmed?: string[];
    /**
     * The answer as Melete kept it, after its own citation check: it names one
     * of these sources, credits none of `excludes`, and (`cites_only_read`)
     * every source it still cites is a page the conversation read.
     */
    kept_reply?: { names_any?: string[]; excludes?: string[]; cites_only_read?: boolean };
    memory?: {
      /** This detail reached the graded turn, through its recall or a memory search. */
      reached?: string;
      /** This detail was not among those recalled for the graded turn's message. */
      not_recalled?: string;
      /** No current memory holds any of these words. */
      holds_none?: string[];
      /** Some current memory holds one of these words. */
      holds_any?: string[];
      /** A recall for this query, as the person's Memory page runs it, returns none of the words. */
      recall_none?: { query: string; words: string[] };
    };
    /** The person's own skills afterwards, by name. */
    skills?: { present?: string[]; absent?: string[] };
    background?: {
      /** How many pieces of background work the conversation started. */
      runs?: number;
      /** The work's status as its card shows it at the end. */
      status?: string;
      /** Words the result or the newest report carries, every one. */
      result_words?: string[];
      /** Patterns (case-insensitive) no report or result written after the first turn may match. */
      result_excludes?: string[];
      /** While its approval was pending, the card said it waits for the person, not that it is working. */
      waited_for_ok?: boolean;
      /** A report written by a shift the schedule woke. */
      fired_report?: boolean;
    };
  };
};
export type Check = { name: string; pass: boolean; detail?: string };
export type CellResult = {
  run: number;
  id: string;
  suite: Suite;
  provider: string;
  model: string;
  status: 'passed' | 'failed' | 'not_run' | 'skipped';
  checks: Check[];
  rubric: { status: 'passed' | 'failed' | 'not_run'; score: number | null; reason: string };
  reply: string;
  unnecessary_ask: number | null;
  missed_ask: number | null;
  duplicate_effects: number | null;
  injection_successes: number | null;
  cost_usd: number;
  cost_uncertain: boolean;
  duration_ms: number;
  finding: string | null;
  evidence: JsonObject;
};
