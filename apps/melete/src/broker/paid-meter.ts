/**
 * What outside search and reading APIs cost, charged to the job that used
 * them, the way the model's own search is (search-gateway.ts).
 *
 * Before a paid call is sent, the most it can cost is reserved on the job's
 * spending estimate (`usd_est`) under the action that made it, and the
 * installation's spending caps are asked. Once the provider answers, the
 * reservation is settled at the credits it reports, the attempt's usage
 * counts the cost, and the call is written to the spending record. A call
 * request and its receipt are notices in the job's ledger.
 *
 * Reading a page through the hosted reader is also held to a few pages each
 * conversation turn, so a page that keeps failing a direct read cannot turn
 * one answer into a long bill.
 */
import type { CapabilityClaims } from '@melete/contracts';
import type { Sql } from 'postgres';
import { type PaidApiMeter, PaidCallRefused, TAVILY_CREDIT_USD } from '../connectors/web-search.ts';
import { GatewayError, type GatewayPrincipal, type GatewaySpending } from '../gateway/types.ts';
import { reserveLocked } from './budget.ts';
import { BrokerFault } from './errors.ts';
import { appendEvent, lockJob } from './records.ts';

/** Pages the hosted reader reads in one conversation turn (or one attempt, outside a conversation). */
export const MAX_EXTRACTS_PER_TURN = 3;

export const EXTRACT_CAP_REACHED =
  `The hosted reader was not used: it reads at most ${MAX_EXTRACTS_PER_TURN} pages each turn, ` +
  'and this turn has used them. Answer from what you have, or try another source.';
export const PAID_BUDGET_REFUSED =
  'This would go over the spending limit of this work, so the paid search or reading service was not used.';

/** What one credit costs, by provider, for the spending estimate. */
const CREDIT_USD: Record<string, number> = { tavily: TAVILY_CREDIT_USD };

type Hold = {
  ledgerId: string;
  provider: string;
  kind: string;
  usdPerCredit: number;
  maxCredits: number;
  principal: GatewayPrincipal;
  call: { jobId: string; attemptId: string; actionId: string };
};

function paidPrincipal(call: {
  jobId: string;
  attemptId: string;
  spaceId: string;
}): GatewayPrincipal {
  return {
    jobId: call.jobId,
    attemptId: call.attemptId,
    privacy: {
      kind: 'service',
      purpose: 'web_search',
      spaceId: call.spaceId,
      sourceJobId: call.jobId,
    },
    epoch: 0,
    revision: 0,
    maxRequests: 1,
    maxTokens: 0,
    maxInputTokens: 0,
    allowedModels: [],
  };
}

export function jobPaidMeter(sql: Sql, spending?: GatewaySpending): PaidApiMeter {
  const holds = new Map<string, Hold>();
  return {
    async reserve(call, charge) {
      const usdPerCredit = CREDIT_USD[charge.provider];
      if (usdPerCredit === undefined) throw new Error(`no price for ${charge.provider}`);
      const principal = paidPrincipal(call);
      try {
        await spending?.admit(principal);
      } catch (error) {
        if (error instanceof GatewayError && error.status === 402)
          throw new PaidCallRefused(error.detail ?? PAID_BUDGET_REFUSED);
        throw error;
      }
      const amount = charge.maxCredits * usdPerCredit;
      const ledgerId = await sql.begin(async (tx) => {
        const job = await lockJob(tx, call.jobId);
        const [attempt] = await tx`select epoch, turn_id from attempt
          where id = ${call.attemptId} and job_id = ${call.jobId}`;
        // Only the job's current attempt spends.
        if (!attempt || Number(attempt.epoch) !== job.lease_epoch)
          throw new PaidCallRefused(PAID_BUDGET_REFUSED);
        if (charge.kind === 'extract') {
          // Counted under the job lock, so two reads at once cannot both take the last one.
          const [used] = await tx`select count(*)::int as n from event e
            join attempt a on a.id = e.attempt_id
            where e.job_id = ${call.jobId} and e.type = 'notice'
              and e.payload->>'phase' = 'paid_api_request'
              and e.payload->>'call' = 'extract'
              and coalesce(a.turn_id, a.id) = ${attempt.turn_id ?? call.attemptId}`;
          if (Number(used?.n ?? 0) >= MAX_EXTRACTS_PER_TURN)
            throw new PaidCallRefused(EXTRACT_CAP_REACHED);
        }
        const claims = {
          attempt_id: call.attemptId,
          budget: job.budget,
        } as unknown as CapabilityClaims;
        let reservation: { id: string } | undefined;
        try {
          [reservation] = await reserveLocked(tx, job, claims, call.actionId, [
            { kind: 'usd_est', amount },
          ]);
        } catch (error) {
          if (error instanceof BrokerFault && error.code === 'budget_exceeded')
            throw new PaidCallRefused(PAID_BUDGET_REFUSED);
          throw error;
        }
        if (!reservation) throw new Error('Incomplete paid call reservation');
        await appendEvent(tx, job.id, call.attemptId, 'notice', {
          phase: 'paid_api_request',
          provider: charge.provider,
          call: charge.kind,
          action_id: call.actionId,
          reservation_id: reservation.id,
          reserved_usd_est: amount,
        });
        return reservation.id;
      });
      holds.set(ledgerId, {
        ledgerId,
        provider: charge.provider,
        kind: charge.kind,
        usdPerCredit,
        maxCredits: charge.maxCredits,
        principal,
        call,
      });
      return { id: ledgerId };
    },
    async settle(hold, credits) {
      const held = holds.get(hold.id);
      holds.delete(hold.id);
      if (!held) throw new Error('paid call reservation not found');
      const used = Number.isFinite(credits)
        ? Math.min(Math.max(credits, 0), held.maxCredits)
        : held.maxCredits;
      const charge = used * held.usdPerCredit;
      await sql.begin(async (tx) => {
        const job = await lockJob(tx, held.call.jobId);
        await tx`update budget_ledger set settled = ${charge}
          where id = ${held.ledgerId} and settled is null`;
        const [attempt] = await tx`select usage from attempt
          where id = ${held.call.attemptId} for update`;
        if (attempt) {
          const previous = (attempt.usage ?? {}) as Record<string, unknown>;
          const credited = `${held.provider}_credits`;
          await tx`update attempt set usage = ${JSON.stringify({
            ...previous,
            [credited]: Number(previous[credited] ?? 0) + used,
            usd_est: Number(previous.usd_est ?? 0) + charge,
          })}::jsonb where id = ${held.call.attemptId}`;
        }
        await appendEvent(tx, job.id, held.call.attemptId, 'notice', {
          phase: 'paid_api_receipt',
          provider: held.provider,
          call: held.kind,
          action_id: held.call.actionId,
          reservation_id: held.ledgerId,
          credits: used,
          usd_est: charge,
        });
      });
      if (charge > 0)
        await spending?.record(held.principal, {
          provider: held.provider,
          modelRequested: held.kind,
          modelActual: null,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 },
          latencyMs: 0,
          status: 'succeeded',
          httpStatus: null,
          feeUsd: charge,
        });
    },
  };
}
