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
/** A step of the scripted plan. A string `{"$ref": "a.b"}` reads the latest tool result that has it. */
export type ScriptedStep = { tool: string; arguments: JsonObject };
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
  /** Earlier messages from the person, posted before the first turn. */
  history?: string[];
  /** A PDF, page by page, sent with the last message of `history`. */
  attach?: { name: string; pages: string[] };
  /** Approve the first parked proposal of this kind, checking these payload fields. */
  approve?: { kind: string; fields?: Record<string, string> };
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
