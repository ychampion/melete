import { createHash } from 'node:crypto';
import { memoryItem, memoryItemEdit, unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { correctClaim, getHead, listClaims } from '../memory/claims.ts';
import { lockSpace, type MemoryScope } from '../memory/db.ts';
import { forgetMemory } from '../memory/forget.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { explainHandles, memoryKeyLabel } from './evidence.ts';
import { plainText } from './projectors.ts';
import { experienceMissing } from './service.ts';

const version = (id: string, revision: number) =>
  createHash('sha256').update(`${id}:${revision}`).digest('hex');
export class ExperienceMemory {
  constructor(
    readonly sql: Sql,
    readonly journal?: RestrictionJournal,
  ) {}
  async scope(spaceId: string, ownerId: string): Promise<MemoryScope | null> {
    const [row] = await this.sql`select space_id from memory_spaces where space_id = ${spaceId}
      and owner_id = ${ownerId} and restore_ready and not revoked`;
    return row
      ? { spaceId, ownerId, publisher: 'experience', audience: 'private', role: 'owner' }
      : null;
  }
  async list(spaceId: string, ownerId: string) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    const { claims } = await listClaims(this.sql, scope);
    const items = [];
    for (const head of claims.filter(
      (row) => row.current.status === 'active' && row.current.content !== null,
    )) {
      const [source] = await this
        .sql`select bool_or(s.stream = 'onboarding') as onboarding from memory_references r
        join memory_sources s on s.id = r.source_id where r.claim_id = ${head.id} and r.revision = ${head.head_revision}`;
      const [used] = await this.sql`select max(o.created_at) as last_used from memory_output_uses u
        join memory_outputs o on o.id = u.output_row_id where u.claim_id = ${head.id} and o.space_id = ${spaceId}`;
      items.push(
        memoryItem.parse({
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
        }),
      );
    }
    return { items };
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
  async why(spaceId: string, ownerId: string, id: string) {
    const scope = await this.scope(spaceId, ownerId);
    if (!scope) return unavailable('Your saved details are not connected yet.');
    return this.sql.begin(async (tx) => {
      await lockSpace(tx, scope, false);
      if (!(await getHead(tx, scope, id))) throw experienceMissing();
      const [output] =
        await tx`select o.*, j.title from memory_outputs o join memory_output_uses u on u.output_row_id = o.id
        left join job j on j.id = o.job_id and j.space_id = o.space_id
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
