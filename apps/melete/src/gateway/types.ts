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
  /**
   * Every model this principal may be served with: the one it asks for, and
   * each model in `routes`. The proxy never chooses a model outside this list.
   */
  allowedModels: { provider: string; model: string }[];
  /** Models the gateway may serve a call with instead of the one it names. */
  routes?: GatewayRoutes;
  /**
   * The attempt answers a person's short message (`BRIEF_TURN_CHARS`), and
   * its calls think one step less than the agent's effort.
   */
  briefTurn?: boolean;
  /**
   * The person who caused this call, when the caller knows it: the one whose
   * message is being read, who asked aloud, or who started the scan. Spending
   * caps charge them. Left out, an agent call charges the person who spoke last
   * in its conversation.
   */
  actor?: string;
}

/**
 * The operator's alternatives for one principal's calls. Each speaks the same
 * protocol as the model the principal runs on, so a request goes as written.
 */
export interface GatewayRoutes {
  /** Serves a request that carries a picture, for a model that reads none. */
  vision?: { provider: string; model: string };
  /** Tried in order when the provider limits, fails or cannot be reached. */
  fallback?: { provider: string; model: string }[];
}

/** A call about to be made, as the spending caps see it. */
export interface GatewaySpendingCall {
  provider: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  /** On the person's own model. */
  local: boolean;
}

/**
 * Spending caps across every model call this service makes. `admit` is asked
 * before a call is reserved and refuses it once a limit is reached; `record`
 * is told what each settled call used.
 */
export interface GatewaySpending {
  /**
   * Throws a GatewayError (402 `spending_limit_reached`) when a limit is
   * reached. `call` is what is about to be sent, held against the limit while
   * it runs.
   */
  admit(principal: GatewayPrincipal, call?: GatewaySpendingCall): Promise<void>;
  /** Records one settled call's usage and cost. Never throws. */
  record(principal: GatewayPrincipal, settlement: GatewaySettlement): Promise<void>;
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
  /** Every input token the request carried, cached or not. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The part of the input the provider read from its prompt cache. */
  cachedInputTokens: number;
  /** The part of the input the provider wrote to its prompt cache, where it says so. */
  cacheWriteInputTokens?: number;
  /**
   * The input at full-price-equivalent tokens: cached input at the provider's
   * cached price, a cache write at its write price. What allowance and spending
   * accounting should charge for input; `inputTokens` stays the raw count.
   */
  chargedInputTokens?: number;
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
  /** `usage` is the gateway's estimate of a call cut off part way, not the provider's count. */
  usageEstimated?: boolean;
  /** Why the call went to this model instead of the one the request named. */
  route?: 'vision' | 'fallback';
  /** The model the request named, when `route` sent it elsewhere. */
  routedFrom?: { provider: string; model: string };
  /**
   * What a call that ended without its usage is estimated to have used, for
   * the spending caps alone; the job's ledger keeps its reservation instead.
   */
  spendEstimate?: GatewayUsage;
  /** A flat fee on top of the tokens, such as a provider's charge per web search. */
  feeUsd?: number;
  /** Served on the person's own model, which costs nothing unless the operator prices it. */
  servedLocally?: boolean;
  /** The model that actually answered, when the privacy router sent the call to the local model. */
  servedBy?: { provider: string; model: string };
  /**
   * What became of the request's answer schema: sent, left out (the model
   * cannot take one, or refused one before), or refused by the provider on
   * this call, which is then asked again without it.
   */
  structured?: 'sent' | 'stripped' | 'refused';
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
    /** A sentence for the person, sent as the error's message in place of the code. */
    readonly detail?: string,
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
