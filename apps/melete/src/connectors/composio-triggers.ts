/**
 * Watching accounts signed in through Composio with its triggers.
 *
 * A trigger is a doorbell, not a feed: when Composio says a Gmail inbox or a
 * Google calendar changed, that account's next read is moved to now, and the
 * read itself is the same one a schedule makes. An event that is lost costs
 * only a delay, since the account is still read hourly.
 *
 * Every event Composio delivers is billed, so each is counted as it arrives.
 * Once trigger events reach their limit for the month, every trigger is
 * switched off at Composio and the accounts go back to being read on a
 * schedule; they are switched on again when a new month starts.
 *
 * Composio signs each delivery as Standard Webhooks do: an HMAC-SHA256 of
 * `id.timestamp.body` under the secret, sent as `v1,<base64>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { type ComposioMeter, standingLine } from '../signals/managed-calls.ts';
import { type ComposioClient, ComposioFault } from './composio.ts';

/** The trigger each watched kind is given, and its configuration. */
export const WATCH_TRIGGERS: Record<string, { slug: string; config: Record<string, unknown> }> = {
  gmail: { slug: 'GMAIL_NEW_GMAIL_MESSAGE', config: { labelIds: 'INBOX', interval: 1 } },
  google_calendar: {
    slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER',
    config: { calendarId: 'primary', interval: 1 },
  },
};

/** How far a delivery's timestamp may be from now, in seconds. */
const TOLERANCE_S = 300;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether a delivery carries a valid signature under `secret`, made within the tolerance. */
export function signedByComposio(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type Delivery = {
  type?: unknown;
  metadata?: { trigger_id?: unknown; connected_account_id?: unknown; trigger_slug?: unknown };
};

/** The usage row that remembers triggers were switched off, across restarts and instances. */
const OFF = 'triggers_off';

export class ComposioTriggers {
  /** The billing period whose triggers this process switched off, if any. */
  private offFor: string | null = null;

  constructor(
    private readonly deps: {
      sql: Sql;
      client: ComposioClient;
      meter?: ComposioMeter;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Give a watched connection its trigger at Composio, unless it has one or
   * trigger events are spent. The trigger's id is kept on the row without
   * changing its generation: it says how the account is watched, not which.
   */
  async watch(connectionId: string): Promise<string | null> {
    const [row] = await this.deps.sql`select configuration from connection
      where id = ${connectionId} and status = 'active'
        and configuration->>'via' = 'composio'`;
    const config = (row?.configuration ?? null) as Record<string, unknown> | null;
    const kind = typeof config?.kind === 'string' ? config.kind : '';
    const trigger = WATCH_TRIGGERS[kind];
    const accountId = config?.connected_account_id;
    if (!trigger || typeof accountId !== 'string' || !ID.test(accountId)) return null;
    if (typeof config?.trigger_id === 'string') return config.trigger_id;
    if (await this.deps.meter?.spent('trigger_events')) return null;
    const triggerId = await this.deps.client.upsertTrigger(trigger.slug, {
      connectedAccountId: accountId,
      config: trigger.config,
    });
    await this.deps.sql`update connection
      set configuration = jsonb_set(configuration, '{trigger_id}', to_jsonb(${triggerId}::text))
      where id = ${connectionId} and status = 'active'`;
    return triggerId;
  }

  /** Remove a trigger at Composio; a trigger already gone is not an error. */
  async unwatch(triggerId: string): Promise<void> {
    await this.deps.client.deleteTrigger(triggerId);
  }

  /**
   * One delivery, already verified. Counted first, since Composio billed it;
   * then the account it names is read now. Answers whether it was for a
   * connection here.
   */
  async receive(delivery: unknown): Promise<boolean> {
    const event = (delivery ?? {}) as Delivery;
    const triggerId = event.metadata?.trigger_id;
    const accountId = event.metadata?.connected_account_id;
    const counted = await this.deps.meter?.record('trigger_events');
    if (counted?.spent) await this.switchOff();
    if (typeof triggerId !== 'string' || typeof accountId !== 'string') return false;
    if (!ID.test(triggerId) || !ID.test(accountId)) return false;
    const rows = await this.deps.sql`update source_cursor set next_poll_at = now()
      where connection_id in (select id from connection
        where status = 'active' and configuration->>'via' = 'composio'
          and configuration->>'connected_account_id' = ${accountId}
          and configuration->>'trigger_id' = ${triggerId})
      returning connection_id`;
    return rows.length > 0;
  }

  /** Every trigger this installation keeps, with the connection it watches. */
  private async kept(): Promise<Array<{ connectionId: string; triggerId: string }>> {
    const rows = await this.deps.sql`select id, configuration->>'trigger_id' as trigger_id
      from connection where status = 'active' and configuration->>'via' = 'composio'
        and configuration->>'trigger_id' is not null`;
    return rows
      .map((row) => ({ connectionId: String(row.id), triggerId: String(row.trigger_id) }))
      .filter((row) => ID.test(row.triggerId));
  }

  /** Switch every trigger off at Composio, for the rest of the billing period. */
  async switchOff(): Promise<void> {
    const period =
      this.deps.meter?.period().start ?? new Date(this.now()).toISOString().slice(0, 10);
    if (this.offFor === period) return;
    this.offFor = period;
    await this.deps.sql`insert into composio_usage (period, dimension, used)
      values (${period}, ${OFF}, 1)
      on conflict (period, dimension) do update set used = 1, updated_at = now()`;
    for (const { triggerId } of await this.kept())
      await this.deps.client.setTrigger(triggerId, 'disable').catch((error) => {
        // Tried again on the next sweep while events are still spent.
        this.offFor = null;
        process.stderr.write(
          `composio: trigger_not_switched_off ${error instanceof ComposioFault ? error.kind : 'error'}\n`,
        );
      });
    process.stderr.write('composio: trigger events reached their limit; triggers switched off\n');
  }

  /**
   * The periodic sweep: triggers stay off while events are spent, come back on
   * in a new period, and watched connections without one are given one.
   */
  async sweep(): Promise<void> {
    if (await this.deps.meter?.spent('trigger_events')) {
      await this.switchOff();
      return;
    }
    const [off] = await this.deps.sql`select 1 from composio_usage
      where dimension = ${OFF} and used > 0 limit 1`;
    if (off) {
      let failed = false;
      for (const { triggerId } of await this.kept())
        await this.deps.client.setTrigger(triggerId, 'enable').catch(() => {
          failed = true;
          process.stderr.write('composio: trigger_not_switched_on\n');
        });
      // Tried again on the next sweep until every one is back on.
      if (!failed)
        await this.deps.sql`update composio_usage set used = 0, updated_at = now()
          where dimension = ${OFF}`;
      this.offFor = null;
    }
    const missing = await this.deps.sql`select id from connection
      where status = 'active' and configuration->>'via' = 'composio'
        and configuration->>'kind' in ${this.deps.sql(Object.keys(WATCH_TRIGGERS))}
        and configuration->>'trigger_id' is null
      limit 50`;
    for (const row of missing)
      await this.watch(String(row.id)).catch((error) => {
        process.stderr.write(
          `composio: trigger_not_made ${error instanceof ComposioFault ? error.kind : 'error'}\n`,
        );
      });
  }
}

/** How often usage is checked against Composio's own numbers, and triggers swept. */
export const UPKEEP_MS = 10 * 60_000;

/**
 * The periodic upkeep: Composio's own usage numbers read beside Melete's, the
 * triggers kept in step with their limit, and one log line with where every
 * limit stands. Returns a function that stops it.
 */
export function startComposioUpkeep(deps: {
  client: ComposioClient;
  meter: ComposioMeter;
  triggers?: ComposioTriggers;
  everyMs?: number;
}): () => void {
  const every = deps.everyMs ?? UPKEEP_MS;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deps.meter
        .reconcile((from, to) => deps.client.usage(from, to), every)
        .catch((error) => {
          process.stderr.write(
            `composio: usage_unread ${error instanceof ComposioFault ? error.kind : 'error'}\n`,
          );
        });
      await deps.triggers?.sweep().catch(() => {
        process.stderr.write('composio: trigger_sweep_failed\n');
      });
      const standing = await deps.meter.standing().catch(() => null);
      if (standing) process.stderr.write(standingLine(standing));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), every);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
