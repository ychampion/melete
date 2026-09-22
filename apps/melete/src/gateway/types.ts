/** Service-owned authorization, rechecked transactionally by the budget adapter. */
export interface GatewayPrincipal {
  jobId: string;
  attemptId: string;
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
  protocols: GatewayProtocol[];
  /** The in-process fake provider never opens a connection, so its URL is not checked. */
  fake?: boolean;
  /**
   * Plain HTTP is accepted. Set only for the endpoint the operator names in
   * OPENAI_COMPAT_BASE_URL, which may be a model server on their own network.
   */
  allowHttp?: boolean;
}
