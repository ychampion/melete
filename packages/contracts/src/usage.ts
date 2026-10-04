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

export const usageClass = z.enum(['interactive', 'background']).meta({
  description:
    '`interactive`: a person was waiting on the call (their message, their answer, a voice ' +
    'aside, a scan they asked for, and the searches and reviews of that turn). `background`: ' +
    'nobody was (watches, standing runs, routines, memory, learning).',
});

export const usageTier = z.enum(['interactive', 't1', 't2', 'service']).meta({
  description:
    'Which step made the call: `interactive` an agent turn a person waited on, `t2` an agent ' +
    'turn something else woke, `service` one of the service’s own side calls, `t1` a batched ' +
    'look at what came in.',
});

const usageBreakdown = {
  calls: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
};

export const usageDayPoint = z
  .object({
    day: z.string().meta({ description: 'UTC day, YYYY-MM-DD' }),
    usd: z.number().nonnegative(),
    background_usd: z.number().nonnegative(),
    calls: z.number().int().nonnegative(),
  })
  .strict();

export const backgroundCostSummary = z
  .object({
    person_days: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: 'Days a person made at least one model call, summed over people' }),
    median_usd: z.number().nonnegative(),
    p95_usd: z.number().nonnegative(),
    mean_usd: z.number().nonnegative(),
  })
  .strict();

export const usageResponse = z
  .object({
    month_start: timestamp,
    month_resets_at: timestamp,
    day_resets_at: timestamp,
    person: periodTotals.nullable().meta({ description: 'This account’s own model calls' }),
    background: periodTotals
      .nullable()
      .optional()
      .meta({ description: 'The part of this account’s calls that ran in the background' }),
    installation: periodTotals
      .nullable()
      .meta({ description: 'Every account’s calls; only for the installation’s owner' }),
    limits: z
      .object({
        person: periodLimits,
        background: periodLimits.optional().meta({
          description:
            'This account’s limits on background calls alone; its own messages never count here',
        }),
        installation: periodLimits
          .nullable()
          .meta({ description: 'Only for the installation’s owner' }),
      })
      .strict(),
    by_purpose: z
      .array(z.object({ purpose: z.string(), class: usageClass, ...usageBreakdown }).strict())
      .optional()
      .meta({ description: 'This month’s calls for this account, by purpose and class' }),
    by_tier: z
      .array(z.object({ tier: usageTier, ...usageBreakdown }).strict())
      .optional()
      .meta({ description: 'This month’s calls for this account, by tier' }),
    days: z
      .array(usageDayPoint)
      .optional()
      .meta({ description: 'This account’s last 30 UTC days, oldest first' }),
    background_per_person_day: backgroundCostSummary
      .nullable()
      .optional()
      .meta({
        description:
          'Background dollars per active person-day over the last seven finished days; only for ' +
          'the installation’s owner',
      }),
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
