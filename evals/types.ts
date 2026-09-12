import type { JsonObject } from '@melete/contracts';

export const SUITES = [
  'asks',
  'approval',
  'unknown',
  'memory',
  'waits',
  'injection',
  'briefing',
  'naturalness',
] as const;
export type Suite = (typeof SUITES)[number];
export type Domain = 'calendar' | 'mail' | 'files' | 'web' | 'watch' | 'server';
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
};
export type Check = { name: string; pass: boolean; detail?: string };
export type CellResult = {
  run: number;
  id: string;
  suite: Suite;
  provider: string;
  model: string;
  status: 'passed' | 'failed' | 'not_run';
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
