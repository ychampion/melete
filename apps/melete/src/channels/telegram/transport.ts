/**
 * How updates reach the channel, and the timer that sends decisions out.
 *
 * Long polling needs no public address, which suits a self-hosted install
 * behind a home router. The offset Telegram hands back is saved after each
 * update, so a restart neither handles an update twice nor skips one; the
 * channel is safe to receive one twice anyway. Webhook mode registers
 * MELETE_PUBLIC_URL with a secret generated at start and receives on the API.
 */
import type { Sql } from 'postgres';
import { type TelegramApi, TelegramApiError } from './api.ts';
import type { TelegramChannel } from './channel.ts';
import { WEBHOOK_PATH } from './routes.ts';

const POLL_ROW = 'bot';

export type TelegramTransportOptions = {
  mode: 'polling' | 'webhook';
  /** MELETE_PUBLIC_URL, required for webhook mode. */
  publicUrl?: string;
  /** The secret Telegram sends back on each webhook call; the route checks the same one. */
  webhookSecret?: string;
  /** How long one getUpdates call waits for something to arrive. */
  pollSeconds?: number;
  /** How often decisions are looked for. */
  deliverEveryMs?: number;
  log?: (message: string) => void;
};

export class TelegramTransport {
  private readonly stopping = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly log: (message: string) => void;

  constructor(
    private readonly sql: Sql,
    private readonly api: TelegramApi,
    private readonly channel: TelegramChannel,
    private readonly options: TelegramTransportOptions,
  ) {
    this.log = options.log ?? ((message) => process.stderr.write(`telegram: ${message}\n`));
  }

  async start(): Promise<void> {
    try {
      const me = await this.api.getMe(this.stopping.signal);
      this.channel.botUsername = me.username ?? null;
    } catch (error) {
      this.log(`the bot could not be reached: ${describe(error)}`);
    }
    if (this.options.mode === 'webhook') {
      const base = (this.options.publicUrl ?? '').replace(/\/+$/, '');
      if (!this.options.webhookSecret) throw new Error('webhook mode needs a secret');
      await this.api.setWebhook(`${base}/api${WEBHOOK_PATH}`, this.options.webhookSecret);
    } else {
      // A webhook left registered would stop getUpdates from receiving anything.
      await this.api.deleteWebhook().catch((error) => this.log(describe(error)));
      this.loops.push(this.poll());
    }
    this.loops.push(this.deliverLoop());
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled(this.loops);
  }

  private async poll() {
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      try {
        const [row] = await this.sql`select next_offset from telegram_poll where id = ${POLL_ROW}`;
        const offset = Number(row?.next_offset ?? 0);
        const updates = await this.api.getUpdates(offset, this.options.pollSeconds ?? 25, signal);
        for (const update of updates) {
          if (signal.aborted) return;
          try {
            await this.channel.handleUpdate(update);
          } catch (error) {
            // One bad update must not stall every later one.
            this.log(`an update was not handled: ${describe(error)}`);
          }
          await this
            .sql`insert into telegram_poll (id, next_offset) values (${POLL_ROW}, ${update.update_id + 1})
            on conflict (id) do update set next_offset = greatest(telegram_poll.next_offset, excluded.next_offset),
              updated_at = now()`;
        }
      } catch (error) {
        if (signal.aborted) return;
        const wait =
          error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : 5_000;
        this.log(`polling paused: ${describe(error)}`);
        await sleep(wait, signal);
      }
    }
  }

  private async deliverLoop() {
    const signal = this.stopping.signal;
    while (!signal.aborted) {
      try {
        await this.channel.deliver();
      } catch (error) {
        this.log(`delivery paused: ${describe(error)}`);
      }
      await sleep(this.options.deliverEveryMs ?? 3_000, signal);
    }
  }
}

const describe = (error: unknown) =>
  error instanceof TelegramApiError ? error.message : (error as Error)?.name || 'error';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
