/**
 * Model usage and spending limits: what the person and the installation have
 * spent on model calls today and this month, the limits the operator set, and
 * the notice the person sees when one is close or reached. Dollars are
 * estimates from the operator's price table.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

export const usageTotals = z
  .object({
    usd: z.number().nonnegative().meta({ description: 'Estimated dollars spent' }),
    tokens: z.number().int().nonnegative().meta({ description: 'Input and output tokens' }),
  })
  .strict();

export const usageWindow = z
  .object({
    usd: z.number().positive().nullable().meta({ description: 'Dollar limit; null is none' }),
    tokens: z
      .number()
      .int()
      .positive()
      .nullable()
      .meta({ description: 'Token limit; null is none' }),
  })
  .strict();

const periodTotals = z.object({ month: usageTotals, day: usageTotals }).strict();
const periodLimits = z.object({ month: usageWindow, day: usageWindow }).strict();

export const usageNotice = z
  .object({
    level: z.enum(['warning', 'reached']).meta({
      description:
        '`warning`: a limit is past the notice level (80% by default). `reached`: new model ' +
        'calls are refused until it resets.',
    }),
    period: z.enum(['day', 'month']),
    scope: z.enum(['person', 'installation']),
    message: z.string().meta({ description: 'The sentence the person reads' }),
    resets_at: timestamp,
  })
  .strict();

export const usageResponse = z
  .object({
    month_start: timestamp,
    month_resets_at: timestamp,
    day_resets_at: timestamp,
    person: periodTotals.nullable().meta({ description: 'This account’s own model calls' }),
    installation: periodTotals
      .nullable()
      .meta({ description: 'Every account’s calls; only for the installation’s owner' }),
    limits: z
      .object({
        person: periodLimits,
        installation: periodLimits
          .nullable()
          .meta({ description: 'Only for the installation’s owner' }),
      })
      .strict(),
    notice: usageNotice.nullable(),
    models: z
      .array(
        z
          .object({
            provider: z.string(),
            model: z.string(),
            calls: z.number().int().nonnegative(),
            usd: z.number().nonnegative(),
            tokens: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .meta({ description: 'This month’s calls for this account, by the model that served them' }),
  })
  .strict();
export type UsageResponse = z.infer<typeof usageResponse>;

export const healthDetailResponse = z
  .object({
    status: z.enum(['ok', 'unhealthy']),
    version: z.string(),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }).strict()),
    time: timestamp,
  })
  .strict();
