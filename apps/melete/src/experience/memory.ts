import { createHash } from 'node:crypto';
import {
  memoryItem,
  memoryItemCreate,
  memoryItemEdit,
  memoryKeyValue,
  memorySettings,
  unavailable,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import {
  type ClaimHead,
  correctClaim,
  getHead,
  listClaims,
  publishRevision,
} from '../memory/claims.ts';
import { resolveContradictions } from '../memory/contradictions.ts';
import { enqueue, lockSpace, type MemoryScope } from '../memory/db.ts';
import { persistEvidence } from '../memory/evidence.ts';
import { forgetMemory } from '../memory/forget.ts';
import { invalidateDependencies, lockEventOrder, notifyInvalidated } from '../memory/invalidate.ts';
import { writeRepairBriefs } from '../memory/outputs.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { ownJobClause } from '../principals/authority.ts';
import { explainHandles, memoryKeyLabel } from './evidence.ts';
import { plainText } from './projectors.ts';
import { experienceMissing } from './service.ts';

/** A detail Settings shows: a current value, including one whose question is still open. */
const listed = (head: ClaimHead) =>
  (head.current.status === 'active' || head.current.status === 'disputed') &&
  head.current.content !== null;
const version = (id: string, revision: number) =>
  createHash('sha256').update(`${id}:${revision}`).digest('hex');
export class ExperienceMemory {
  constructor(
    readonly sql: Sql,
    readonly journal?: RestrictionJournal,
    readonly provision?: (spaceId: string, principalId: string) => Promise<void>,
  ) {}
  /**
   * The person's memory in their space. A space whose memory has never been
   * used (a fresh account answering its first setup question) is provisioned
   * here, on first use, rather than waiting for a job to run in it.
   */
  async scope(spaceId: string, ownerId: string): Promise<MemoryScope | null> {
    const find = () => this.sql`select space_id from memory_spaces where space_id = ${spaceId}
      and owner_id = ${ownerId} and restore_ready and not revoked`;
    let [row] = await find();
    if (!row && this.provision) {
      await this.provision(spaceId, ownerId).catch((error: unknown) => {
        process.stderr.write(
          `memory: provision_failed ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
      });
      [row] = await find();
    }
    return row
      ? { spaceId, ownerId, publisher: 'experience', audience: 'private', role: 'owner' }
      : null;
  }
  /**
   * One page of what the person can see and change. A disputed detail is listed
   * too: it is still what Melete uses while the question about it is open.
   */
  async list(spaceId: string, ownerId: string, after: string | null = null) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    const { claims, next } = await listClaims(this.sql, scope, { after });
    const items = [];
    for (const head of claims.filter(listed)) items.push(await this.item(spaceId, head));
    return { items, next };
  }
  private async item(spaceId: string, head: ClaimHead) {
    const [source] = await this
      .sql`select bool_or(s.stream = 'onboarding') as onboarding from memory_references r
        join memory_sources s on s.id = r.source_id where r.claim_id = ${head.id} and r.revision = ${head.head_revision}`;
    const [used] = await this.sql`select max(o.created_at) as last_used from memory_output_uses u
        join memory_outputs o on o.id = u.output_row_id where u.claim_id = ${head.id} and o.space_id = ${spaceId}`;
    return memoryItem.parse({
      id: head.id,
      key: memoryKeyLabel(head.key),
      value: plainText(head.current.content, 'Saved detail', 16000),
      source: source?.onboarding
        ? 'onboarding'
        : head.current.origin_trust === 'owner'
          ? 'conversation'
          : 'inferred',
      created: head.current.recorded_at,
      last_used: used?.last_used ? new Date(String(used.last_used)).toISOString() : null,
      editable: true,
      version: version(head.id, head.head_revision),
    });
  }
  /**
   * A detail the person states outright, during setup or later. It takes the
   * same path an owner correction takes: the statement is persisted as owner
   * evidence on the `onboarding` stream, and a protected, attributed revision
   * cites it, so the claim carries owner trust and no extractor has to agree.
   * A key already answered gets a new revision rather than a second claim, so
   * one key keeps one current value; the same statement said twice is one item.
   */
  async create(spaceId: string, ownerId: string, raw: unknown) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    const input = memoryItemCreate.parse(raw);
    if (memoryKeyValue(input.key) !== 'text')
      throw new ServiceError(
        'extractor_owned_key',
        'This key is maintained from source evidence. Correct its saved item instead.',
        409,
      );
    const statement = input.statement ?? input.value;
    const at = new Date().toISOString();
    const identity = createHash('sha256')
      .update(JSON.stringify([input.key, statement, input.value]))
      .digest('hex');
    const claimId = await this.sql.begin(async (tx) => {
      await lockEventOrder(tx);
      await lockSpace(tx, scope);
      const [current] = await tx`select c.id from memory_claims c
        join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
        where c.space_id = ${scope.spaceId} and c.key = ${input.key} and c.audience = ${scope.audience}
        and not c.hidden limit 1`;
      const head = current ? await getHead(tx, scope, String(current.id)) : null;
      // The same statement again is the same item, not a second revision.
      const [said] = await tx`select count(*)::int as n from memory_sources
        where space_id = ${scope.spaceId} and publisher = ${scope.publisher}
        and stream = 'onboarding' and source_identity = ${identity}`;
      if (
        Number(said?.n ?? 0) > 0 &&
        head?.current.status === 'active' &&
        head.current.content === input.value
      )
        return head.id;
      const evidence = await persistEvidence(tx, scope, {
        stream: 'onboarding',
        source_identity: identity,
        // Each time the sentence is said anew it is a new version of the same evidence.
        source_version: String(Number(said?.n ?? 0) + 1),
        source_type: 'message',
        author: 'owner',
        event_at: at,
        text: statement,
      });
      if (evidence.source.state !== 'active')
        throw new ServiceError('detail_refused', 'This detail cannot be saved here.', 409);
      const revision = await publishRevision(tx, scope, input.key, head, {
        key: input.key,
        content: input.value,
        // A stated preference joins the profile every attempt carries; any other
        // key is a statement recalled when a request touches it.
        kind: input.key.startsWith('pref.') ? 'preference' : 'user_statement',
        factual_status: 'attributed',
        valid_from: at,
        valid_until: null,
        protected: true,
        sources: [
          {
            source_id: evidence.source.source_id,
            source_version: evidence.source.source_version,
            start: 0,
            end: statement.length,
          },
        ],
      });
      // The statement is the claim's evidence already; nothing is left to extract.
      await tx`update memory_work set status = 'done' where source_id = ${evidence.source.source_id}`;
      await tx`update memory_streams set consumed_sequence = committed_sequence
        where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = 'onboarding'`;
      // Replacing an answer must retire delivered context just as a correction
      // does, including repair briefs for results that used its previous value.
      if (head) {
        await writeRepairBriefs(tx, scope, {
          claimId: head.id,
          key: head.key,
          oldRevision: head.head_revision,
          newRevision: revision.revision,
          oldValue: head.current.content ?? '',
          newValue: input.value,
        });
        await resolveContradictions(tx, scope, input.key);
        await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
        await enqueue(tx, scope.spaceId, 'invalidate', `${head.id}:${revision.revision}`);
      }
      return revision.claim_id;
    });
    await notifyInvalidated(this.sql, scope.spaceId);
    const head = await this.sql.begin(async (tx) => {
      await lockSpace(tx, scope, false);
      return getHead(tx, scope, claimId);
    });
    if (!head || !listed(head)) throw experienceMissing();
    return { item: await this.item(spaceId, head) };
  }
  async edit(spaceId: string, ownerId: string, id: string, raw: unknown) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    const input = memoryItemEdit.parse(raw);
    const head = await this.sql.begin(async (tx) => {
      await lockSpace(tx, scope, false);
      return getHead(tx, scope, id);
    });
    if (!head) throw experienceMissing();
    if (version(id, head.head_revision) !== input.version)
      throw new ServiceError(
        'item_changed',
        'This detail changed. Read it again before editing.',
        409,
      );
    const at = new Date().toISOString();
    await correctClaim(this.sql, scope, {
      claim_id: id,
      expected_revision: head.head_revision,
      text: input.value,
      content: input.value,
      valid_from: at,
      valid_until: null,
      idempotency_key: `experience:${createHash('sha256').update(`${id}:${input.version}:${input.value}`).digest('hex')}`,
    });
    return { status: 'ok' };
  }
  async forget(spaceId: string, ownerId: string, id: string) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    if (!this.journal)
      return unavailable('Forgetting is not connected to the saved deletion history yet.');
    await forgetMemory(this.sql, scope, { claim_id: id }, this.journal);
    return { status: 'ok' };
  }
  /** Whether new things this person says in chat are kept. On until they say otherwise. */
  async settings(principalId: string) {
    const [row] = await this
      .sql`select capture from memory_settings where principal_id = ${principalId}`;
    return memorySettings.parse({ capture: row ? Boolean(row.capture) : true });
  }
  async saveSettings(principalId: string, raw: unknown) {
    const input = memorySettings.parse(raw);
    await this
      .sql`insert into memory_settings (principal_id, capture) values (${principalId}, ${input.capture})
      on conflict (principal_id) do update set capture = excluded.capture, updated_at = now()`;
    return input;
  }
  async why(spaceId: string, ownerId: string, id: string) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    return this.sql.begin(async (tx) => {
      await lockSpace(tx, scope, false);
      if (!(await getHead(tx, scope, id))) throw experienceMissing();
      const [output] =
        await tx`select o.*, j.title from memory_outputs o join memory_output_uses u on u.output_row_id = o.id
        left join job j on j.id = o.job_id and j.space_id = o.space_id ${ownJobClause(tx, 'j', ownerId)}
        where o.space_id = ${spaceId} and u.claim_id = ${id} order by o.created_at desc limit 1`;
      if (!output) return { reasons: [], output: null, used_at: null };
      const uses =
        await tx`select handle from memory_output_uses where output_row_id = ${output.id}`;
      return {
        reasons: await explainHandles(
          tx,
          spaceId,
          uses.map((row) => String(row.handle)),
        ),
        output: output.title
          ? `Used for ${plainText(output.title, 'your request')}.`
          : 'Used in a recent result.',
        used_at: new Date(String(output.created_at)).toISOString(),
      };
    });
  }
}
