/**
 * What the ⌘K palette shows for each result. A row carries one title and,
 * only when it adds something, a quiet second line. Built-in connections are
 * part of every workspace, so they are not results.
 */
import type { SearchResult } from '../experience/types.ts';

/** Words that only restate a result's kind, which the group heading already says. */
const RESTATES = new Set([
  'chat',
  'conversation',
  'plan',
  'task',
  'event',
  'connection',
  'connected app',
  'action',
]);

function eventTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** The second line under a result's title, or null when there is nothing to add. */
export function secondaryOf(hit: SearchResult): string | null {
  const meta = hit.meta.trim();
  if (!meta) return null;
  const lower = meta.toLowerCase();
  if (RESTATES.has(lower) || lower === hit.title.trim().toLowerCase()) return null;
  if (hit.kind === 'task') return lower === 'completed task' ? 'Done' : meta;
  if (hit.kind === 'event') return eventTime(meta) ?? meta;
  return meta;
}

/** Drop the connections every workspace starts with; they are not something to find. */
export function withoutBuiltins(hits: SearchResult[], builtinIds: ReadonlySet<string>) {
  return hits.filter((hit) => hit.kind !== 'connection' || !builtinIds.has(hit.id));
}
