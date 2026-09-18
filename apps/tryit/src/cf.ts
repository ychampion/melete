/**
 * The little that this Worker needs from the Cloudflare runtime, written out
 * by hand. The repository typechecks with Bun's types, and pulling in a second
 * global type package to describe two bindings would change the whole tree's
 * ambient globals for the sake of this one directory. These are structural, so
 * the real runtime objects satisfy them.
 */

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export type DurableObjectId = object;

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
