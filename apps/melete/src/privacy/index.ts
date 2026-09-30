/**
 * The privacy router.
 *
 * The service builds one over its database and hands it to every model
 * gateway it opens (the engine's, memory's, the learning proposer's). A gateway
 * opened without one, such as the companies scan's, gets the default here:
 * default settings and a store that keeps nothing, so every request it makes is
 * still redacted. A gateway is never unprotected unless a test turns it off.
 */
import { PrivacyRouter } from './router.ts';
import { MemoryPrivacyStore } from './store.ts';

export * from './classify.ts';
export * from './detect.ts';
export * from './local.ts';
export * from './redact.ts';
export * from './router.ts';
export * from './store.ts';
export * from './stream.ts';
export * from './vault.ts';

let fallback: PrivacyRouter | null = null;

export function defaultPrivacyRouter(): PrivacyRouter {
  fallback ??= new PrivacyRouter({ store: new MemoryPrivacyStore({ keepLogs: false }) });
  return fallback;
}
