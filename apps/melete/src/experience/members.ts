/**
 * The people in the space a session is using, and taking one out of a shared
 * space. Removal is the membership revocation the principals module already
 * keeps: it ends the person's sessions in the space, stops their work there and
 * keeps everything they made in the space.
 */
import { spaceMembers } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import type { JobService } from '../jobs/service.ts';
import { PrincipalService } from '../principals/service.ts';

export async function listMembers(sql: Sql, spaceId: string, principalId: string) {
  const [space] = await sql`select s.id, s.name, s.kind,
      coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id
    from space s where s.id = ${spaceId}`;
  if (!space) throw new ServiceError('not_found', 'That item is not here.', 404);
  const shared = space.kind === 'shared';
  const rows = shared
    ? await sql`select m.principal_id, p.email, m.role from space_membership m
        join principal p on p.id = m.principal_id
        where m.space_id = ${spaceId} and m.revoked_at is null
        order by (m.role = 'owner') desc, p.email`
    : await sql`select ${space.owner_id}::text as principal_id, 'owner' as role,
        coalesce((select email from principal where id = ${space.owner_id}),
          (select email from owner where id = ${space.owner_id}), '') as email`;
  return spaceMembers.parse({
    space: {
      id: space.id,
      name: space.name,
      kind: shared ? 'shared' : 'personal',
      role: space.owner_id === principalId ? 'owner' : 'member',
    },
    members: rows.map((row) => ({
      principal_id: row.principal_id,
      email: row.email,
      role: row.role === 'owner' ? 'owner' : 'member',
      you: row.principal_id === principalId,
    })),
  });
}

export async function removeMember(
  db: Database,
  jobs: JobService,
  spaceId: string,
  actor: string,
  memberId: string,
) {
  // Revocation reads no files, so the service needs no spaces root here.
  await new PrincipalService(db, '', jobs).revoke(actor, spaceId, memberId);
  return { status: 'ok' as const };
}
