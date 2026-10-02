/**
 * How a tool entry is marked: its icon, drawn the same everywhere. The rows
 * themselves are drawn by the work log (WorkLog.tsx).
 */
import type { IconName } from '../design/icons.tsx';
import type { ToolEntry } from '../experience/trace.ts';

const KIND_ICON: Record<ToolEntry['kind'], IconName> = {
  connector: 'connectors',
  web: 'globe',
  file: 'fileText',
  artifact: 'upload',
  browser: 'compass',
  sandbox: 'monitor',
  skill: 'sparkles',
  memory_recall: 'book',
  memory_write: 'book',
  memory_correct: 'pencil',
  memory_forget: 'trash',
  model: 'sparkles',
  retry: 'clock',
  tool: 'sliders',
};

/** The icon for an entry: its family, and for a connected app, the kind of app. */
export function toolIcon(tool: ToolEntry): IconName {
  if (tool.kind === 'web' && /^Search/.test(tool.title)) return 'search';
  if (tool.kind === 'sandbox' && /`/.test(tool.title)) return 'terminal';
  if (tool.kind === 'connector') {
    const title = tool.title.toLowerCase();
    if (title.includes('calendar')) return 'calendar';
    if (title.includes('email') || title.includes('inbox') || title.includes('message'))
      return 'mail';
  }
  return KIND_ICON[tool.kind] ?? 'sliders';
}
