/** Service-owned authorization, rechecked transactionally by the budget adapter. */
export interface GatewayPrincipal {
  jobId: string;
  attemptId: string;
  epoch: number;
  revision: number;
  maxRequests: number;
  maxTokens: number;
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
  /** Only the in-process fake provider may use a non-HTTPS URL. */
  fake?: boolean;
}
