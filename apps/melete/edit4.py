p = 'T:/apps/melete/src/triage/service.ts'
s = open(p, encoding='utf8').read()


def rep(a, b):
    global s
    assert a in s, a
    s = s.replace(a, b, 1)


rep("""/** How long an unsorted item waits before it is tried again. */
const RETRY_AFTER = '1 hour';
/** Needs-you items are listed for a week. */
const LIST_WINDOW = '7 days';
""", """/**
 * Items are listed, kept unsorted and retried for a week, then swept with the
 * labels that expired. An unsorted item waits an hour before it is tried
 * again, twice as long after each try that failed, and never more than a day.
 */
const LIST_WINDOW = '7 days';
/** Why an item was left unsorted, most pressing first. */
const UNSORTED_ORDER = ['kept_private', 'limit_reached', 'failed', 'off'] as const;
""")

rep("""  tries: number;
  created_at: Date | string;""", """  tries: number;
  connection_id: string | null;
  created_at: Date | string;""")

rep("""    const pending = (await sql`select * from triage_item
      where verdict is null
        and created_at > ${now.toISOString()}::timestamptz - ${COLLECT_WINDOW}::interval
        and (unsorted is null or triaged_at is null
          or triaged_at < ${now.toISOString()}::timestamptz - ${RETRY_AFTER}::interval)
      order by principal_id, space_id, event_seq
      limit 2000`) as unknown as ItemRow[];""", """    const pending = (await sql`select * from triage_item
      where verdict is null
        and created_at > ${now.toISOString()}::timestamptz - ${LIST_WINDOW}::interval
        and (unsorted is null or triaged_at is null
          or triaged_at < ${now.toISOString()}::timestamptz
            - least(interval '1 day', interval '1 hour' * power(2, least(tries, 5))))
      order by principal_id, space_id, event_seq
      limit 2000`) as unknown as ItemRow[];""")

start = s.index("      for (let at = 0; at < left.length; at += BATCH_SIZE) {")
end = s.index("    return result;\n  }\n\n  /** One pass: collect, then sort. */")
s = s[:start] + """      const classifier = this.deps.classifier;
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
      for (let at = 0; at < left.length; at += BATCH_SIZE) await ask(left.slice(at, at + BATCH_SIZE));
    }
""" + s[end:]

rep("""  /** One pass: collect, then sort. */
  async run(): Promise<SortResult> {
    const collected = await this.collect();
    const sorted = await this.sort();
    return { ...collected, ...sorted };
  }""", """  /** One pass: sweep what is past its week, collect, then sort. */
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
  }""")

rep("""      .sql`insert into triage_verdict (principal_id, space_id, subject_key, content_hash,
        verdict, urgency, sentence, reason, model, expires_at)
      values (${item.principal_id}, ${item.space_id}, ${item.subject_key}, ${item.content_hash},""", """      .sql`insert into triage_verdict (principal_id, space_id, connection_id, subject_key,
        content_hash, verdict, urgency, sentence, reason, model, expires_at)
      values (${item.principal_id}, ${item.space_id}, ${item.connection_id}, ${item.subject_key},
        ${item.content_hash},""")

start = s.index("  /**\n   * Items left unsorted, with why.")
end = s.index("  // ------------------------------------------------------------------------\n  // the list")
s = s[:start] + """  /**
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

""" + s[end:]

rep("      chat_prompt: chatPrompt(row.kind, fields, sentence),", "      chat_prompt: chatPrompt(`event:${row.event_seq}`),")
rep("      chat_prompt: `Help me with this: ${situation.title} ${situation.reason}`.slice(0, 1000),", "      chat_prompt: chatPrompt(`situation:${situation.id}`),")

rep("""    const [unsorted] = await sql`select count(*)::int as n from triage_item
      where principal_id = ${principalId} and verdict is null and unsorted is not null
        and created_at > ${now}::timestamptz - interval '1 day'`;
    return { items: entries.map((entry) => entry.item), unsorted: Number(unsorted?.n ?? 0) };""", """    const waiting = await sql`select unsorted, count(*)::int as n from triage_item
      where principal_id = ${principalId} and verdict is null and unsorted is not null
        and created_at > ${now}::timestamptz - ${LIST_WINDOW}::interval
      group by unsorted`;
    const count = (why: string) => Number(waiting.find((row) => row.unsorted === why)?.n ?? 0);
    return {
      items: entries.map((entry) => entry.item),
      unsorted: waiting.reduce((sum, row) => sum + Number(row.n), 0),
      unsorted_reason: UNSORTED_ORDER.find((why) => count(why) > 0) ?? null,
    };""")
open(p, 'w', encoding='utf8', newline='\n').write(s)

p = 'T:/apps/melete/src/triage/schema.ts'
s = open(p, encoding='utf8').read()
rep("""    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    subjectKey: text('subject_key').notNull(),""", """    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** The account the labelled item was read from; its labels go when it is revoked. */
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'cascade' }),
    subjectKey: text('subject_key').notNull(),""")
rep("""    index('triage_verdict_space_idx').on(table.spaceId),""", """    index('triage_verdict_space_idx').on(table.spaceId),
    index('triage_verdict_connection_idx').on(table.connectionId),""")
rep("""    /** Calls that tried to sort it and got no usable answer. */""", """    /** Tries that failed (no usable answer, or kept private); each doubles the wait before the next. */""")
open(p, 'w', encoding='utf8', newline='\n').write(s)

p = 'T:/apps/melete/src/jobs/policy.ts'
s = open(p, encoding='utf8').read()
rep("""        await tx.execute(sql`delete from triage_verdict where split_part(subject_key, ':', 2) = ${id}`);""", """        await tx.execute(sql`delete from triage_verdict where connection_id = ${id}`);""")
open(p, 'w', encoding='utf8', newline='\n').write(s)

p = 'T:/packages/contracts/src/triage.ts'
s = open(p, encoding='utf8').read()
rep("""  /** Items that came in today and could not be sorted: kept private, or over a limit. */
  unsorted: z.number().int().nonnegative(),
});""", """  /** Items from the last week not sorted yet: kept private, over a limit, or a failed call. */
  unsorted: z.number().int().nonnegative(),
  /**
   * The main reason, when some are waiting: `kept_private` (a private space with
   * no local model), `limit_reached` (a background spending limit), `failed` (the
   * model could not be reached or did not answer), `off` (sorting is turned off).
   */
  unsorted_reason: z.enum(['kept_private', 'limit_reached', 'failed', 'off']).nullable(),
});""")
rep("""  /**
   * What starting a chat about it would ask, when it proposes doing something.
   * The chat is an ordinary one: anything it would do still asks first.
   */""", """  /**
   * What starting a chat about it says in the person's name: a reference to the
   * source and nothing from it. The source itself comes with the chat as an
   * attached file (`POST /needs-you/{id}/source`), read as untrusted data. The
   * chat is an ordinary one: anything it would do still asks first.
   */""")
open(p, 'w', encoding='utf8', newline='\n').write(s)
