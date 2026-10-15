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
 * One more route, `side`, is not a kind of agent turn: it names the model for
 * the service's own short calls, the role MELETE_MODEL_FAST fills
 * (`routing.ts`).
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

/** The route for the service's own short calls: memory reads, voice asides, the reviewer. */
export const SIDE = 'side';

/** Every kind MELETE_MODEL_ROUTES may name: the kinds of agent work, then `side`. */
export const ROUTE_KINDS = [...WORK_KINDS, SIDE] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Each routed kind's models: the first is used, the rest are its fallbacks, in order. */
export type WorkRoutes = Partial<Record<RouteKind, ModelChoice[]>>;

/** The value of MELETE_MODEL_ROUTES that expands to `RECOMMENDED_ROUTES`. */
export const RECOMMENDED = 'recommended';

const DEEPSEEK = 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash';
const GLM = 'fireworks/accounts/fireworks/models/glm-5p3';
const KIMI = 'fireworks/accounts/fireworks/models/kimi-k3';
const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const OPUS = 'anthropic/claude-opus-5-5';

/**
 * The `recommended` preset. Each kind lists `provider/model` entries in order
 * of preference: the first whose provider has a key is used, and the later
 * ones on its protocol are its fallbacks. The rest are there for an install
 * without that key, so the preset works with Fireworks, with Anthropic, or
 * with both.
 *
 * Chosen from runs of real personal and team tasks on each model, weighing
 * cost per task finished without a false claim. The cheap models finished as
 * many tasks as the large ones in most kinds, so they lead. Each kind's
 * comment says where that is not so.
 */
export const RECOMMENDED_ROUTES: Readonly<Partial<Record<RouteKind, readonly string[]>>> = {
  // Everyday asks, judgment calls and memory. Opus was the only model that kept every
  // remembered detail across chats; name it here when that matters more than cost.
  chat: [DEEPSEEK, GLM, HAIKU, SONNET],
  // Live facts with sources: Haiku finished all of them, at a few cents.
  research: [HAIKU, SONNET, DEEPSEEK, KIMI],
  browser: [DEEPSEEK, GLM, HAIKU, SONNET],
  computer: [DEEPSEEK, KIMI, HAIKU, SONNET],
  files: [DEEPSEEK, KIMI, HAIKU, SONNET],
  // Long conversations that must keep their first rules.
  long: [DEEPSEEK, KIMI, HAIKU, SONNET],
  // Shared spaces, where a slip leaks one person's private details to another. On Anthropic,
  // Opus finished clearly more of these than Haiku or Sonnet, so it leads despite the cost.
  team: [DEEPSEEK, KIMI, OPUS, SONNET],
  // Routines and scheduled work; Haiku set them up least reliably.
  background: [DEEPSEEK, GLM, SONNET, OPUS],
  // The service's own short calls (reading chat into memory, voice asides, the reviewer). They
  // are small and many, so the cheap models lead.
  side: [DEEPSEEK, GLM, HAIKU, SONNET],
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
