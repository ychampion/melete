/**
 * The agent library's plain helpers: words and icons for what an agent works
 * best with, the search over the shelves, and which of the person's
 * connections a template would suggest (suggest, never tick).
 */
import { kindsOfApp } from '@melete/contracts/agent-library';
import type { IconName } from '../design/icons.tsx';
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
