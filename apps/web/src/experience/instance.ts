/**
 * The names this installation goes by, from the setup status: what the app
 * calls itself (`MELETE_INSTANCE_NAME`) and what the assistant calls itself
 * (`MELETE_ASSISTANT_NAME`). Both are "Melete" until the status says
 * otherwise, so an installation that sets neither reads exactly as before.
 *
 * Components read them with `useInstance()`. Strings made outside a component
 * (an adapter's error, a toast built in a helper) read `assistantName()` or
 * `instanceName()` at the moment they are made. The app waits for the setup
 * status before it draws a screen, so both are known by the first render.
 */
import { useSyncExternalStore } from 'react';

export type Instance = {
  /** What the app calls itself: page titles, sign-in, "this installation". */
  name: string;
  /** What the assistant calls itself: "Ask Juniper", "Juniper checks…". */
  assistant: string;
};

export const DEFAULT_NAME = 'Melete';

let current: Instance = { name: DEFAULT_NAME, assistant: DEFAULT_NAME };
const listeners = new Set<() => void>();

const named = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_NAME;

/** Takes the names the setup status gave; a missing or blank one is the default. */
export function setInstance(names: { instance_name?: unknown; assistant_name?: unknown }): void {
  const next = { name: named(names.instance_name), assistant: named(names.assistant_name) };
  if (next.name === current.name && next.assistant === current.assistant) return;
  current = next;
  for (const listener of listeners) listener();
}

export const currentInstance = (): Instance => current;
/** What the assistant calls itself, read when a string is made. */
export const assistantName = (): string => current.assistant;
/** What the app calls itself, read when a string is made. */
export const instanceName = (): string => current.name;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The installation's names, drawn again when the setup status changes them. */
export function useInstance(): Instance {
  return useSyncExternalStore(subscribe, currentInstance, currentInstance);
}
