/**
 * Sorting what came in, and the "Needs you" list built from it.
 *
 * 1. **Collect.** New mail and calendar observations from accounts that serve
 *    their owner become items for that one person. The rules settle what they
 *    can (mail sent by a machine is nothing to do); the rest wait for a model.
 * 2. **Sort.** Waiting items are read in groups of up to twenty, one space and
 *    one person per call. An item whose subject was labelled before in the
 *    same words takes that label from the cache, with no call. Each call is a
 *    background call charged to the person, so their background limits apply:
 *    at a limit nothing is sent and the items stay unsorted until it resets.
 *    A private space's items go to the person's local model or nowhere.
 * 3. **List.** Items labelled `needs_you`, with what Melete noticed on its own,
 *    ranked most pressing first.
 *
 * Sorting only labels. This module reads observations and writes its own two
 * tables, and holds nothing that could start work, send, notify or act: it is
 * given a database handle and a classifier that returns text, and nothing else.
 * Its urgency stops at `soon`, in the code and in the database.
 */
import { MAIL_RECEIVED, type NeedsYouItem, type NeedsYouList } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { UsageClass } from '../gateway/usage-class.ts';
import { newId } from '../ids.ts';
import type { TriageClassifier, TriageFailure } from './classifier.ts';
import {
  BATCH_SIZE,
  becauseLabel,
  chatPrompt,
  contentHash,
  firstLook,
  type ItemFields,
  itemFields,
  type Label,
  parseLabels,
  plainSentence,
  subjectKeyOf,
  TRIAGE_KINDS,
  triageInput,
  VERDICT_TTL_MS,
} from './rules.ts';

/** Observations older than this when first seen are not sorted: they are not news. */
const COLLECT_WINDOW = '2 days';
/**
 * Items are listed, kept unsorted and retried for a week, then swept with the
 * labels that expired. An unsorted item waits an hour before it is tried
 * again, twice as long after each try that failed, and never more than a day.
 */
const LIST_WINDOW = '7 days';
/** Why an item was left unsorted, most pressing first. */
const UNSORTED_ORDER = ['kept_private', 'limit_reached', 'failed', 'off'] as const;

/** Something Melete noticed on its own, as the situation routes list it. */
export type NoticedSituation = {
  id: string;
  kind: string;
  subject_key: string;
  urgency: 'normal' | 'soon' | 'urgent';
  person_set: boolean;
  title: string;
  reason: string;
  because: string[];
  state: string;
  deadline_at: string | null;
  created_at: string;
  acked_at: string | null;
};

export type TriageDeps = {
  sql: Sql;
  /** Null when sorting is off: items are collected and left unsorted. */
  classifier: TriageClassifier | null;
  /** The spending caps: a person at their background limit is not sorted for. */
  spending?: { reached(personId: string | null, usageClass?: UsageClass): Promise<string | null> };
  /** What Melete noticed on its own, for the list. Left out, the list is sorted items alone. */
  situations?: (principalId: string) => Promise<NoticedSituation[]>;
  /** Whether this instance does the scheduled sorting. */
  leads?: () => Promise<boolean>;
  intervalSeconds?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export type SortResult = {
  collected: number;
  byRules: number;
  fromCache: number;
  byModel: number;
  calls: number;
  unsorted: number;
};

type ItemRow = {
  id: string;
  space_id: string;
  principal_id: string;
  event_seq: number;
  kind: string;
  subject_key: string;
  content_hash: string;
  fields: ItemFields;
  verdict: string | null;
  urgency: string;
  sentence: string | null;
  reason: string | null;
  state: string;
  tries: number;
  connection_id: string | null;
  created_at: Date | string;
  acked_at: Date | string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();

export class TriageService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | null = null;
  private stopped = true;

  constructor(private readonly deps: TriageDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** New observations become items; the rules settle what they can. */
  async collect(limit = 500): Promise<{ collected: number; byRules: number }> {
    const sql = this.deps.sql;
    const rows = await sql`select e.seq, e.payload, c.id as connection_id, c.space_id,
        coalesce(s.owner_principal_id, (select id from owner limit 1)) as principal_id
      from event e
      join connection c on c.id = e.payload->>'connection_id'
      join space s on s.id = c.space_id
      where e.type = 'notice' and e.job_id is null
        and e.payload->>'kind' = 'connector_event'
        and e.payload->>'event_name' in ${sql(TRIAGE_KINDS as string[])}
        and e.created_at > ${this.now().toISOString()}::timestamptz - ${COLLECT_WINDOW}::interval
        and c.status = 'active' and c.shared_use = 'owner'
        and not exists (select 1 from triage_item t where t.event_seq = e.seq)
      order by e.seq
      limit ${limit}`;
    let collected = 0;
    let byRules = 0;
    for (const row of rows) {
      if (!row.principal_id) continue;
      const envelope = row.payload as Record<string, unknown>;
      const observation = {
        seq: Number(row.seq),
        eventName: String(envelope.event_name),
        payload: (envelope.payload ?? {}) as Record<string, unknown>,
      };
      const look = firstLook(observation);
      if (!look) continue;
      const fields = itemFields(observation);
      const settled = look.decision === 'ignore';
      const inserted = await sql`insert into triage_item (id, space_id, principal_id, connection_id,
          event_seq, kind, subject_key, content_hash, fields, verdict, reason, decided_by, triaged_at)
        values (${newId('tri')}, ${row.space_id}, ${row.principal_id}, ${row.connection_id},
          ${observation.seq}, ${observation.eventName}, ${subjectKeyOf(observation)},
          ${contentHash(observation.eventName, fields)}, ${JSON.stringify(fields)}::text::jsonb,
          ${settled ? 'ignore' : null}, ${settled ? look.reason : null},
          ${settled ? 'rules' : null}, ${settled ? this.now().toISOString() : null})
        on conflict do nothing
        returning id`;
      if (!inserted.length) continue;
      collected++;
      if (settled) byRules++;
    }
    return { collected, byRules };
  }

  /** Waiting items, labelled from the cache where it can be and by the model otherwise. */
  async sort(): Promise<Omit<SortResult, 'collected' | 'byRules'>> {
    const sql = this.deps.sql;
    const now = this.now();
    const result = { fromCache: 0, byModel: 0, calls: 0, unsorted: 0 };
    const pending = (await sql`select * from triage_item
      where verdict is null
        and created_at > ${now.toISOString()}::timestamptz - ${LIST_WINDOW}::interval
        and (unsorted is null or triaged_at is null
          or triaged_at < ${now.toISOString()}::timestamptz
            - least(interval '1 day', interval '1 hour' * power(2, least(tries, 5))))
      order by principal_id, space_id, event_seq
      limit 2000`) as unknown as ItemRow[];
    const groups = new Map<string, ItemRow[]>();
    for (const item of pending) {
      const key = `${item.principal_id}\u0000${item.space_id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const items of groups.values()) {
      const first = items[0];
      if (!first) continue;
      // The same subject in the same words was labelled before: no call.
      const cached =
        await sql`select subject_key, content_hash, verdict, urgency, sentence, reason, model
        from triage_verdict
        where principal_id = ${first.principal_id} and space_id = ${first.space_id}
          and expires_at > ${now.toISOString()}::timestamptz
          and concat(subject_key, '|', content_hash) in ${sql(items.map((item) => `${item.subject_key}|${item.content_hash}`))}`;
      const hit = new Map(
        cached.map((row) => [`${row.subject_key}\u0000${row.content_hash}`, row] as const),
      );
      const left: ItemRow[] = [];
      for (const item of items) {
        const row = hit.get(`${item.subject_key}\u0000${item.content_hash}`);
        if (!row) {
          left.push(item);
          continue;
        }
        await this.label(item, row as unknown as Label, 'cache', String(row.model));
        result.fromCache++;
      }
      if (!left.length) continue;
      if (!this.deps.classifier) {
        result.unsorted += await this.leave(left, 'off');
        continue;
      }
      if (await this.deps.spending?.reached(first.principal_id, 'background')) {
        result.unsorted += await this.leave(left, 'limit_reached');
        continue;
      }
      const classifier = this.deps.classifier;
      let stopped = false;
      /**
       * One call for a group. A group the privacy router keeps private is split
       * and asked about in halves, so one sensitive item stays private and the
       * rest are still sorted.
       */
      const ask = async (batch: ItemRow[]): Promise<void> => {
        if (stopped) {
          result.unsorted += await this.leave(batch, 'limit_reached');
          return;
        }
        const ids = new Map(batch.map((item, index) => [`i${index + 1}`, item] as const));
        result.calls++;
        const answer = await classifier.label(
          { principalId: first.principal_id, spaceId: first.space_id, batchId: newId('tri') },
          triageInput(
            [...ids].map(([id, item]) => ({ id, kind: item.kind, fields: item.fields })),
            now,
          ),
        );
        if (!answer.ok) {
          if (answer.reason === 'kept_private' && batch.length > 1) {
            const half = Math.ceil(batch.length / 2);
            await ask(batch.slice(0, half));
            await ask(batch.slice(half));
            return;
          }
          // At a limit, the rest of this person's items wait too.
          if (answer.reason === 'limit_reached') stopped = true;
          result.unsorted += await this.leave(batch, answer.reason);
          return;
        }
        const labels = parseLabels(answer.text, new Set(ids.keys()));
        const missing: ItemRow[] = [];
        for (const [id, item] of ids) {
          const label = labels.get(id);
          if (!label) {
            missing.push(item);
            continue;
          }
          await this.label(item, label, 'model', answer.model);
          await this.remember(item, label, answer.model);
          result.byModel++;
        }
        result.unsorted += await this.leave(missing, 'failed');
      };
      for (let at = 0; at < left.length; at += BATCH_SIZE)
        await ask(left.slice(at, at + BATCH_SIZE));
    }
    return result;
  }

  /** One pass: sweep what is past its week, collect, then sort. */
  async run(): Promise<SortResult> {
    await this.sweep();
    const collected = await this.collect();
    const sorted = await this.sort();
    return { ...collected, ...sorted };
  }

  /** Items older than the list's week go, with their copied headers, and so do expired labels. */
  async sweep(): Promise<void> {
    const now = this.now().toISOString();
    await this.deps.sql`delete from triage_item
      where created_at < ${now}::timestamptz - ${LIST_WINDOW}::interval`;
    await this.deps.sql`delete from triage_verdict where expires_at < ${now}::timestamptz`;
  }

  private async label(item: ItemRow, label: Label, by: 'cache' | 'model', model: string) {
    const sentence = label.sentence || plainSentence(item.kind, item.fields);
    await this.deps.sql`update triage_item set verdict = ${label.verdict},
        urgency = ${label.urgency === 'soon' ? 'soon' : 'normal'},
        sentence = ${sentence}, reason = ${label.reason}, decided_by = ${by}, model = ${model},
        unsorted = null, triaged_at = ${this.now().toISOString()}
      where id = ${item.id} and verdict is null`;
  }

  private async remember(item: ItemRow, label: Label, model: string) {
    const now = this.now();
    await this.deps
      .sql`insert into triage_verdict (principal_id, space_id, connection_id, subject_key,
        content_hash, verdict, urgency, sentence, reason, model, expires_at)
      values (${item.principal_id}, ${item.space_id}, ${item.connection_id}, ${item.subject_key},
        ${item.content_hash},
        ${label.verdict}, ${label.urgency === 'soon' ? 'soon' : 'normal'},
        ${label.sentence || plainSentence(item.kind, item.fields)}, ${label.reason}, ${model},
        ${new Date(now.getTime() + VERDICT_TTL_MS).toISOString()})
      on conflict (principal_id, space_id, subject_key, content_hash) do update
        set verdict = excluded.verdict, urgency = excluded.urgency, sentence = excluded.sentence,
          reason = excluded.reason, model = excluded.model, expires_at = excluded.expires_at`;
  }

  /**
   * Items left unsorted, with why. Never an error and never a guess: they stay
   * unsorted, are counted, and are tried again later. A try that failed counts
   * toward the wait before the next one; waiting on a limit or with sorting
   * off does not.
   */
  private async leave(items: readonly ItemRow[], why: TriageFailure | 'off'): Promise<number> {
    if (!items.length) return 0;
    const ids = items.map((item) => item.id);
    const now = this.now().toISOString();
    const counts = why === 'failed' || why === 'kept_private';
    await this.deps.sql`update triage_item set unsorted = ${why}, triaged_at = ${now},
        tries = tries + ${counts ? 1 : 0}
      where id in ${this.deps.sql(ids)} and verdict is null`;
    return items.length;
  }

  // ------------------------------------------------------------------------
  // the list
  // ------------------------------------------------------------------------

  private view(row: ItemRow): NeedsYouItem {
    const fields = row.fields;
    const sentence = row.sentence ?? plainSentence(row.kind, fields);
    return {
      id: row.id,
      source: 'triage',
      sentence,
      reason: row.reason ?? '',
      because: {
        kind: row.kind === MAIL_RECEIVED ? 'mail' : 'calendar',
        label: becauseLabel(row.kind, fields),
        handle: `event:${row.event_seq}`,
        subject:
          ((row.kind === MAIL_RECEIVED ? fields.subject : fields.title) as string | null) ?? null,
        at:
          typeof (fields.received_at ?? fields.start) === 'string' &&
          !Number.isNaN(Date.parse(String(fields.received_at ?? fields.start)))
            ? new Date(String(fields.received_at ?? fields.start)).toISOString()
            : null,
      },
      urgency: row.urgency === 'soon' ? 'soon' : 'normal',
      seen: row.state === 'acked' || row.acked_at !== null,
      created_at: iso(row.created_at),
      chat_prompt: chatPrompt(`event:${row.event_seq}`),
    };
  }

  private situationView(situation: NoticedSituation): NeedsYouItem {
    return {
      id: situation.id,
      source: 'situation',
      sentence: situation.title,
      reason: situation.reason,
      because: {
        kind: 'situation',
        label: situation.reason,
        handle: situation.because[0] ?? `subject:${situation.subject_key}`,
        subject: null,
        at: situation.deadline_at,
      },
      urgency: situation.urgency,
      seen: situation.acked_at !== null,
      created_at: situation.created_at,
      chat_prompt: chatPrompt(`situation:${situation.id}`),
    };
  }

  /**
   * What needs the person, most pressing first: urgent, then soon, then the
   * rest; within each, a deadline they set first, then what they have not seen,
   * then the newest. A sorted item about something Melete already noticed is
   * left out, so one thing is listed once.
   */
  async needsYou(principalId: string): Promise<NeedsYouList> {
    const sql = this.deps.sql;
    const now = this.now().toISOString();
    const rows = (await sql`select distinct on (subject_key) * from triage_item
      where principal_id = ${principalId} and verdict = 'needs_you' and state <> 'dismissed'
        and created_at > ${now}::timestamptz - ${LIST_WINDOW}::interval
      order by subject_key, event_seq desc`) as unknown as ItemRow[];
    const situations = (await this.deps.situations?.(principalId)) ?? [];
    const live = situations.filter((s) => s.state === 'open' || s.state === 'routed');
    const noticed = new Set(live.map((s) => s.subject_key));
    const entries = [
      ...live.map((s) => ({ item: this.situationView(s), personSet: s.person_set })),
      ...rows
        .filter((row) => !noticed.has(row.subject_key))
        .map((row) => ({ item: this.view(row), personSet: false })),
    ];
    const lane = { urgent: 0, soon: 1, normal: 2 } as const;
    entries.sort(
      (a, b) =>
        lane[a.item.urgency] - lane[b.item.urgency] ||
        Number(b.personSet) - Number(a.personSet) ||
        Number(a.item.seen) - Number(b.item.seen) ||
        Date.parse(b.item.created_at) - Date.parse(a.item.created_at),
    );
    const waiting = await sql`select unsorted, count(*)::int as n from triage_item
      where principal_id = ${principalId} and verdict is null and unsorted is not null
        and created_at > ${now}::timestamptz - ${LIST_WINDOW}::interval
      group by unsorted`;
    const count = (why: string) => Number(waiting.find((row) => row.unsorted === why)?.n ?? 0);
    return {
      items: entries.map((entry) => entry.item),
      unsorted: waiting.reduce((sum, row) => sum + Number(row.n), 0),
      unsorted_reason: UNSORTED_ORDER.find((why) => count(why) > 0) ?? null,
    };
  }

  private async mark(principalId: string, id: string, state: 'acked' | 'dismissed') {
    const now = this.now().toISOString();
    const [row] = (await this.deps.sql`update triage_item set
        state = case when state = 'dismissed' then state else ${state} end,
        acked_at = coalesce(acked_at, ${now}::timestamptz),
        dismissed_at = case when ${state} = 'dismissed' then coalesce(dismissed_at, ${now}::timestamptz) else dismissed_at end
      where id = ${id} and principal_id = ${principalId}
      returning *`) as unknown as ItemRow[];
    if (!row) throw new ServiceError('not_found', 'No such item.', 404);
    return this.view(row);
  }

  ack(principalId: string, id: string) {
    return this.mark(principalId, id, 'acked');
  }

  dismiss(principalId: string, id: string) {
    return this.mark(principalId, id, 'dismissed');
  }

  // ------------------------------------------------------------------------
  // the schedule
  // ------------------------------------------------------------------------

  /** One scheduled pass, when this instance leads. */
  async tick(): Promise<SortResult | null> {
    if (this.deps.leads && !(await this.deps.leads())) return null;
    return this.run();
  }

  async start(): Promise<void> {
    this.stopped = false;
    const every = (this.deps.intervalSeconds ?? 120) * 1000;
    const loop = () => {
      if (this.stopped) return;
      this.running = this.tick()
        .catch((error) => this.deps.onError?.(error))
        .finally(() => {
          this.running = null;
          if (!this.stopped) this.timer = setTimeout(loop, every);
        });
    };
    this.timer = setTimeout(loop, every);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
