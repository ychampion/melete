/**
 * The reach-me ladder: when a deadline the person set is about to be missed
 * and its push goes unanswered, Melete texts their own verified number, then
 * calls it, and stops as soon as they acknowledge on any channel.
 *
 * - The ladder starts in the transaction that makes the situation urgent: the
 *   push is recorded as the first rung, and the text and the call wait as the
 *   next two, due three and eight minutes later.
 * - Each rung is decided again when it comes due, against fresh rows: the
 *   situation still open and unacknowledged, the verified number, the
 *   person's agreement for that number and channel, no STOP, the daily caps
 *   and the night rule. A rung that does not go says why.
 * - A rung is marked `sending` and committed before the provider is asked, so
 *   a crash or a lost answer never sends it twice: it stays `unknown`.
 * - The number a rung goes to is read from `reach_number` at that moment and
 *   is never taken from anything else. A number that is not verified, or one
 *   the agreement was not given for, is never texted or called.
 * - Each text and call is counted as a background cost in `model_usage`, so
 *   it shows in the person's spend beside their model calls.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { ReachState } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { type DayWindow, localTime } from '../push/policy.ts';
import {
  agreedWording,
  CODE_RULES,
  type Consent,
  callWords,
  codeAllowed,
  codeBody,
  consentWording,
  DAILY_CAPS,
  decideRung,
  LADDER,
  OPT_OUT_CONFIRMATION,
  providerAnswers,
  replyKind,
  TEXT_BODY,
} from './policy.ts';
import { type ReachConfig, ReachSendFailure, type Sent } from './provider.ts';
import { xml } from './twilio.ts';

const rows = <T>(value: unknown) => value as T[];
const iso = (at: Date | string | null | undefined) =>
  at == null ? null : new Date(at).toISOString();

export type ReachDeps = {
  db: Database;
  config: ReachConfig;
  /** Marks a situation seen, as tapping its push does. */
  ack?: (principalId: string, situationId: string) => Promise<unknown>;
  now?: () => number;
};

type NumberRow = {
  principal_id: string;
  number: string | null;
  verified_at: Date | null;
  pending_number: string | null;
  code_hash: string | null;
  code_expires_at: Date | null;
  code_tries: number;
  opted_out_at: Date | null;
};

type ConsentRow = Consent & { id: string; wording: string; agreed_at: Date };

type ContactRow = {
  id: string;
  principal_id: string;
  situation_id: string | null;
  purpose: string;
  channel: 'push' | 'text' | 'call';
  due_at: Date;
  state: string;
  reason: string;
  number: string | null;
  provider_ref: string | null;
  cost_usd: number;
  sent_at: Date | null;
};

const hashCode = (principalId: string, code: string) =>
  createHash('sha256').update(`${principalId}:${code}`).digest('hex');

/** Provider statuses that end a text or call without it reaching the person. */
const FAILED = new Set(['failed', 'undelivered', 'busy', 'no-answer', 'canceled']);
const REACHED = new Set(['delivered', 'completed', 'read']);

export class ReachService {
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private boss: PgBoss | undefined;

  constructor(readonly deps: ReachDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get db(): Database {
    return this.deps.db;
  }

  get available(): boolean {
    return this.deps.config.provider !== null;
  }

  // ------------------------------------------------------------------------
  // the person's number and agreement
  // ------------------------------------------------------------------------

  private async numberRow(tx: Transaction | Database, principalId: string, lock = false) {
    const [row] = rows<NumberRow>(
      await tx.execute(sql`select * from reach_number where principal_id = ${principalId}
        ${lock ? sql`for update` : sql``}`),
    );
    return row ?? null;
  }

  private async liveConsent(tx: Transaction | Database, principalId: string) {
    const [row] = rows<ConsentRow>(
      await tx.execute(sql`select id, number, texts, calls, nights, wording, agreed_at
        from reach_consent where principal_id = ${principalId} and withdrawn_at is null`),
    );
    return row ?? null;
  }

  /** The person's day from their profile; null when they have none, which counts as all night. */
  private async dayOf(tx: Transaction | Database, principalId: string): Promise<DayWindow | null> {
    const [row] = rows<{ start: string; end: string; time_zone: string }>(
      await tx.execute(sql`select p.day_start as start, p.day_end as end, p.time_zone
        from experience_profile p join space s on s.id = p.space_id
        where s.owner_principal_id = ${principalId} and s.kind = 'personal' limit 1`),
    );
    return row ? { start: row.start, end: row.end, timeZone: row.time_zone } : null;
  }

  /** Ladder texts and calls that reached the provider in the person's day so far. */
  private async sentToday(tx: Transaction | Database, principalId: string, day: DayWindow | null) {
    const now = new Date(this.now());
    const zone = day?.timeZone ?? 'UTC';
    const today = localTime(now, zone).day;
    const sent = rows<{ channel: 'text' | 'call'; sent_at: Date }>(
      await tx.execute(sql`select channel, sent_at from reach_contact
        where principal_id = ${principalId} and purpose = 'ladder'
          and channel in ('text', 'call') and sent_at is not null
          and state in ('sending', 'sent', 'delivered', 'unknown')
          and sent_at >= ${new Date(now.getTime() - 36 * 3600_000).toISOString()}::timestamptz`),
    );
    const counted = { text: 0, call: 0 };
    for (const row of sent)
      if (localTime(new Date(row.sent_at), zone).day === today) counted[row.channel] += 1;
    return counted;
  }

  async state(principalId: string): Promise<ReachState> {
    const [number, consent, day] = await Promise.all([
      this.numberRow(this.db, principalId),
      this.liveConsent(this.db, principalId),
      this.dayOf(this.db, principalId),
    ]);
    const today = await this.sentToday(this.db, principalId, day);
    const recent = rows<ContactRow>(
      await this.db.execute(sql`select * from reach_contact where principal_id = ${principalId}
        order by created_at desc limit 20`),
    );
    const pendingLive =
      number?.pending_number &&
      number.code_expires_at &&
      new Date(number.code_expires_at).getTime() > this.now();
    return {
      available: this.available,
      unavailable_reason: this.deps.config.unavailable,
      from_number: this.deps.config.provider?.from ?? null,
      number: number?.number ?? null,
      verified_at: iso(number?.verified_at),
      pending_number: pendingLive ? (number?.pending_number ?? null) : null,
      pending_expires_at: pendingLive ? iso(number?.code_expires_at) : null,
      consent: consent
        ? {
            number: consent.number,
            texts: consent.texts,
            calls: consent.calls,
            nights: consent.nights,
            wording: consent.wording,
            agreed_at: new Date(consent.agreed_at).toISOString(),
          }
        : null,
      opted_out_at: iso(number?.opted_out_at),
      wording: consentWording(number?.number ?? 'your number'),
      today: {
        texts: today.text,
        calls: today.call,
        text_cap: DAILY_CAPS.text,
        call_cap: DAILY_CAPS.call,
      },
      recent: recent.map((row) => ({
        id: row.id,
        channel: row.channel,
        purpose: row.purpose as 'ladder' | 'code' | 'notice',
        state: row.state,
        reason: row.reason,
        situation_id: row.situation_id,
        due_at: new Date(row.due_at).toISOString(),
        sent_at: iso(row.sent_at),
        cost_usd: Number(row.cost_usd),
      })),
    };
  }

  /**
   * Text a code to a number the person says is theirs. Five codes a day for a
   * person and for a number, so this cannot be used to text strangers.
   */
  async requestCode(principalId: string, number: string): Promise<ReachState> {
    const provider = this.deps.config.provider;
    if (!provider)
      throw new ServiceError(
        'reach_not_configured',
        this.deps.config.unavailable ?? 'Texts aren’t set up here.',
        503,
      );
    if (number === provider.from)
      throw new ServiceError('reach_number_refused', 'That is Melete’s own number.', 400);
    if (!codeAllowed(number, this.deps.config.codePrefixes))
      throw new ServiceError(
        'reach_country_refused',
        'Melete can’t text numbers in that country from this installation.',
        400,
      );
    const contactId = newId('rch');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = new Date(this.now());
    await this.db.transaction(async (tx) => {
      // One code request at a time across the installation, so every count
      // below holds, the per-number one included, whoever asks.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('reach:codes'))`);
      const [hour] = rows<{ n: number }>(
        await tx.execute(sql`select count(*)::int as n from reach_contact where purpose = 'code'
          and created_at >= ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`),
      );
      if ((hour?.n ?? 0) >= this.deps.config.codesPerHour)
        throw new ServiceError(
          'reach_code_limit',
          'Melete is sending too many codes right now. Try again in an hour.',
          429,
        );
      const [taken] = rows<{ principal_id: string }>(
        await tx.execute(sql`select principal_id from reach_number
          where number = ${number} and principal_id <> ${principalId}`),
      );
      if (taken)
        throw new ServiceError(
          'reach_number_taken',
          'Someone else here has already verified that number.',
          409,
        );
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const [counts] = rows<{ mine: number; theirs: number }>(
        await tx.execute(sql`select
          count(*) filter (where principal_id = ${principalId})::int as mine,
          count(*) filter (where number = ${number})::int as theirs
          from reach_contact where purpose = 'code' and created_at >= ${since}::timestamptz`),
      );
      if ((counts?.mine ?? 0) >= CODE_RULES.perDay || (counts?.theirs ?? 0) >= CODE_RULES.perDay)
        throw new ServiceError(
          'reach_code_limit',
          'That’s as many codes as Melete sends in a day. Try again tomorrow.',
          429,
        );
      await tx.execute(sql`insert into reach_number (principal_id, pending_number, code_hash,
          code_expires_at, code_tries, updated_at)
        values (${principalId}, ${number}, ${hashCode(principalId, code)},
          ${new Date(now.getTime() + CODE_RULES.ttlMs).toISOString()}::timestamptz, 0, now())
        on conflict (principal_id) do update set pending_number = excluded.pending_number,
          code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at,
          code_tries = 0, updated_at = now()`);
      await tx.execute(sql`insert into reach_contact (id, principal_id, purpose, channel, due_at,
          state, reason, number, sent_at, created_at)
        values (${contactId}, ${principalId}, 'code', 'text', ${now.toISOString()}::timestamptz,
          'sending', 'You asked for a code to verify this number.', ${number},
          ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`);
    });
    const outcome = await this.send(contactId, () =>
      provider.text(number, codeBody(code), this.callback('status', contactId)),
    );
    if (outcome === 'opted_out')
      throw new ServiceError(
        'reach_opted_out',
        `That number replied STOP to Melete. Text START to ${provider.from} from it, then ask for a code again.`,
        409,
      );
    if (outcome === 'refused')
      throw new ServiceError(
        'reach_code_refused',
        'The code couldn’t be sent to that number. Check it and try again.',
        400,
      );
    return this.state(principalId);
  }

  /** Prove the pending number with its code. A new number ends an agreement given for the old one. */
  async verify(principalId: string, code: string): Promise<ReachState> {
    const result = await this.db.transaction(async (tx) => {
      const row = await this.numberRow(tx, principalId, true);
      const now = this.now();
      if (!row?.pending_number || !row.code_hash || !row.code_expires_at)
        return 'Ask for a code first.';
      if (new Date(row.code_expires_at).getTime() <= now)
        return 'That code has run out. Ask for a new one.';
      if (row.code_tries >= CODE_RULES.tries) return 'Too many tries. Ask for a new code.';
      const given = Buffer.from(hashCode(principalId, code));
      const kept = Buffer.from(row.code_hash);
      if (given.length !== kept.length || !timingSafeEqual(given, kept)) {
        await tx.execute(sql`update reach_number set code_tries = code_tries + 1, updated_at = now()
          where principal_id = ${principalId}`);
        return 'That code isn’t right.';
      }
      const changed = row.number !== row.pending_number;
      if (changed) await this.endConsent(tx, principalId, 'number');
      await tx.execute(sql`update reach_number set number = pending_number,
          verified_at = ${new Date(now).toISOString()}::timestamptz,
          pending_number = null, code_hash = null, code_expires_at = null, code_tries = 0,
          opted_out_at = ${changed ? null : row.opted_out_at},
          updated_at = now()
        where principal_id = ${principalId}`);
      return null;
    });
    if (result) throw new ServiceError('reach_code_wrong', result, 400);
    return this.state(principalId);
  }

  /** The one-time agreement, recorded with the time, the number and the exact words. */
  async agree(
    principalId: string,
    choice: { calls: boolean; nights: boolean },
  ): Promise<ReachState> {
    if (!this.available)
      throw new ServiceError(
        'reach_not_configured',
        this.deps.config.unavailable ?? 'Texts aren’t set up here.',
        503,
      );
    await this.db.transaction(async (tx) => {
      const row = await this.numberRow(tx, principalId, true);
      if (!row?.number)
        throw new ServiceError('reach_not_verified', 'Verify your number first.', 409);
      if (row.opted_out_at)
        throw new ServiceError(
          'reach_opted_out',
          `You replied STOP. Text START to ${this.deps.config.provider?.from ?? 'Melete’s number'} first, then turn this on again.`,
          409,
        );
      await this.endConsent(tx, principalId, 'settings');
      await tx.execute(sql`insert into reach_consent (id, principal_id, number, texts, calls,
          nights, wording, agreed_at)
        values (${newId('rcn')}, ${principalId}, ${row.number}, true, ${choice.calls},
          ${choice.nights}, ${agreedWording(row.number, choice)},
          ${new Date(this.now()).toISOString()}::timestamptz)`);
    });
    return this.state(principalId);
  }

  async withdraw(principalId: string): Promise<ReachState> {
    await this.db.transaction((tx) => this.endConsent(tx, principalId, 'settings'));
    return this.state(principalId);
  }

  /** Forget the number altogether. */
  async forget(principalId: string): Promise<ReachState> {
    await this.db.transaction(async (tx) => {
      await this.endConsent(tx, principalId, 'forgotten');
      await tx.execute(sql`delete from reach_number where principal_id = ${principalId}`);
    });
    return this.state(principalId);
  }

  private async endConsent(tx: Transaction, principalId: string, how: string) {
    await tx.execute(sql`update reach_consent set withdrawn_at = now(), withdrawn_how = ${how}
      where principal_id = ${principalId} and withdrawn_at is null`);
    await tx.execute(sql`update reach_contact set state = 'cancelled',
        reason = 'You ended texts and calls before this was due.', updated_at = now()
      where principal_id = ${principalId} and state = 'waiting' and channel in ('text', 'call')`);
  }

  // ------------------------------------------------------------------------
  // the ladder
  // ------------------------------------------------------------------------

  /**
   * Called in the transaction that makes a situation urgent. Only a deadline
   * the person set climbs; the push is the first rung, the text and the call
   * wait their turn. A situation that climbs again later starts nothing new.
   */
  async escalate(
    tx: Transaction,
    situation: {
      id: string;
      principalId: string;
      kind: string;
      urgency: string;
      personSet: boolean;
    },
    pushed: boolean,
  ): Promise<void> {
    if (situation.urgency !== 'urgent' || !situation.personSet) return;
    if (situation.kind !== 'deadline.at_risk') return;
    const now = this.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const rung = (channel: string, due: string, state: string, reason: string) =>
      sql`(${newId('rch')}, ${situation.principalId}, ${situation.id}, 'ladder', ${channel},
        ${due}::timestamptz, ${state}, ${reason}, ${state === 'sent' ? due : null}::timestamptz)`;
    await tx.execute(sql`insert into reach_contact (id, principal_id, situation_id, purpose,
        channel, due_at, state, reason, sent_at)
      values ${rung(
        'push',
        at(0),
        pushed ? 'sent' : 'skipped',
        pushed
          ? 'Because a deadline you set is about to be missed.'
          : 'No device has pushes turned on.',
      )},
        ${rung('text', at(LADDER.textAfterMs), 'waiting', 'Because the push went unanswered.')},
        ${rung('call', at(LADDER.callAfterMs), 'waiting', 'Because the push and the text went unanswered.')}
      on conflict (situation_id, channel) where situation_id is not null do nothing`);
    this.timeNext(now + LADDER.textAfterMs);
  }

  /** Every rung that is due: decided again, then sent or set aside with its reason. */
  async sweep(): Promise<{ sent: number; skipped: number }> {
    let sent = 0;
    let skipped = 0;
    for (;;) {
      const claimed = await this.claimOne();
      if (!claimed) break;
      if (claimed.decision === 'skipped') skipped += 1;
      else if (claimed.decision === 'send') {
        await this.sendRung(claimed.contact, claimed.to);
        sent += 1;
      }
    }
    await this.timeUpcoming();
    return { sent, skipped };
  }

  private async claimOne(): Promise<
    { decision: 'skipped' } | { decision: 'send'; contact: ContactRow; to: string } | null
  > {
    return this.db.transaction(async (tx) => {
      const [contact] = rows<ContactRow>(
        await tx.execute(sql`select * from reach_contact
          where state = 'waiting' and due_at <= ${new Date(this.now()).toISOString()}::timestamptz
          order by due_at limit 1 for update skip locked`),
      );
      if (!contact) return null;
      // One claim at a time for each person, across the timer, the queue's
      // worker and every instance: the daily count below then includes every
      // send already decided, so the caps hold.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`reach:${contact.principal_id}`}))`,
      );
      const [found] = rows<{
        state: string;
        urgency: string;
        person_set: boolean;
        acked_at: Date | null;
        principal_id: string;
      }>(
        await tx.execute(sql`select state, urgency, person_set, acked_at, principal_id
          from situation where id = ${contact.situation_id} for share`),
      );
      // A call follows only a text that went out (or may have).
      const [text] = rows<{ state: string }>(
        await tx.execute(sql`select state from reach_contact
          where situation_id = ${contact.situation_id} and channel = 'text'`),
      );
      const number = await this.numberRow(tx, contact.principal_id);
      const consent = await this.liveConsent(tx, contact.principal_id);
      const day = await this.dayOf(tx, contact.principal_id);
      const decision = decideRung({
        channel: contact.channel === 'call' ? 'call' : 'text',
        situation:
          found && found.principal_id === contact.principal_id
            ? {
                live: found.state === 'open' || found.state === 'routed',
                urgent: found.urgency === 'urgent',
                personSet: found.person_set,
                acked: found.acked_at !== null,
              }
            : null,
        number: number?.number ?? null,
        consent,
        optedOut: Boolean(number?.opted_out_at),
        providerReady: this.available && this.deps.config.callbackBase !== null,
        sentToday: await this.sentToday(tx, contact.principal_id, day),
        day,
        textWent: ['sent', 'delivered', 'unknown'].includes(text?.state ?? ''),
        now: new Date(this.now()),
      });
      if (!decision.send) {
        await tx.execute(sql`update reach_contact set state = ${decision.cancel ? 'cancelled' : 'skipped'},
            reason = ${decision.reason}, updated_at = now() where id = ${contact.id}`);
        return { decision: 'skipped' as const };
      }
      // Committed before the provider is asked: a lost answer is never sent again.
      await tx.execute(sql`update reach_contact set state = 'sending', number = ${decision.to},
          sent_at = ${new Date(this.now()).toISOString()}::timestamptz, updated_at = now()
        where id = ${contact.id}`);
      return { decision: 'send' as const, contact, to: decision.to };
    });
  }

  private async sendRung(contact: ContactRow, to: string): Promise<void> {
    const provider = this.deps.config.provider;
    if (!provider) return;
    const status = this.callback('status', contact.id);
    await this.send(contact.id, () =>
      contact.channel === 'call'
        ? provider.call(to, this.callScript(contact.id), status)
        : provider.text(to, TEXT_BODY, status),
    );
  }

  /**
   * What the call says: who is calling, that a deadline the person set is at
   * risk, the keys, and the number to text Melete back on. The deadline's own
   * words stay in Melete.
   */
  callScript(contactId: string): string {
    const words = callWords(this.deps.config.provider?.from ?? '');
    const keys = this.callback('key', contactId);
    return `<Response><Gather numDigits="1" timeout="8" method="POST" action="${xml(keys ?? '')}"><Say>${xml(
      `${words.lead} ${words.keys}`,
    )}</Say></Gather><Say>${xml(words.after)}</Say></Response>`;
  }

  private callback(kind: 'status' | 'key', contactId: string): string | null {
    const base = this.deps.config.callbackBase;
    return base ? `${base}/reach/twilio/${kind}/${contactId}` : null;
  }

  /**
   * Ask the provider and record what it said: sent, refused (nothing went),
   * opted out (the person replied STOP), or unknown (never sent again). Each
   * one sent is counted as a background cost of the person's.
   */
  private async send(
    contactId: string,
    work: () => Promise<Sent>,
  ): Promise<'sent' | 'refused' | 'opted_out' | 'unknown'> {
    let outcome: 'sent' | 'refused' | 'opted_out' | 'unknown';
    let made: Sent | null = null;
    try {
      made = await work();
      outcome = 'sent';
    } catch (error) {
      outcome = error instanceof ReachSendFailure ? error.kind : 'unknown';
    }
    await this.db.transaction(async (tx) => {
      const [contact] = rows<ContactRow>(
        await tx.execute(sql`select * from reach_contact where id = ${contactId} for update`),
      );
      if (!contact) return;
      if (outcome === 'sent' && made) {
        const cost =
          contact.channel === 'call'
            ? this.deps.config.prices.callUsdPerMinute
            : this.deps.config.prices.textUsd;
        await tx.execute(sql`update reach_contact set state = 'sent', provider_ref = ${made.ref},
            provider_status = ${made.status}, cost_usd = ${cost}, updated_at = now()
          where id = ${contactId}`);
        await this.meter(tx, contact, cost);
        return;
      }
      if (outcome === 'unknown') {
        await tx.execute(sql`update reach_contact set state = 'unknown',
            reason = 'The provider didn’t confirm it, so it isn’t sent again.', updated_at = now()
          where id = ${contactId}`);
        // It may have gone: it is counted as if it did.
        await this.meter(
          tx,
          contact,
          contact.channel === 'call'
            ? this.deps.config.prices.callUsdPerMinute
            : this.deps.config.prices.textUsd,
        );
        return;
      }
      await tx.execute(sql`update reach_contact set state = 'failed', sent_at = null,
          reason = ${
            outcome === 'opted_out'
              ? 'You replied STOP to this number, so Melete stopped texting and calling it.'
              : 'The provider turned it down, so nothing was sent.'
          }, updated_at = now()
        where id = ${contactId}`);
      if (outcome === 'opted_out' && contact.purpose === 'ladder')
        await this.optOut(tx, contact.principal_id, 'stop');
    });
    return outcome;
  }

  /** A text or call as a background cost of the person's, beside their model calls. */
  private async meter(tx: Transaction, contact: ContactRow, cost: number) {
    const model = contact.purpose === 'ladder' ? contact.channel : contact.purpose;
    await tx.execute(sql`insert into model_usage (id, created_at, space_id, principal_id, purpose,
        provider, model, status, cost_usd, usage_estimated, class, tier, situation_id)
      values (${contact.id}, now(),
        (select id from space where owner_principal_id = ${contact.principal_id}
          and kind = 'personal' limit 1),
        ${contact.principal_id}, 'reach', ${this.deps.config.provider?.name ?? 'telephony'},
        ${model}, 'ok', ${cost}, true, 'background', 'service', ${contact.situation_id})
      on conflict (id) do update set cost_usd = excluded.cost_usd`);
  }

  private async optOut(tx: Transaction, principalId: string, how: 'stop' | 'keypress') {
    if (how === 'stop')
      await tx.execute(sql`update reach_number set opted_out_at = coalesce(opted_out_at, now()),
          updated_at = now() where principal_id = ${principalId}`);
    await this.endConsent(tx, principalId, how);
  }

  // ------------------------------------------------------------------------
  // what comes back: replies, keypresses, receipts
  // ------------------------------------------------------------------------

  /**
   * A text to Melete's number. Believed only with the provider's signature for
   * this exact address, from this account, to this number, and only once for
   * each message the provider names: a replayed request does nothing. Only a
   * verified number is anyone's; a text from any other is ignored.
   *
   * Any sign of wanting it to stop ends texts and calls at once, and is never
   * read as having seen something. A reply the provider doesn't answer itself
   * gets one line saying so and how to restart (`reply`).
   */
  async inbound(
    url: string,
    params: URLSearchParams,
    signature: string | undefined,
  ): Promise<{
    outcome: 'forbidden' | 'ignored' | 'stop' | 'start' | 'help' | 'acknowledged';
    reply?: string;
  }> {
    const provider = this.deps.config.provider;
    if (
      !provider?.authentic(url, params, signature) ||
      !provider.ownAccount(params) ||
      params.get('To') !== provider.from
    )
      return { outcome: 'forbidden' };
    const sid = params.get('MessageSid') ?? params.get('SmsSid') ?? '';
    if (!sid) return { outcome: 'ignored' };
    const fresh = rows<{ message_sid: string }>(
      await this.db.execute(sql`insert into reach_reply (message_sid) values (${sid})
        on conflict (message_sid) do nothing returning message_sid`),
    );
    if (!fresh.length) return { outcome: 'ignored' };
    const from = params.get('From') ?? '';
    const [owner] = rows<{ principal_id: string; opted_out_at: Date | null }>(
      await this.db.execute(sql`select principal_id, opted_out_at from reach_number
        where number = ${from}`),
    );
    if (!owner) return { outcome: 'ignored' };
    const body = params.get('Body') ?? '';
    // With Advanced Opt-Out on, the provider names the kind itself.
    const named = (params.get('OptOutType') ?? '').toLowerCase();
    let kind = named === 'stop' || named === 'start' || named === 'help' ? named : replyKind(body);
    // "Yes" from someone who never stopped is an answer.
    if (kind === 'start' && !owner.opted_out_at) kind = 'answer';
    if (kind === 'stop') {
      await this.db.transaction((tx) => this.optOut(tx, owner.principal_id, 'stop'));
      if (named || providerAnswers(body)) return { outcome: 'stop' };
      await this.confirmOptOut(owner.principal_id, from);
      return { outcome: 'stop', reply: OPT_OUT_CONFIRMATION };
    }
    if (kind === 'start') {
      await this.db.execute(sql`update reach_number set opted_out_at = null, updated_at = now()
        where principal_id = ${owner.principal_id}`);
      return { outcome: 'start' };
    }
    if (kind === 'help') return { outcome: 'help' };
    await this.acknowledgeClimbing(owner.principal_id);
    return { outcome: 'acknowledged' };
  }

  /** The one confirmation an opt-out gets, recorded and counted like any other text. */
  private async confirmOptOut(principalId: string, number: string) {
    const id = newId('rch');
    const cost = this.deps.config.prices.textUsd;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`insert into reach_contact (id, principal_id, purpose, channel, due_at,
          state, reason, number, sent_at, cost_usd)
        values (${id}, ${principalId}, 'notice', 'text', now(), 'sent',
          'You asked Melete to stop, so it said it had.', ${number}, now(), ${cost})`);
      const [contact] = rows<ContactRow>(
        await tx.execute(sql`select * from reach_contact where id = ${id}`),
      );
      if (contact) await this.meter(tx, contact, cost);
    });
  }

  /**
   * The person answered. With a situation named (a key pressed on its call),
   * that one is seen. A text reply covers only the deadlines Melete actually
   * texted or called about before it arrived; one that so far had only a push
   * keeps climbing.
   */
  private async acknowledgeClimbing(principalId: string, situationId?: string) {
    const climbing = rows<{ situation_id: string }>(
      await this.db.execute(sql`select distinct c.situation_id from reach_contact c
        join situation s on s.id = c.situation_id
        where c.principal_id = ${principalId} and c.purpose = 'ladder'
          and s.state in ('open', 'routed') and s.acked_at is null
          ${
            situationId
              ? sql`and c.situation_id = ${situationId}`
              : sql`and c.channel in ('text', 'call')
                  and c.state in ('sending', 'sent', 'delivered', 'unknown')
                  and c.sent_at <= ${new Date(this.now()).toISOString()}::timestamptz`
          }`),
    );
    for (const { situation_id } of climbing) {
      if (this.deps.ack) await this.deps.ack(principalId, situation_id);
      else
        await this.db.execute(sql`update situation set acked_at = now(), updated_at = now()
          where id = ${situation_id} and acked_at is null`);
      await this.db.execute(sql`update reach_contact set state = 'cancelled',
          reason = 'You saw it, so Melete stopped.', updated_at = now()
        where situation_id = ${situation_id} and state = 'waiting'`);
    }
  }

  /** A delivery receipt for one text or call. */
  async receipt(
    contactId: string,
    url: string,
    params: URLSearchParams,
    signature: string | undefined,
  ): Promise<boolean> {
    const provider = this.deps.config.provider;
    if (!provider?.authentic(url, params, signature) || !provider.ownAccount(params)) return false;
    const ref = params.get('MessageSid') ?? params.get('CallSid');
    const status = (params.get('MessageStatus') ?? params.get('CallStatus') ?? '').toLowerCase();
    await this.db.transaction(async (tx) => {
      const [contact] = rows<ContactRow>(
        await tx.execute(sql`select * from reach_contact where id = ${contactId}
          and provider_ref = ${ref} for update`),
      );
      if (!contact || !status) return;
      const reached = REACHED.has(status);
      const failed = FAILED.has(status);
      let cost = Number(contact.cost_usd);
      if (contact.channel === 'call' && (reached || failed)) {
        // A call is charged by the started minute, and one never answered costs nothing.
        const seconds = Number(params.get('CallDuration') ?? '0');
        cost = reached
          ? Math.max(1, Math.ceil(seconds / 60)) * this.deps.config.prices.callUsdPerMinute
          : 0;
        await this.meter(tx, contact, cost);
      }
      await tx.execute(sql`update reach_contact set provider_status = ${status},
          state = ${reached ? 'delivered' : failed ? 'failed' : contact.state},
          cost_usd = ${cost}, updated_at = now()
        where id = ${contactId} and state in ('sending', 'sent', 'unknown', 'delivered', 'failed')`);
      if (params.get('ErrorCode') === '21610') await this.optOut(tx, contact.principal_id, 'stop');
    });
    return true;
  }

  /** A key pressed on a call: 1 says it was seen, 9 ends texts and calls. Returns what the call says next. */
  async keypress(
    contactId: string,
    url: string,
    params: URLSearchParams,
    signature: string | undefined,
  ): Promise<string | null> {
    const provider = this.deps.config.provider;
    if (!provider?.authentic(url, params, signature) || !provider.ownAccount(params)) return null;
    const [contact] = rows<ContactRow>(
      await this.db.execute(sql`select * from reach_contact where id = ${contactId}
        and channel = 'call' and provider_ref = ${params.get('CallSid')}`),
    );
    if (!contact) return null;
    const digit = params.get('Digits') ?? '';
    if (digit === '9') {
      await this.db.transaction((tx) => this.optOut(tx, contact.principal_id, 'keypress'));
      if (contact.situation_id)
        await this.acknowledgeClimbing(contact.principal_id, contact.situation_id);
      return 'Melete won’t text or call you again until you turn it on in Settings. Goodbye.';
    }
    if (digit === '1') {
      if (contact.situation_id)
        await this.acknowledgeClimbing(contact.principal_id, contact.situation_id);
      return 'Thanks. Melete has marked it as seen. Goodbye.';
    }
    return 'Melete won’t call again about this. Goodbye.';
  }

  // ------------------------------------------------------------------------
  // running
  // ------------------------------------------------------------------------

  private timeNext(at: number) {
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.sweep().catch(() => process.stderr.write('reach: sweep_failed\n')),
      Math.max(0, at - this.now()),
    );
  }

  private async timeUpcoming() {
    if (!this.started) return;
    const [next] = rows<{ due_at: Date }>(
      await this.db.execute(sql`select due_at from reach_contact where state = 'waiting'
        order by due_at limit 1`),
    );
    if (next && new Date(next.due_at).getTime() - this.now() <= 10 * 60_000)
      this.timeNext(new Date(next.due_at).getTime());
  }

  /** Swept every minute on the service's own scheduling, and in between when a rung is close. */
  async start(boss: PgBoss, queue: string): Promise<void> {
    if (this.started) return;
    this.boss = boss;
    await boss.work(queue, { batchSize: 1, pollingIntervalSeconds: 1 }, async () => {
      try {
        await this.sweep();
      } catch {
        process.stderr.write('reach: sweep_failed\n');
      }
    });
    await boss.schedule(queue, '* * * * *', {});
    this.started = true;
    await this.timeUpcoming();
  }

  async stop(queue: string): Promise<void> {
    clearTimeout(this.timer);
    if (this.started && this.boss) await this.boss.offWork(queue, { wait: false });
    this.started = false;
  }
}
