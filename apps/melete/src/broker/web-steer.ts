/**
 * Web pages go to the browser tools first.
 *
 * When an agent has both the DOM browser (`browser.*`: page text, elements by
 * role and name) and its own computer's desktop (`computer.*`: pixels, clicks
 * at points), a web task done on the desktop takes many more steps: each one
 * is a look, a guess at a point and a check. So where both are offered, the
 * computer's entry points say to use the browser for web pages, the browser's
 * say they come first, and the first catalog ranks the browser tools at least
 * as high as the computer's. Nothing is taken away: the desktop stays on offer
 * for what the browser tools cannot do.
 */
import type { CatalogEntry } from './catalog.ts';

/** Said by the computer's entry points for the web, when the browser tools are on offer. */
export const COMPUTER_WEB_NOTE =
  ' For a web page, use the browser tools first (browser.open, then browser.observe, browser.click, browser.fill, browser.select): they read the page as text and act on its elements by name, in far fewer steps. Use the computer for what they cannot do.';

/** Said by the browser's way in, when the computer is on offer too. */
export const BROWSER_FIRST_NOTE =
  ' Use this before computer.open for any web page: the browser tools read and act on the page by its elements, not its pixels.';

/** The computer tools a web task would start with. */
const COMPUTER_WEB_TOOLS = new Set(['computer.open', 'computer.click']);

const base = (name: string) => name.replace(/__[0-9a-f]{12}$/, '');
export const isBrowserTool = (name: string) => base(name).startsWith('browser.');
export const isComputerTool = (name: string) => base(name).startsWith('computer.');

type Steerable = { tool: { name: string; description: string }; entry: CatalogEntry };

/**
 * The items with the notes added where both kinds are on offer. Items are
 * copied before they change; the rest are returned as they are.
 */
export function steerWebTools<T extends Steerable>(items: T[]): T[] {
  const both =
    items.some((item) => isBrowserTool(item.tool.name)) &&
    items.some((item) => isComputerTool(item.tool.name));
  if (!both) return items;
  return items.map((item) => {
    const name = base(item.tool.name);
    const note = COMPUTER_WEB_TOOLS.has(name)
      ? COMPUTER_WEB_NOTE
      : name === 'browser.open'
        ? BROWSER_FIRST_NOTE
        : null;
    if (!note || item.tool.description.endsWith(note)) return item;
    return {
      ...item,
      tool: { ...item.tool, description: `${item.tool.description}${note}` },
      entry: { ...item.entry, description: `${item.entry.description}${note}` },
    };
  });
}

/**
 * Relevance for the first catalog: a browser tool ranks at least as high as
 * the best-ranked computer tool, so a web task's words that bring in the
 * desktop bring in the browser too, ahead of it.
 */
export function webScores(scored: { name: string; score: number }[]): Map<string, number> {
  const computer = Math.max(
    0,
    ...scored.filter((each) => isComputerTool(each.name)).map((each) => each.score),
  );
  const lifted = new Map<string, number>();
  if (!scored.some((each) => isComputerTool(each.name))) return lifted;
  for (const each of scored)
    if (isBrowserTool(each.name)) lifted.set(each.name, Math.max(each.score, computer));
  return lifted;
}
