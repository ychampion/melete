/**
 * Sending each kind of work to a model (MELETE_MODEL_ROUTES).
 *
 * The operator may name a model for a kind of agent work: a person's chat,
 * research, a turn that drives the browser or the computer, a long
 * conversation, one about files, work in a shared space, and background work.
 * Unset, every turn runs on one model, as before.
 *
 * Which kinds an attempt is is read from what it is about (`workKinds`), and
 * the first kind in precedence order that has a route whose provider is
 * connected decides the model (`ModelSettingsService.routedChoice`). A model
 * the owner chose in the app always wins for agent turns.
 *
 * This module holds the kinds, their precedence, the preset and the
 * classifier. It reads nothing and calls nothing: the signals are gathered
 * by the caller (`jobs/work-signals.ts`).
 */
import type { ModelChoice } from './routing.ts';

/**
 * The kinds of work, in precedence order. When an attempt is more than one
 * kind, the first of them with a route decides its model.
 */
export const WORK_KINDS = [
  'background',
  'team',
  'computer',
  'browser',
  'long',
  'files',
  'research',
  'chat',
] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

/** Each routed kind's models: the first is used, the rest are its fallbacks, in order. */
export type WorkRoutes = Partial<Record<WorkKind, ModelChoice[]>>;

/** The value of MELETE_MODEL_ROUTES that expands to `RECOMMENDED_ROUTES`. */
export const RECOMMENDED = 'recommended';

/**
 * PLACEHOLDER: the `recommended` preset, to be replaced with the chosen table
 * before it is relied on. Until then every kind names the model the deploy
 * files ship as the default, so choosing the preset changes nothing.
 *
 * Each kind lists `provider/model` entries, the first used and the rest its
 * fallbacks. An entry whose provider has no key in the environment is
 * dropped at start-up with a warning, so the preset is safe on an install
 * with one key.
 */
export const RECOMMENDED_ROUTES: Readonly<Partial<Record<WorkKind, readonly string[]>>> = {
  chat: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  research: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  browser: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  computer: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  files: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  long: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  team: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
  background: ['fireworks/accounts/fireworks/models/deepseek-v4p1-flash'],
};

/**
 * What an attempt is about, as far as choosing its model needs it. Gathered
 * from the job, its events and its space when the attempt is claimed.
 */
export type WorkSignals = {
  usageClass: 'interactive' | 'background';
  /** The job's space has more than one person in it, or the job is a room's. */
  shared: boolean;
  /** Tools this job's recent attempts called, as the engine named them. */
  tools: readonly string[];
  /** The kinds of the files on the newest message from a person (`image`, `pdf`, ...). */
  attachments: readonly string[];
  /** Earlier messages of the conversation are already being summarised. */
  summarised: boolean;
  /** The conversation's estimated size, as a share of the model's context window. */
  contextShare: number;
  /** The newest message from a person, or empty when there is none. */
  message: string;
};

/** A conversation at least this share of the context window full is `long`. */
export const LONG_CONTEXT_SHARE = 0.5;

/**
 * Words in the newest message that suggest a kind of work. A starting
 * heuristic, kept in one table so it can be tuned and tested in one place.
 */
export const WORK_KEYWORDS: readonly {
  kind: 'research' | 'browser' | 'computer';
  words: RegExp;
}[] = [
  {
    kind: 'research',
    words: /\b(?:compare|comparing|comparison|sources?|research(?:ing)?|look(?:ing)? into)\b/i,
  },
  {
    kind: 'browser',
    words:
      /\b(?:go to|website|web site|web page|url|in (?:your|the) browser|open (?:the |this |that |a )?(?:site|page|link))\b|https?:\/\/|\bwww\./i,
  },
  {
    kind: 'computer',
    words: /\b(?:script|install|csv|spreadsheet|chart|code|terminal|python)\b/i,
  },
];

/** The engine may suffix a tool's name with a short hash; the name before it is the tool. */
const toolBase = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/__[0-9a-f]{12}$/, '');

/** Tools that drive the agent's browser. */
const isBrowserTool = (name: string) => toolBase(name).startsWith('browser.');

/** Tools that use the agent's computer: its screen, its terminal, or running code. */
const isComputerTool = (name: string) => /^(?:computer|terminal|code)\./.test(toolBase(name));

/** Tools that search and read the web, which is what research turns do. */
const isResearchTool = (name: string) => /^web\.(?:search|fetch|read)$/.test(toolBase(name));

/**
 * Every kind of work these signals show, in precedence order. `chat` always
 * applies, last, so a route for it covers every agent turn no other route
 * took. Pure: the same signals always give the same kinds.
 */
export function workKinds(signals: WorkSignals): WorkKind[] {
  const said = (kind: (typeof WORK_KEYWORDS)[number]['kind']) =>
    WORK_KEYWORDS.some((rule) => rule.kind === kind && rule.words.test(signals.message));
  const applies: Record<WorkKind, boolean> = {
    background: signals.usageClass === 'background',
    team: signals.shared,
    computer: signals.tools.some(isComputerTool) || said('computer'),
    browser: signals.tools.some(isBrowserTool) || said('browser'),
    long: signals.summarised || signals.contextShare >= LONG_CONTEXT_SHARE,
    files: signals.attachments.some((kind) => kind !== 'image'),
    research: signals.tools.some(isResearchTool) || said('research'),
    chat: true,
  };
  return WORK_KINDS.filter((kind) => applies[kind]);
}
