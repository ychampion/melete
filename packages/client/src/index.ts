/**
 * @melete/client is the typed way to talk to a Melete service. The types are
 * generated from packages/contracts/openapi.json, so anything this client can
 * express, the API accepts, and a change to the contract breaks the callers
 * that need to know about it.
 */

export {
  createMeleteClient,
  errorMessage,
  type FetchCredentials,
  type MeleteClient,
  type MeleteClientOptions,
  meleteUrl,
  type QueryValue,
  type ResolvedClientOptions,
} from './client.ts';
export {
  fetchEventPage,
  type GapReason,
  type MeleteEvent,
  type MeleteStreamItem,
  parseEventData,
  type SubscribeOptions,
  subscribeEvents,
} from './events.ts';
export { parseFrame, readSse, type SseFrame } from './sse.ts';
export type * from './types.ts';
