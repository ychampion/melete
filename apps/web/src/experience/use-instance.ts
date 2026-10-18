/**
 * The installation's names for components. The names themselves live in
 * `instance.ts`, which imports nothing, so service code and tests outside the
 * web app can share the plain readers without loading React.
 */
import { useSyncExternalStore } from 'react';
import { currentInstance, type Instance, subscribeInstance } from './instance.ts';

/** The installation's names, drawn again when the setup status changes them. */
export function useInstance(): Instance {
  return useSyncExternalStore(subscribeInstance, currentInstance, currentInstance);
}
