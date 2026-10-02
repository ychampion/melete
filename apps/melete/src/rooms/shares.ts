/**
 * A person's own saved detail, shared into a room. A share is a reference: the
 * room's work reads the detail's current value from the person's own memory,
 * through this one narrow path, and only while
 *
 * - the share has not been withdrawn;
 * - the person who shared it is still in the room, and the detail is still in
 *   their own personal space;
 * - the detail is still remembered there (not forgotten, hidden or removed);
 * - and, for a members-only share, no guest is in the room.
 *
 * Forgetting the detail in the person's own space therefore takes it out of
 * every room at once, and a database restored from before the forgetting
 * replays it and keeps it out. Nothing else of the person's memory is read.
 */
import {
  type KnowledgeExcerpt,
  minimumOriginTrust,
  type RecallItem,
  type RecallResult,
  recallRequest,
} from '@melete/contracts';
import { eligibleRevision } from '../memory/claims.ts';
import { MemoryError, type MemoryScope, type MemorySql, type MemoryTx } from '../memory/db.ts';
import { asKnowledge, itemAt, itemTokens } from '../memory/recall.ts';
import { personLabel } from './transcript.ts';

/** The most shared details one attempt is handed, and the tokens they may take. */
export const SHARED_LIMIT = 20;
export const SHARED_TOKENS = 2000;

type Grant = {
  id: string;
  claim_id: string;
  source_space_id: string;
  granted_by: string;
  members_only: boolean;
  memory_owner_id: string;
  head_revision: number;
  display_name: string | null;
  email: string;
};

/**
 * The shares a room's work may read now, newest first. Every condition in the
 * file comment is checked here, in one statement, against current rows.
 */
async function liveGrants(
  tx: MemoryTx | MemorySql,
  roomSpaceId: string,
  claimId?: string,
  limit = SHARED_LIMIT,
) {
  const rows = await tx`select g.id, g.claim_id, g.source_space_id, g.granted_by, g.members_only,
      ms.owner_id as memory_owner_id, c.head_revision, p.display_name, p.email
    from memory_room_grant g
    join space room on room.id = g.room_space_id and room.kind = 'shared' and room.removed_at is null
    join space_membership m on m.space_id = g.room_space_id and m.principal_id = g.granted_by
      and m.revoked_at is null and m.role in ('owner', 'member')
    join principal p on p.id = g.granted_by and p.kind = 'person'
    join space own on own.id = g.source_space_id and own.kind = 'personal' and own.removed_at is null
      and coalesce(own.owner_principal_id, (select id from owner limit 1)) = g.granted_by
    join memory_spaces ms on ms.space_id = g.source_space_id and not ms.revoked and ms.restore_ready
    join memory_claims c on c.id = g.claim_id and c.space_id = g.source_space_id and not c.hidden
    where g.room_space_id = ${roomSpaceId} and g.revoked_at is null
      and (${claimId ?? null}::text is null or g.claim_id = ${claimId ?? null})
      and (not g.members_only or not exists (select 1 from space_membership guest
        where guest.space_id = g.room_space_id and guest.role = 'guest' and guest.revoked_at is null))
    order by g.created_at desc, g.id desc limit ${limit}`;
  return rows as unknown as Grant[];
}

/** The person's own memory, as the service holds it, for reading one shared detail. */
const ownerScope = (grant: Pick<Grant, 'memory_owner_id' | 'source_space_id'>): MemoryScope => ({
  ownerId: grant.memory_owner_id,
  spaceId: grant.source_space_id,
  publisher: 'room-share',
  audience: 'private',
  role: 'owner',
});

export type SharedItem = { item: RecallItem; sharedBy: string };

/**
 * What a room request is handed of the details people shared into its room.
 * A detail learned in a private conversation is handed only to an attempt
 * that stays on the person's own model, as with their own recall. A shared
 * detail is someone else's word to the room, so it never carries more than
 * `external_content` trust. Anything other than a room request gets nothing.
 */
export async function sharedItems(
  sql: MemorySql,
  roomScope: MemoryScope,
  jobId: string,
  options: { privateOrigin?: boolean } = {},
): Promise<SharedItem[]> {
  return sql.begin(async (tx) => {
    const [request] = await tx`select id from job where id = ${jobId}
      and space_id = ${roomScope.spaceId} and audience = 'room'`;
    if (!request) return [];
    const shared: SharedItem[] = [];
    let used = 0;
    for (const grant of await liveGrants(tx, roomScope.spaceId)) {
      const item = await itemAt(
        tx,
        ownerScope(grant),
        { claim_id: grant.claim_id, revision: grant.head_revision, score: 0 },
        recallRequest.parse({ query: '', mode: 'current' }),
      );
      if (!item) continue;
      if (!options.privateOrigin) {
        const [privately] = await tx`select 1 from memory_references ref
          join memory_sources s on s.id = ref.source_id
          where ref.claim_id = ${item.claim_id} and ref.revision = ${item.revision}
            and s.private_origin is not null limit 1`;
        if (privately) continue;
      }
      const capped: RecallItem = {
        ...item,
        origin_trust: minimumOriginTrust([item.origin_trust, 'external_content']),
      };
      const tokens = itemTokens(capped);
      if (used + tokens > SHARED_TOKENS) continue;
      used += tokens;
      shared.push({
        item: capped,
        sharedBy: personLabel({ displayName: grant.display_name, email: grant.email }),
      });
    }
    return shared;
  });
}

/**
 * Whether a room's attempt may still hold this revision of a shared detail:
 * the same conditions as when it was handed over, read again now.
 */
export async function sharedRevisionEligible(
  tx: MemoryTx,
  roomSpaceId: string,
  claimId: string,
  revision: number,
) {
  const [grant] = await liveGrants(tx, roomSpaceId, claimId);
  if (!grant || grant.head_revision !== revision) return false;
  return eligibleRevision(tx, ownerScope(grant), claimId, revision);
}

/** A shared detail as the agent reads it: the detail, and whose word it is. */
export function sharedKnowledgeNote(sharedBy: string) {
  return `Shared into this room by ${JSON.stringify(sharedBy)} from their own memory.`;
}

/**
 * Share one of a person's own saved details into a room they are in. The
 * detail must be in their personal space and remembered now. Sharing the same
 * detail again answers with the share already there.
 */
export async function shareIntoRoom(
  sql: MemorySql,
  input: {
    roomSpaceId: string;
    principalId: string;
    claimId: string;
    membersOnly: boolean;
    grantId: string;
  },
): Promise<{ id: string; created: boolean }> {
  return sql.begin(async (tx) => {
    const [own] = await tx`select s.id, ms.owner_id as memory_owner_id from space s
      join memory_spaces ms on ms.space_id = s.id and not ms.revoked and ms.restore_ready
      where s.kind = 'personal' and s.removed_at is null
        and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${input.principalId}
      order by s.created_at, s.id limit 1`;
    if (!own) throw new MemoryError('claim_not_found');
    const [claim] = await tx`select id, head_revision from memory_claims
      where id = ${input.claimId} and space_id = ${own.id} and not hidden for share`;
    if (!claim) throw new MemoryError('claim_not_found');
    const scope = ownerScope({ memory_owner_id: own.memory_owner_id, source_space_id: own.id });
    const item = await itemAt(
      tx,
      scope,
      { claim_id: claim.id, revision: claim.head_revision, score: 0 },
      recallRequest.parse({ query: '', mode: 'current' }),
    );
    if (!item) throw new MemoryError('claim_not_found');
    // Learned in a conversation that was private: it stays the person's own.
    const [privately] = await tx`select 1 from memory_references ref
      join memory_sources s on s.id = ref.source_id
      where ref.claim_id = ${claim.id} and s.private_origin is not null limit 1`;
    if (privately) throw new MemoryError('private_detail');
    const [existing] = await tx`select id from memory_room_grant
      where claim_id = ${claim.id} and room_space_id = ${input.roomSpaceId} and revoked_at is null`;
    if (existing) return { id: String(existing.id), created: false };
    await tx`insert into memory_room_grant (id, claim_id, source_space_id, room_space_id, granted_by, members_only)
      values (${input.grantId}, ${claim.id}, ${own.id}, ${input.roomSpaceId}, ${input.principalId}, ${input.membersOnly})`;
    return { id: input.grantId, created: true };
  });
}

export type ShareRow = {
  id: string;
  claim_id: string;
  granted_by: string;
  members_only: boolean;
  created_at: Date;
  key: string | null;
  content: string | null;
};

/**
 * The room's shares a person in the room can see now: each with the detail's
 * current value while the room's work could read it, or none once it could
 * not. A guest sees no members-only share.
 */
export async function roomShares(
  sql: MemorySql,
  roomSpaceId: string,
  viewerIsGuest: boolean,
): Promise<ShareRow[]> {
  const rows = await sql`select g.id, g.claim_id, g.granted_by, g.members_only, g.created_at
    from memory_room_grant g where g.room_space_id = ${roomSpaceId} and g.revoked_at is null
      and (${!viewerIsGuest} or not g.members_only)
    order by g.created_at desc, g.id desc limit 200`;
  const live = new Map(
    (await liveGrants(sql, roomSpaceId, undefined, 200)).map((grant) => [grant.id, grant]),
  );
  const shares: ShareRow[] = [];
  for (const row of rows) {
    const grant = live.get(String(row.id));
    let key: string | null = null;
    let content: string | null = null;
    if (grant) {
      const item = await sql.begin((tx) =>
        itemAt(
          tx,
          ownerScope(grant),
          { claim_id: grant.claim_id, revision: grant.head_revision, score: 0 },
          recallRequest.parse({ query: '', mode: 'current' }),
        ),
      );
      if (item) {
        key = item.key;
        content = item.content;
      }
    }
    shares.push({
      id: String(row.id),
      claim_id: String(row.claim_id),
      granted_by: String(row.granted_by),
      members_only: Boolean(row.members_only),
      created_at: new Date(row.created_at as string),
      key,
      content,
    });
  }
  return shares;
}

/**
 * A recall, with the details shared into the room added after what the room
 * itself remembers: the knowledge the attempt is handed, each shared detail
 * saying whose it is, and the recall the attempt's context record lists, so
 * forgetting a shared detail invalidates the attempt that holds it.
 */
export async function withSharedItems(
  sql: MemorySql,
  scope: MemoryScope,
  jobId: string,
  result: RecallResult,
  privateOrigin: boolean,
): Promise<{ recall: RecallResult; knowledge: KnowledgeExcerpt[] }> {
  const shared = await sharedItems(sql, scope, jobId, { privateOrigin });
  return {
    recall: shared.length
      ? { ...result, items: [...result.items, ...shared.map((entry) => entry.item)] }
      : result,
    knowledge: [
      ...result.items.map(asKnowledge),
      ...shared.map((entry) => {
        const excerpt = asKnowledge(entry.item);
        return {
          ...excerpt,
          excerpt: `${sharedKnowledgeNote(entry.sharedBy)}\n${excerpt.excerpt}`,
        };
      }),
    ],
  };
}
