/**
 * Who may decide a room's permissions. A room's request belongs to the room's
 * principal, so "the job's own principal" names nobody who can answer; the
 * room's rule names them instead:
 *
 * - `requester` (the default): the person who asked the request, while they
 *   are still a member;
 * - `any_member`: anyone in the room who is not a guest;
 * - `owners`: the room's owners.
 *
 * What the agent does through the room's own accounts (team accounts: the
 * connections in the room's space marked for the room, other than the tools
 * every room has) follows the room's team-account rule instead: any member who
 * is not a guest, the person who asked included (the default), or the room's
 * owners. `approverRuleFor` is the one place that picks the rule for an action.
 * Adding to a member's explicitly shared calendar instead asks that member
 * alone, while their exact consent still allows adding events.
 *
 * Guests, the room's own principal, the service's own key and anyone outside
 * the room never decide. The check runs when an answer is recorded, inside the
 * broker's decision transaction: that holds the event order lock, which every
 * change to a room's roster also takes, so a person removed a moment earlier
 * is already not a member here.
 */
import type { JsonObject, RoomApprovers, RoomTeamAccountApprovers } from '@melete/contracts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { resolveRoomCalendarShare } from './calendar-shares.ts';
import { personLabel } from './transcript.ts';

export const ROOM_POLICY_DEFAULTS = {
  approvers: 'requester' as RoomApprovers,
  team_account_approvers: 'any_member' as RoomTeamAccountApprovers,
  agent_turns: 'asked' as 'asked' | 'every_message',
  guests_may_ask: true,
  requests_per_hour: 30,
  requests_per_person_hour: 10,
};
export type RoomPolicyValues = typeof ROOM_POLICY_DEFAULTS;

/** A room's settings, or the defaults for a room that has never changed them. */
export async function roomPolicyIn(tx: Query, spaceId: string): Promise<RoomPolicyValues> {
  const [row] = await tx`select approvers, team_account_approvers, agent_turns, guests_may_ask,
      requests_per_hour, requests_per_person_hour from room_policy where space_id = ${spaceId}`;
  if (!row) return { ...ROOM_POLICY_DEFAULTS };
  return {
    approvers: String(row.approvers) as RoomApprovers,
    team_account_approvers: row.team_account_approvers === 'owners' ? 'owners' : 'any_member',
    agent_turns: row.agent_turns === 'every_message' ? 'every_message' : 'asked',
    guests_may_ask: row.guests_may_ask === true,
    requests_per_hour: Number(row.requests_per_hour),
    requests_per_person_hour: Number(row.requests_per_person_hour),
  };
}

/** The room request a job's permissions belong to, and the rule that decides them. */
export type RoomAuthority = {
  spaceId: string;
  /** The request the person asked: the job itself, or the request whose step it is. */
  requestJobId: string;
  threadId: string | null;
  /** Null when nothing records who asked; then no one is the requester. */
  requestedBy: string | null;
  approvers: RoomApprovers;
  /** Member calendar consent takes precedence over both of the room's rules. */
  rule: 'room' | 'team_accounts' | 'member_calendar';
  /** Exact consent bound before the member was asked, never a room-wide permission. */
  calendarMember?: {
    principalId: string;
    connectionId: string;
    sharedAt: string;
    membershipGeneration: number;
  } | null;
};

/** What one permission is about, as far as choosing its rule goes. */
export type ApprovalSubject = {
  /** The connection the action goes through, if any. */
  connectionId: string | null;
  kind: string;
  payload: JsonObject;
};

/**
 * The rule that names who decides one action of a room's request. An action
 * through one of the room's own accounts follows the team-account rule; any
 * other follows the room's rule, where a guest's request goes to the owners
 * under "the person who asked". Rules for one account or one kind of action
 * would be chosen here, ahead of these.
 *
 * `roomDecisions` in `push/service.ts` makes the same choice in SQL, together
 * with `isTeamAccount` and `eligibleApprovers`, to pick who is pushed about a
 * permission. A change to the rule here changes it there too; the room
 * approval tests check both agree on who is told.
 */
export function approverRuleFor(
  policy: Pick<RoomPolicyValues, 'approvers' | 'team_account_approvers'>,
  action: { teamAccount: boolean; guestAsked: boolean },
): Pick<RoomAuthority, 'approvers' | 'rule'> {
  if (action.teamAccount)
    return { approvers: policy.team_account_approvers, rule: 'team_accounts' };
  return {
    approvers: policy.approvers === 'requester' && action.guestAsked ? 'owners' : policy.approvers,
    rule: 'room',
  };
}

/**
 * Whether a connection is one of a room's own accounts: in the room's space,
 * marked for the room, and not one of the tools every room has. A person's own
 * account lives in their own space, so it is never one.
 */
export async function isTeamAccount(
  tx: Query,
  spaceId: string,
  connectionId: string | null,
): Promise<boolean> {
  if (!connectionId) return false;
  const [row] = await tx`select 1 from connection where id = ${connectionId}
    and space_id = ${spaceId} and shared_use = 'room' and not (configuration ? 'builtin')`;
  return Boolean(row);
}

/**
 * Whether a job is a room's work, and if so whose request it is. A job of a
 * room's request, a step a request started, and any other job the room's own
 * principal holds are all the room's; anything else is a person's own and
 * returns null. A room's job that names no request decides under the room's
 * rule with no requester, so only `any_member` or `owners` can answer it.
 * Given the action a permission is about, the rule is the one for that action
 * (`approverRuleFor`); left out, it is the room's general rule.
 */
export async function roomAuthorityOf(
  tx: Query,
  jobId: string,
  subject?: ApprovalSubject,
): Promise<RoomAuthority | null> {
  const [row] = await tx`select j.id, j.space_id, j.audience, j.requested_by_principal_id,
      j.room_thread_id, p.kind as principal_kind, r.id as parent_id, r.audience as parent_audience,
      r.requested_by_principal_id as parent_requested_by, r.room_thread_id as parent_thread_id
    from job j left join principal p on p.id = j.principal_id
    left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.id = ${jobId}`;
  if (!row) return null;
  const request =
    row.parent_audience === 'room'
      ? {
          id: String(row.parent_id),
          requestedBy: row.parent_requested_by as string | null,
          threadId: row.parent_thread_id as string | null,
        }
      : row.audience === 'room'
        ? {
            id: String(row.id),
            requestedBy: row.requested_by_principal_id as string | null,
            threadId: row.room_thread_id as string | null,
          }
        : row.principal_kind === 'room'
          ? { id: String(row.id), requestedBy: null, threadId: null }
          : null;
  if (!request) return null;
  const spaceId = String(row.space_id);
  if (subject?.kind === 'room.add_to_member_calendar') {
    const payload = subject.payload;
    return {
      spaceId,
      requestJobId: request.id,
      threadId: request.threadId,
      requestedBy: request.requestedBy,
      approvers: 'requester',
      rule: 'member_calendar',
      calendarMember:
        typeof payload?.member === 'string' &&
        typeof payload.calendar_connection_id === 'string' &&
        typeof payload.share_created_at === 'string' &&
        typeof payload.membership_generation === 'number'
          ? {
              principalId: payload.member,
              connectionId: payload.calendar_connection_id,
              sharedAt: payload.share_created_at,
              membershipGeneration: payload.membership_generation,
            }
          : null,
    };
  }
  const policy = await roomPolicyIn(tx, spaceId);
  return {
    spaceId,
    requestJobId: request.id,
    threadId: request.threadId,
    requestedBy: request.requestedBy,
    ...approverRuleFor(policy, {
      teamAccount: await isTeamAccount(tx, spaceId, subject?.connectionId ?? null),
      guestAsked: await guestAsked(tx, request.requestedBy),
    }),
  };
}

/**
 * Whether a request was asked by a guest. A guest never answers a permission,
 * so where the room's rule is "the person who asked", a guest's request is
 * answered by the room's owners instead.
 */
async function guestAsked(tx: Query, requestedBy: string | null): Promise<boolean> {
  if (!requestedBy) return false;
  const [asker] = await tx`select kind from principal where id = ${requestedBy}`;
  return asker?.kind === 'guest';
}

/**
 * Everyone who may decide now, oldest membership first: current members of a
 * room still in place, who are people (never a guest or a room's principal),
 * narrowed by the room's rule.
 */
export async function eligibleApprovers(tx: Query, authority: RoomAuthority): Promise<string[]> {
  if (authority.rule === 'member_calendar') {
    const member = authority.calendarMember;
    if (!member) return [];
    try {
      const { share } = await resolveRoomCalendarShare(
        tx,
        authority.spaceId,
        member.principalId,
        true,
      );
      return share.connectionId === member.connectionId &&
        share.membershipGeneration === member.membershipGeneration &&
        share.createdAt.toISOString() === member.sharedAt
        ? [member.principalId]
        : [];
    } catch (error) {
      if (error instanceof BrokerFault && error.code === 'scope_denied') return [];
      throw error;
    }
  }
  const rows = await tx`select m.principal_id from space_membership m
    join principal p on p.id = m.principal_id
    join space s on s.id = m.space_id
    where m.space_id = ${authority.spaceId} and m.revoked_at is null
      and s.kind = 'shared' and s.removed_at is null and p.kind = 'person'
      and m.role in ('owner', 'member')
      and case ${authority.approvers}::text
        when 'requester' then m.principal_id = ${authority.requestedBy ?? ''}
        when 'any_member' then true
        when 'owners' then m.role = 'owner'
        else false end
    order by m.created_at, m.principal_id`;
  return rows.map((row) => String(row.principal_id));
}

export async function mayDecide(
  tx: Query,
  authority: RoomAuthority,
  principalId: string,
): Promise<boolean> {
  return (await eligibleApprovers(tx, authority)).includes(principalId);
}

/** Who the room is waiting for, in a person's words. */
export function waitingFor(authority: RoomAuthority, names: ReadonlyMap<string, string>): string {
  if (authority.rule === 'member_calendar') {
    const member = authority.calendarMember;
    const name = member ? names.get(member.principalId) : undefined;
    return name
      ? `Waiting for ${name}, whose calendar this adds to. Only they can answer it.`
      : 'Only the member who shared this calendar can answer it while that share allows adding events.';
  }
  if (authority.rule === 'team_accounts')
    return authority.approvers === 'owners'
      ? "It goes through an account the room uses. Waiting for one of the room's owners to answer it."
      : 'It goes through an account the room uses, so anyone in the room who is not a guest can answer it.';
  const asker = authority.requestedBy ? names.get(authority.requestedBy) : undefined;
  switch (authority.approvers) {
    case 'requester':
      return asker
        ? `Waiting for ${asker}, who asked for it. Only they can answer it.`
        : 'Nobody in the room can answer this one.';
    case 'any_member':
      return 'Anyone in the room who is not a guest can answer it.';
    case 'owners':
      return "Waiting for one of the room's owners to answer it.";
  }
}

/** Each principal's label in a room (name and handle), read over a raw connection. */
export async function labelsIn(
  tx: Query,
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Map();
  const rows = await tx`select id, display_name, email from principal where id = any(${unique})`;
  return new Map(
    rows.map((row) => [
      String(row.id),
      personLabel(
        {
          id: String(row.id),
          displayName: (row.display_name ?? null) as string | null,
          email: String(row.email),
        },
        spaceId,
      ),
    ]),
  );
}
