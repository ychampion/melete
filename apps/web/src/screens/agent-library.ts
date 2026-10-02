/**
 * The agent library's plain helpers: words and icons for what an agent works
 * best with and for each shelf, the search over the shelves, the agents
 * recommended for what the person has connected, which of their connections
 * a template would suggest (suggest, never tick), and a template's example
 * day as the rows a chat draws.
 */
import { kindsOfApp } from '@melete/contracts/agent-library';
import type { IconName } from '../design/icons.tsx';
import type { ToolEntry } from '../experience/trace.ts';
import type { AgentTemplate } from '../experience/types.ts';

export type WorksWith = AgentTemplate['works_best_with'][number];

export const WORKS_WITH: Record<WorksWith, { label: string; icon: IconName }> = {
  mail: { label: 'Mail', icon: 'mail' },
  calendar: { label: 'Calendar', icon: 'calendar' },
  files: { label: 'Files', icon: 'files' },
  web: { label: 'Web pages', icon: 'globe' },
  browser: { label: 'A browser', icon: 'compass' },
  computer: { label: 'Its own computer', icon: 'terminal' },
  devices: { label: 'Your computer', icon: 'laptop' },
  mcp: { label: 'Apps you connect', icon: 'connectors' },
};

export type Shelf = AgentTemplate['category'];

/** A small icon for each shelf of the library. */
export const SHELF_ICON: Record<Shelf, IconName> = {
  Personal: 'user',
  'Home & family': 'home',
  Money: 'piggy',
  'Work & email': 'inbox',
  Research: 'search',
  Writing: 'pen',
  Travel: 'compass',
  'Health & routines': 'leaf',
  Learning: 'book',
  'Code & projects': 'terminal',
  'Small business': 'trendUp',
  'Shopping & subscriptions': 'bookmark',
};

/** Every shelf in the order the service lists templates, each once. */
export const shelvesOf = (templates: AgentTemplate[]) => [
  ...new Set(templates.map((template) => template.category)),
];

const fold = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * The templates on a shelf (or every shelf) whose words match every word of
 * the query: its name, title, benefit, what it does and what it works with.
 */
export function searchLibrary(
  templates: AgentTemplate[],
  query: string,
  shelf: string | null,
): AgentTemplate[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (shelf && template.category !== shelf) return false;
    if (!words.length) return true;
    const haystack = fold(
      [
        template.agent.name,
        template.title,
        template.category,
        template.benefit,
        ...template.does,
        ...template.works_best_with.map((kind) => WORKS_WITH[kind].label),
      ].join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}

export { kindsOfApp, suggestedConnections } from '@melete/contracts/agent-library';

/** Whether a connection is one of the kinds this template works best with. */
export const suggests = (kinds: readonly WorksWith[], app: string) =>
  kindsOfApp(app).some((kind) => kinds.includes(kind));

/**
 * What a library agent's job rests on that none of the connections it may
 * reach provides, so the draft can say what it cannot do without it. A null
 * list of allowed connections reaches every one.
 */
export function missingNeeds(
  needs: AgentTemplate['relies_on'],
  connections: readonly { id: string; app: string }[],
  allowed: string[] | null,
): AgentTemplate['relies_on'] {
  return needs.filter(
    (need) =>
      !connections.some(
        (connection) =>
          (allowed === null || allowed.includes(connection.id)) &&
          kindsOfApp(connection.app).includes(need.kind),
      ),
  );
}

/** The kinds a recommendation may rest on: the person's own mail, calendar and files. */
const PERSONAL: readonly WorksWith[] = ['mail', 'calendar', 'files'];

/**
 * Up to `limit` templates that fit what the person has connected, with the
 * connected kinds they rest on, so the shelf can say why. A template is
 * recommended only when the first thing it works best with is connected; the
 * ones whose needs are most fully met come first, mail jobs before calendar
 * and files ones, featured before the rest, and no two from the same shelf.
 */
export function recommend(
  templates: AgentTemplate[],
  connections: readonly { app: string; status: string }[],
  limit = 3,
): { templates: AgentTemplate[]; because: WorksWith[] } {
  const connected = new Set(
    connections
      .filter((connection) => connection.status === 'connected')
      .flatMap((connection) => kindsOfApp(connection.app)),
  );
  const fit = (template: AgentTemplate) => {
    const kinds = template.works_best_with;
    const weight = (index: number) => 1 / (index + 1);
    const whole = kinds.reduce((sum, _kind, index) => sum + weight(index), 0);
    const met = kinds.reduce(
      (sum, kind, index) => sum + (connected.has(kind) ? weight(index) : 0),
      0,
    );
    return whole ? met / whole : 0;
  };
  // Mail first, then calendar, then files: the job closest to the person's day.
  const primary = (template: AgentTemplate) =>
    PERSONAL.indexOf(template.works_best_with[0] ?? 'files');
  const candidates = templates
    .map((template, order) => ({ template, order, score: fit(template) }))
    .filter(({ template }) => {
      const first = template.works_best_with[0];
      return first !== undefined && PERSONAL.includes(first) && connected.has(first);
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        primary(a.template) - primary(b.template) ||
        Number(b.template.featured) - Number(a.template.featured) ||
        a.order - b.order,
    );
  const picked: AgentTemplate[] = [];
  const shelves = new Set<string>();
  for (const { template } of candidates) {
    if (picked.length >= limit) break;
    if (shelves.has(template.category)) continue;
    shelves.add(template.category);
    picked.push(template);
  }
  const because = PERSONAL.filter((kind) =>
    picked.some((template) => template.works_best_with.includes(kind) && connected.has(kind)),
  );
  return { templates: picked, because };
}

/** "Mail", "Mail and Calendar", "Mail, Calendar and Files". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const REACH_KIND: Record<AgentTemplate['day']['work'][number]['reach'], ToolEntry['kind']> = {
  mail: 'connector',
  calendar: 'connector',
  files: 'file',
  web: 'web',
  browser: 'browser',
  computer: 'sandbox',
  memory: 'memory_recall',
};

/** A template's example work as finished tool entries, the rows a chat draws for them. */
export function dayWork(template: Pick<AgentTemplate, 'id' | 'day'>): ToolEntry[] {
  const at = '2026-01-01T09:00:00.000Z';
  return template.day.work.map((step, index) => ({
    id: `${template.id}-example-${index}`,
    kind: REACH_KIND[step.reach],
    title: step.title,
    status: 'done',
    started_at: at,
    ended_at: at,
    input_summary: null,
    output_summary: null,
    detail: null,
    parent: null,
  }));
}
