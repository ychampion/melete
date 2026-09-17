import { type CapabilityClaims, inputTokenAllowance } from '@melete/contracts';
import type { Sql } from 'postgres';
import {
  type GatewayBudget,
  GatewayError,
  type GatewayPrincipal,
  type GatewayReservation,
  type GatewayReservationRequest,
  type GatewaySettlement,
} from '../gateway/types.ts';
import { remainingOutputTokensLocked, reserveLocked } from './budget.ts';
import { verifyCapability } from './capability.ts';
import { BrokerFault } from './errors.ts';
import { appendEvent, checkAttempt, lockJob } from './records.ts';

type ModelChoice = { provider: string; model: string };

/** Gateway evidence uses the existing event/attempt/ledger contracts; no parallel store. */
export class PostgresGatewayBudget implements GatewayBudget {
  private readonly claims = new WeakMap<GatewayPrincipal, CapabilityClaims>();

  constructor(
    private readonly options: {
      sql: Sql;
      capabilityKey: string;
      /** W1 supplies only an explicitly authorized fallback for this job revision. */
      fallback?: (jobId: string, revision: number) => Promise<ModelChoice | null>;
    },
  ) {}

  async authenticate(token: string): Promise<GatewayPrincipal> {
    let claims: CapabilityClaims;
    try {
      claims = verifyCapability(token, this.options.capabilityKey);
    } catch {
      throw new GatewayError(401, 'capability_denied');
    }
    try {
      const principal = await this.options.sql.begin(async (tx) => {
        const job = await lockJob(tx, claims.job_id);
        await checkAttempt(tx, job, claims);
        const [attempt] =
          await tx`select provider, model from attempt where id = ${claims.attempt_id}`;
        if (!attempt) throw new BrokerFault('stale_epoch');
        const allowedModels: ModelChoice[] = [{ provider: attempt.provider, model: attempt.model }];
        const fallback = await this.options.fallback?.(job.id, job.revision);
        if (fallback) allowedModels.push(fallback);
        return {
          jobId: job.id,
          attemptId: claims.attempt_id,
          epoch: claims.epoch,
          revision: claims.revision,
          maxRequests: job.budget.max_turns,
          maxTokens: Math.min(job.budget.max_output_tokens, claims.budget.max_output_tokens),
          remainingTokens: await remainingOutputTokensLocked(tx, job, claims),
          maxInputTokens: Math.min(
            inputTokenAllowance(attempt.model, job.budget),
            inputTokenAllowance(attempt.model, claims.budget),
          ),
          allowedModels,
        };
      });
      this.claims.set(principal, claims);
      return principal;
    } catch (error) {
      throw this.failure(error);
    }
  }

  async reserve(request: GatewayReservationRequest): Promise<GatewayReservation> {
    const claims = this.claims.get(request.principal);
    if (!claims) throw new GatewayError(401, 'capability_denied');
    if (
      !request.principal.allowedModels.some(
        (choice) => choice.provider === request.provider && choice.model === request.model,
      )
    ) {
      throw new GatewayError(403, 'model_denied');
    }
    if (
      !Number.isSafeInteger(request.estimatedTokens) ||
      request.estimatedTokens < 1 ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > request.estimatedTokens
    )
      throw new GatewayError(429, 'budget_exceeded');
    try {
      return await this.options.sql.begin(async (tx) => {
        const job = await lockJob(tx, claims.job_id);
        await checkAttempt(tx, job, claims);
        const dedup = `gateway:request:${claims.attempt_id}:${request.requestId}`;
        const [previous] = await tx`select payload from event where dedup_key = ${dedup}`;
        // HTTP retries are new calls; only an internal retry of reservation may reuse this id.
        if (previous) throw new GatewayError(409, 'request_already_reserved');
        const [attempt] =
          await tx`select provider, model from attempt where id = ${claims.attempt_id}`;
        if (!attempt) throw new BrokerFault('stale_epoch');
        const fallback = request.provider !== attempt.provider || request.model !== attempt.model;
        if (fallback) {
          const allowed = await this.options.fallback?.(job.id, job.revision);
          if (
            !allowed ||
            allowed.provider !== request.provider ||
            allowed.model !== request.model
          ) {
            throw new GatewayError(403, 'model_denied');
          }
        }
        const inputTokens = request.estimatedTokens - request.maxOutputTokens;
        const inputLimit = Math.min(
          inputTokenAllowance(request.model, job.budget),
          inputTokenAllowance(request.model, claims.budget),
        );
        if (inputTokens > inputLimit) throw new GatewayError(413, 'input_context_exceeded');
        const reservations = await reserveLocked(tx, job, claims, null, [
          { kind: 'calls', amount: 1 },
          { kind: 'tokens', amount: request.maxOutputTokens },
        ]);
        const token = reservations.find((row) => row.kind === 'tokens');
        const calls = reservations.find((row) => row.kind === 'calls');
        if (!token || !calls) throw new Error('Incomplete gateway reservation');
        await appendEvent(
          tx,
          job.id,
          claims.attempt_id,
          'notice',
          {
            phase: 'model_request',
            reservation_id: token.id,
            calls_ledger_id: calls.id,
            request_id: request.requestId,
            provider: request.provider,
            model_requested: request.model,
            estimated_tokens: request.estimatedTokens,
            estimated_input_tokens: inputTokens,
            max_input_tokens: inputLimit,
            max_output_tokens: request.maxOutputTokens,
            fallback,
          },
          dedup,
        );
        return { id: token.id };
      });
    } catch (error) {
      throw this.failure(error);
    }
  }

  async settle(reservation: GatewayReservation, result: GatewaySettlement): Promise<void> {
    const sql = this.options.sql;
    const [entry] =
      await sql`select job_id, attempt_id from budget_ledger where id = ${reservation.id} and kind = 'tokens' and action_id is null`;
    if (!entry) throw new GatewayError(409, 'reservation_not_found');
    await sql.begin(async (tx) => {
      const job = await lockJob(tx, entry.job_id);
      const dedup = `gateway:receipt:${reservation.id}`;
      const [settled] = await tx`select seq from event where dedup_key = ${dedup}`;
      if (settled) return;
      const [request] =
        await tx`select payload from event where job_id = ${job.id} and attempt_id = ${entry.attempt_id}
        and payload->>'phase' = 'model_request' and payload->>'reservation_id' = ${reservation.id}`;
      if (
        !request ||
        request.payload.provider !== result.provider ||
        request.payload.model_requested !== result.modelRequested
      ) {
        throw new GatewayError(409, 'reservation_mismatch');
      }
      const [attempt] =
        await tx`select epoch, usage, outcome_detail from attempt where id = ${entry.attempt_id} for update`;
      if (!attempt) throw new GatewayError(409, 'attempt_not_found');
      const late = attempt.epoch !== job.lease_epoch;
      const usage = result.usage;
      if (
        usage &&
        (![usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
          usage.totalTokens < usage.inputTokens + usage.outputTokens)
      )
        throw new GatewayError(502, 'invalid_usage');
      if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0)
        throw new GatewayError(502, 'invalid_latency');
      if (usage)
        await tx`update budget_ledger set settled = ${usage.outputTokens} where id = ${reservation.id}`;
      await tx`update budget_ledger set settled = reserved where id = ${request.payload.calls_ledger_id}`;
      const previous = attempt.usage ?? {};
      const accumulated = {
        input_tokens: Number(previous.input_tokens ?? 0) + (usage?.inputTokens ?? 0),
        output_tokens: Number(previous.output_tokens ?? 0) + (usage?.outputTokens ?? 0),
        cached_input_tokens:
          Number(previous.cached_input_tokens ?? 0) + (usage?.cachedInputTokens ?? 0),
        requests: Number(previous.requests ?? 0) + 1,
        usd_est: Number(previous.usd_est ?? 0),
      };
      const detail = {
        ...(attempt.outcome_detail ?? {}),
        gateway_usage_uncertain:
          attempt.outcome_detail?.gateway_usage_uncertain === true || usage === null,
      };
      await tx`update attempt set model_actual = coalesce(${result.modelActual}, model_actual),
        usage = ${JSON.stringify(accumulated)}::jsonb,
        outcome_detail = ${JSON.stringify(detail)}::jsonb where id = ${entry.attempt_id}`;
      await appendEvent(
        tx,
        job.id,
        entry.attempt_id,
        'notice',
        {
          phase: 'model_receipt',
          reservation_id: reservation.id,
          provider: result.provider,
          model_requested: result.modelRequested,
          model_actual: result.modelActual,
          usage: usage
            ? {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                total_tokens: usage.totalTokens,
              }
            : null,
          latency_ms: result.latencyMs,
          status: result.status,
          http_status: result.httpStatus,
          usage_uncertain: usage === null,
          late,
        },
        dedup,
      );
    });
  }

  private failure(error: unknown): unknown {
    if (error instanceof BrokerFault)
      return new GatewayError(error.code === 'budget_exceeded' ? 429 : 403, error.code);
    return error;
  }
}
