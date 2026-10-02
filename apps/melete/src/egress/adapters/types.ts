/**
 * What a command-line account needs from the code that knows its service.
 *
 * The egress relay terminates TLS only for the hosts an adapter names, and
 * only for a command whose space has that account connected. For each request
 * it asks the adapter what the request does: a read goes out with the account
 * injected, a write goes out only through the broker's ordinary admission
 * (scopes, intent key, approval bound to the exact request, receipt), and a
 * refusal never leaves. An adapter that cannot tell what a request does must
 * call it a write: unknown, unparseable and unlisted requests ask first.
 *
 * Adapters never hold a secret themselves. `authorize` is handed the account's
 * value for one request and returns the request to send; `redactions` names
 * every form of that value the relay must keep out of what the computer reads.
 */
import type { ExecEnvName, JsonObject } from '@melete/contracts';

/** The adapters this installation knows. `test` is offered only with the test connector. */
export const CREDENTIAL_ADAPTER_IDS = ['github', 'gitlab', 'npm', 'aws', 'test'] as const;
export type CredentialAdapterId = (typeof CREDENTIAL_ADAPTER_IDS)[number];

/**
 * One request as the computer sent it, inside a tunnel the relay terminated.
 * The client's own credentials and cookies are already gone, and the body is
 * whole: the relay buffers it before anything is decided.
 */
export type InterceptedRequest = {
  /** The tunnel's host: the CONNECT target, the TLS server name and the Host header, all equal. */
  host: string;
  method: string;
  /** The path without the query, as sent. */
  path: string;
  /** The query without its `?`, as sent; empty when there is none. */
  query: string;
  /** Lower-case names. Hop-by-hop, proxy, cookie and authorization headers are removed. */
  headers: Record<string, string>;
  body: Buffer;
};

/** What a person reads on the approval card for one write. */
export type CardSummary = {
  /** One sentence: what will happen, where. */
  title: string;
  facts: Array<{ label: string; value: string }>;
};

export type Classification =
  | { kind: 'read' }
  | {
      kind: 'write';
      /** A short name for what the write does, such as `push` or `request`. */
      operation: string;
      /**
       * The canonical request the person approves. Equal requests give equal
       * payloads, and anything that changes what lands upstream changes it.
       */
      payload: JsonObject;
      summary: CardSummary;
      /** Deletes or overwrites something: shown as such on the card. */
      destructive: boolean;
    }
  | { kind: 'refuse'; reason: string };

/** A request on its way upstream: what the adapter returns from `authorize`. */
export type OutboundRequest = {
  method: string;
  /** Path and query. */
  target: string;
  headers: Record<string, string>;
  body: Buffer;
};

export type UpstreamResponse = {
  status: number;
  headers: Record<string, string>;
  /** The whole body, already redacted. */
  body: Buffer;
};

/** The write a receipt is about, as it was classified. */
export type ClassifiedWrite = Extract<Classification, { kind: 'write' }>;

export interface CredentialAdapter<Config = unknown> {
  id: CredentialAdapterId;
  /**
   * The DNS subtrees this adapter can ever need, fixed in code: the egress CA
   * is name-constrained to the union of every offered adapter's, so its key
   * cannot vouch for any other name. `hosts` must stay inside them.
   */
  constraints: readonly string[];
  /** The connection's stored configuration for this adapter, or a refusal. */
  parseConfig(value: unknown): Config;
  /** Exact names, or `.suffix` for every name below one. */
  hosts(config: Config): string[];
  /** Values the computer's commands see in place of the account. Allow-listed names only. */
  placeholders(config: Config): Partial<Record<ExecEnvName, string>>;
  classify(request: InterceptedRequest, config: Config): Classification;
  /** The request with the account added: a header, or a signature. */
  authorize(request: OutboundRequest, secret: string, config: Config): OutboundRequest;
  /** Every form of the secret that must never reach the computer. */
  redactions(secret: string): string[];
  /** What the action's receipt keeps about a write, from the upstream answer. */
  receipt(write: ClassifiedWrite, upstream: UpstreamResponse): JsonObject;
}

/**
 * The broker tool that carries every write of one adapter. Its name is also
 * the scope a connection holds to let its account write (a tool name has two
 * parts, so the adapter and the class are joined by an underscore).
 */
export const egressWriteTool = (adapter: CredentialAdapterId) => `egress.${adapter}_write`;
/** The scope a connection must hold for its account to be used for reads at all. */
export const egressReadScope = (adapter: CredentialAdapterId) => `egress.${adapter}_read`;
/** Whether a broker tool is one of the relay's: proposed only by the relay itself. */
export const isEgressTool = (kind: string) => /^egress\.[a-z0-9]+_write$/.test(kind);

/**
 * Whether a DNS name falls under a name constraint, as X.509 reads one: the
 * name itself, or any name below it.
 */
export function withinConstraint(host: string, constraint: string): boolean {
  const name = host.toLowerCase();
  const base = constraint.toLowerCase().replace(/^\./, '');
  return name === base || name.endsWith(`.${base}`);
}

/** Whether `host` is one of `entries`: exact names, or `.suffix` for the names below one. */
export function hostCovered(host: string, entries: readonly string[]): boolean {
  const name = host.toLowerCase();
  return entries.some((entry) => {
    const item = entry.toLowerCase();
    return item.startsWith('.') ? name.length > item.length && name.endsWith(item) : name === item;
  });
}
