/**
 * Where a request went and what was swapped out of it, never the values. The
 * same shape as the contract's `privacyReceipt`, written out here because the
 * release scripts load this file with nothing but Bun's own modules.
 */
export type GatewayPrivacyReceipt = {
  route: 'cloud' | 'local' | 'ask' | 'on_device';
  protected: number;
  categories: Record<string, number>;
  placeholders: string[];
  local_detection?: 'off' | 'used' | 'failed';
};

/**
 * Whose data a request carries, so the privacy router applies the right
 * space's settings and the right conversation's privacy. Every principal names
 * one; there is no default.
 *
 * - `job`: an engine attempt. The space, conversation and agent are read from
 *   the job itself.
 * - `service`: one of the service's own calls (memory, a mailbox scan, a
 *   reviewer, a voice or phone integration). `spaceId` is the space it works
 *   for. `sourceJobId` names the conversation whose words it carries, so that
 *   conversation's private agent, sensitive topic and answers apply to it too;
 *   null when it carries none.
 */
export type GatewayPrivacyScope =
  | { kind: 'job' }
  | { kind: 'service'; purpose: string; spaceId: string; sourceJobId: string | null };

/** Service-owned authorization, rechecked transactionally by the budget adapter. */
export interface GatewayPrincipal {
  jobId: string;
  attemptId: string;
  /** Whose data this request carries, for the privacy router. Required: see `GatewayPrivacyScope`. */
  privacy: GatewayPrivacyScope;
  epoch: number;
  revision: number;
  maxRequests: number;
  maxTokens: number;
  /**
   * Output tokens the ledger had not yet charged when this principal was
   * issued. It only bounds the limit the gateway substitutes for a request that
   * names none; the reservation itself is still checked under the job lock.
   */
  remainingTokens?: number;
  /**
   * The most input one request may carry before its own output is set aside.
   * Each request is further held to its model's window less the output it asks for.
   */
  maxInputTokens?: number;
  /** Include the explicitly authorized fallback here; the proxy never chooses one. */
  allowedModels: { provider: string; model: string }[];
}

export interface GatewayReservationRequest {
  principal: GatewayPrincipal;
  requestId: string;
  provider: string;
  model: string;
  estimatedTokens: number;
  maxOutputTokens: number;
}

export interface GatewayReservation {
  id: string;
}

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
}

export interface GatewaySettlement {
  provider: string;
  modelRequested: string;
  modelActual: string | null;
  usage: GatewayUsage | null;
  latencyMs: number;
  status: 'succeeded' | 'failed' | 'unknown';
  httpStatus: number | null;
  /** Where the request went and what was swapped out of it, never the values. */
  privacy?: GatewayPrivacyReceipt;
  /** The call was cut off because its attempt was stopped or cancelled. */
  stopped?: boolean;
}

export interface GatewayBudget {
  /** Persist a request record and reserve tokens under the job lock before returning. */
  reserve(request: GatewayReservationRequest): Promise<GatewayReservation>;
  /** Persist provider evidence. Missing usage keeps the reservation charged, not released. */
  settle(reservation: GatewayReservation, settlement: GatewaySettlement): Promise<void>;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export type GatewayProtocol = 'chat/completions' | 'responses' | 'messages';

export interface GatewayProvider {
  name: string;
  /** HTTPS URL ending at the version prefix, for example https://api.openai.com/v1/. */
  baseUrl: string;
  apiKey?: string;
  /** Set for a provider the owner signs in to; it stands in for `apiKey`. */
  signedIn?: SignedInCredential;
  protocols: GatewayProtocol[];
  /** The in-process fake provider never opens a connection, so its URL is not checked. */
  fake?: boolean;
  /**
   * Plain HTTP is accepted. Set only for the endpoint the operator names in
   * OPENAI_COMPAT_BASE_URL, which may be a model server on their own network.
   */
  allowHttp?: boolean;
}

/**
 * A credential that comes from the owner signing in, opened per request in the
 * service. It is used instead of `apiKey`, and neither ever reaches the cell.
 */
export interface SignedInCredential {
  /** The access token to send now. Throws a GatewayError when there is none to send. */
  current(): Promise<{ token: string; generation: number; headers: Record<string, string> }>;
  /** The provider refused the token of this generation; the next use refreshes first. */
  rejected(generation: number): void;
}
