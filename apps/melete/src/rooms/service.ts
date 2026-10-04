/**
 * Rooms. A room is a shared space; its people talk in threads, and its agent
 * acts as the room's own principal, never as any one of them. Every method
 * here takes the person asking as an argument and checks their membership,
 * at its current generation, before it reads or writes anything.
 */
import { createHash } from 'node:crypto';
import {
  displayNameText,
  isTerminal,
  type JobState,
  type RoomPolicy,
  type RoomRole,
  type RoomStreamFrame,
  roomDetail,
  roomList,
  roomMember,
  roomStreamFrame,
  unavailable,
} from '@melete/contracts';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  agent,
  approval,
  connection,
  event,
  job,
  principal,
  space,
  spaceMembership,
} from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import type { ExperienceEvents } from '../experience/events.ts';
import type { ExperiencePermissions } from '../experience/permissions.ts';
import { newId } from '../ids.ts';
import { PolicyService } from '../jobs/policy.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import { principalContext, spaceAuthority } from '../principals/authority.ts';
import type { PrincipalService } from '../principals/service.ts';
import { ComputerFault, type SandboxComputerService } from '../sandbox/computer.ts';
import { postToThread } from './handoffs.ts';
import { mentionsOf } from './mentions.ts';
import { askLimitReached, readRoomPolicy, writeRoomPolicy } from './policy.ts';
import { presentIn } from './presence.ts';
import { messageView, requestView, threadView } from './projection.ts';
import {
  type RoomWork,
  releaseThread,
  roomAgentOf,
  roomPrincipalOf,
  startRequest,
  threadHeld,
  touchMessage,
} from './release.ts';
import { roomMessage, roomPresence, roomThread } from './schema.ts';

export { mentionsOf };

import { displayName, namesOf, personLabel, roomHandle } from './transcript.ts';

const missing = () => new ServiceError('not_found', 'That room is not here.', 404);
const connectionView = (row: typeof connection.$inferSelect) => ({
  id: row.id,
  label: row.label,
  provider: row.provider,
  status: row.status,
  shared_use: row.sharedUse === 'room' ? ('room' as const) : ('owner' as const),
  builtin: row.configuration.builtin !== undefined,
});
const roomOwnerOnly = () =>
  new ServiceError('scope_denied', 'Only an owner of this room can do that.', 403);

/**
 * Whether a name is another account's: its chosen name, or the part before the
 * @ of its email, ignoring case. A name is how a room, and its agent, tell
 * people apart at a glance; the handle after it is what settles it.
 */
export async function nameTaken(db: Database, name: string, except?: string): Promise<boolean> {
  const [taken] = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        except ? ne(principal.id, except) : undefined,
        or(
          sql`lower(${principal.displayName}) = lower(${name})`,
          sql`lower(split_part(${principal.email}, '@', 1)) = lower(${name})`,
        ),
      ),
    )
    .limit(1);
  return Boolean(taken);
}

export type RoomDeps = RoomWork & {
  db: Database;
  /** The desktops of the room's computers, when this installation runs them. */
  computers?: SandboxComputerService;
  principals: PrincipalService;
  runner?: AttemptRunner;
  /** The conversation projector, run as the room's principal for the room's requests. */
  events?: ExperienceEvents;
  /** Permission cards and answers, for the room's own permissions. */
  permissions?: ExperiencePermissions;
};

export class RoomService {
  constructor(readonly deps: RoomDeps) {}

  /**
   * The caller's place in a room, checked now: a current membership of a
   * shared space that is not being removed. The room's own principal and any
   * other space are refused as if the room were not there.
   */
  async access(reader: Database | Transaction, spaceId: string, actor: string, lock = false) {
    const granted = await spaceAuthority(reader, spaceId, actor, lock).catch((error: unknown) => {
      if (error instanceof ServiceError) throw missing();
      throw error;
    });
    if (granted.space.kind !== 'shared' || granted.role === 'agent') throw missing();
    const room = await roomPrincipalOf(reader, spaceId);
    return { role: granted.role as RoomRole, roomPrincipal: room.id, space: granted.space };
  }

  private async kindOf(actor: string) {
    const [row] = await this.deps.db
      .select({ kind: principal.kind })
      .from(principal)
      .where(eq(principal.id, actor));
    return row?.kind ?? null;
  }

  async list(actor: string) {
    const rows = await this.deps.db
      .select({ space, role: spaceMembership.role })
      .from(spaceMembership)
      .innerJoin(space, eq(space.id, spaceMembership.spaceId))
      .where(
        and(
          eq(spaceMembership.principalId, actor),
          isNull(spaceMembership.revokedAt),
          or(isNull(spaceMembership.expiresAt), gt(spaceMembership.expiresAt, sql`now()`)),
          ne(spaceMembership.role, 'agent'),
          eq(space.kind, 'shared'),
          isNull(space.removedAt),
        ),
      )
      .orderBy(asc(space.createdAt), asc(space.id));
    const rooms = [];
    for (const row of rows) rooms.push(await this.summary(row.space, row.role as RoomRole, actor));
    return roomList.parse({ rooms });
  }

  private async summary(row: typeof space.$inferSelect, role: RoomRole, actor: string) {
    const [seen] = await this.deps.db
      .select({ at: roomPresence.lastSeenAt })
      .from(roomPresence)
      .where(and(eq(roomPresence.spaceId, row.id), eq(roomPresence.principalId, actor)));
    const [unread] = await this.deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(roomMessage)
      .where(
        and(
          eq(roomMessage.spaceId, row.id),
          ne(roomMessage.authorPrincipalId, actor),
          seen ? gt(roomMessage.createdAt, seen.at) : undefined,
        ),
      );
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      my_role: role,
      unread: Number(unread?.count ?? 0),
      created_at: row.createdAt.toISOString(),
    };
  }

  async create(actor: string, name: string, purpose?: string) {
    if ((await this.kindOf(actor)) !== 'person')
      throw new ServiceError('scope_denied', 'Only a person can make a room.', 403);
    const made = await this.deps.principals.createShared(actor, name, purpose);
    if (!made) throw new Error('Space insert returned no row');
    await serviceTransaction(this.deps.db, (tx) => roomAgentOf(tx, made.id));
    return made.id;
  }

  async detail(spaceId: string, actor: string) {
    const access = await this.access(this.deps.db, spaceId, actor);
    const rows = await this.deps.db
      .select({ membership: spaceMembership, person: principal })
      .from(spaceMembership)
      .innerJoin(principal, eq(principal.id, spaceMembership.principalId))
      .where(
        and(
          eq(spaceMembership.spaceId, spaceId),
          isNull(spaceMembership.revokedAt),
          ne(spaceMembership.role, 'agent'),
        ),
      )
      .orderBy(asc(spaceMembership.createdAt), asc(spaceMembership.principalId));
    const present = new Set(await presentIn(this.deps.db, spaceId));

    const persona = await serviceTransaction(this.deps.db, (tx) => roomAgentOf(tx, spaceId));
    return roomDetail.parse({
      room: {
        ...(await this.summary(access.space, access.role, actor)),
        agent_name: persona.name,
      },
      members: rows.map(({ membership, person }) =>
        roomMember.parse({
          principal_id: person.id,
          display_name: personLabel(person, spaceId),
          role: membership.role,
          handle: roomHandle(spaceId, person.id),
          // A guest sees who is in the room, not how to reach them.
          ...(access.role === 'guest' ? {} : { email: person.email }),
          expires_at: membership.expiresAt?.toISOString() ?? null,
          present: present.has(person.id),
        }),
      ),
      policy: await readRoomPolicy(this.deps.db, spaceId),
    });
  }

  async addMember(spaceId: string, actor: string, memberId: string) {
    const access = await this.access(this.deps.db, spaceId, actor);
    if (access.role !== 'owner') throw roomOwnerOnly();
    await this.deps.principals.grant(actor, spaceId, memberId);
    const [person] = await this.deps.db.select().from(principal).where(eq(principal.id, memberId));
    if (!person) throw missing();
    return {
      member: roomMember.parse({
        principal_id: person.id,
        display_name: personLabel(person, spaceId),
        role: 'member',
        handle: roomHandle(spaceId, person.id),
        email: person.email,
        present: false,
      }),
    };
  }

  /** An owner removes someone, or a person leaves. Their access, and their open streams, end at once. */
  async removeMember(spaceId: string, actor: string, memberId: string) {
    const access = await this.access(this.deps.db, spaceId, actor);
    if (access.role !== 'owner' && actor !== memberId) throw roomOwnerOnly();
    await this.deps.principals.revoke(actor, spaceId, memberId);
    return { removed: memberId };
  }

  /** Accounts a person can add to a room: people, never a room's own principal or a guest. */
  async people(actor: string, query?: string) {
    if ((await this.kindOf(actor)) !== 'person')
      throw new ServiceError('scope_denied', 'Only a person can look up people.', 403);
    const pattern = query?.trim() ? `%${query.trim().replace(/[\\%_]/g, '\\$&')}%` : undefined;
    const rows = await this.deps.db
      .select()
      .from(principal)
      .where(
        and(
          eq(principal.kind, 'person'),
          pattern
            ? or(ilike(principal.email, pattern), ilike(principal.displayName, pattern))
            : undefined,
        ),
      )
      .orderBy(asc(principal.email))
      .limit(50);
    return {
      people: rows.map((row) => ({ id: row.id, display_name: displayName(row), email: row.email })),
    };
  }

  /**
   * Set the name a person shows in rooms. It must read as one line, and it
   * must not be another person's name, or the part before the @ of another
   * person's email, ignoring case: a name is how a room, and its agent, tell
   * people apart.
   */
  async rename(actor: string, name: string | null) {
    if (name !== null) {
      displayNameText.parse(name);
      if (await nameTaken(this.deps.db, name, actor))
        throw new ServiceError(
          'name_taken',
          'Someone here already goes by that name. Choose another.',
          409,
        );
    }
    const [row] = await this.deps.db
      .update(principal)
      .set({ displayName: name })
      .where(and(eq(principal.id, actor), inArray(principal.kind, ['person', 'guest'])))
      .returning();
    if (!row) throw new ServiceError('not_found', 'Account not found.', 404);
    return {
      owner: {
        id: row.id,
        email: row.email,
        created_at: row.createdAt.toISOString(),
        display_name: row.displayName,
      },
    };
  }

  async threads(spaceId: string, actor: string) {
    await this.access(this.deps.db, spaceId, actor);
    const rows = await this.deps.db
      .select()
      .from(roomThread)
      .where(eq(roomThread.spaceId, spaceId))
      .orderBy(desc(roomThread.lastActivityAt), desc(roomThread.id))
      .limit(200);
    const names = await namesOf(
      this.deps.db,
      spaceId,
      rows.map((row) => row.createdBy),
    );
    return { threads: rows.map((row) => threadView(row, names)) };
  }

  private async requireThread(reader: Database | Transaction, spaceId: string, threadId: string) {
    const [row] = await reader
      .select()
      .from(roomThread)
      .where(and(eq(roomThread.id, threadId), eq(roomThread.spaceId, spaceId)));
    if (!row) throw new ServiceError('not_found', 'That thread is not here.', 404);
    return row;
  }

  /** A thread with every message and author, and each request's answer, cards and receipts. */
  async thread(spaceId: string, threadId: string, actor: string) {
    await this.access(this.deps.db, spaceId, actor);
    const row = await this.requireThread(this.deps.db, spaceId, threadId);
    // A waiting ask whose turn has come starts here too, should a hook have missed it.
    await serviceTransaction(this.deps.db, (tx) => releaseThread(tx, this.deps, threadId));
    const messages = await this.deps.db
      .select()
      .from(roomMessage)
      .where(eq(roomMessage.threadId, threadId))
      .orderBy(asc(roomMessage.createdAt), asc(roomMessage.id));
    const requests = await this.deps.db
      .select()
      .from(job)
      .where(
        and(eq(job.roomThreadId, threadId), eq(job.spaceId, spaceId), eq(job.audience, 'room')),
      )
      .orderBy(asc(job.createdAt), asc(job.id));
    const names = await namesOf(this.deps.db, spaceId, [
      row.createdBy,
      ...messages.map((message) => message.authorPrincipalId),
      ...requests.flatMap((request) =>
        request.requestedByPrincipalId ? [request.requestedByPrincipalId] : [],
      ),
    ]);
    const views = [];
    const permissions = this.deps.permissions;
    const card = permissions
      ? (approvalId: string) => permissions.roomCard(spaceId, approvalId)
      : undefined;
    for (const request of requests)
      views.push(await requestView(this.deps.db, request, names, card));
    return {
      thread: threadView(row, names),
      messages: messages.map((message) => messageView(message, names)),
      requests: views,
    };
  }

  /**
   * Post a message, in a new thread or an existing one. It asks the agent when
   * it names the agent, when it starts a thread with `ask_agent`, or when it
   * follows straight on from the agent's answer to its own author. An ask
   * reaches the asker's own request or a new one; if another request holds the
   * thread, it waits its turn. A message that does not ask starts nothing.
   */
  async post(
    spaceId: string,
    actor: string,
    input: { text: string; submission_id: string },
    target: { threadId: string } | { title?: string; askAgent?: boolean },
    /** Where the message was written, when not on the web: the platform and its id for it. */
    origin?: { surface: string; external_ref?: string },
  ) {
    // A platform's submission ids are its own: they never meet the web's, or
    // another platform's. The web's key keeps its form; a platform's is a tuple,
    // which no web key can spell.
    const key = createHash('sha256')
      .update(
        origin
          ? JSON.stringify(['surface', spaceId, actor, origin.surface, input.submission_id])
          : `${spaceId}:${actor}:${input.submission_id}`,
      )
      .digest('hex');
    const result = await this.deps.jobs.transaction(async (tx) => {
      const { role } = await this.access(tx, spaceId, actor, true);
      const [replayed] = await tx
        .select()
        .from(roomMessage)
        .where(eq(roomMessage.submissionId, key));
      if (replayed) {
        if (
          replayed.text !== input.text ||
          ('threadId' in target && replayed.threadId !== target.threadId)
        )
          throw new ServiceError(
            'submission_conflict',
            'This submission ID belongs to a different message.',
            409,
          );
        const thread = await this.requireThread(tx, spaceId, replayed.threadId);
        return { thread, message: replayed };
      }
      const persona = await roomAgentOf(tx, spaceId);
      let thread: typeof roomThread.$inferSelect;
      let first = false;
      if ('threadId' in target) {
        const [locked] = await tx
          .select()
          .from(roomThread)
          .where(and(eq(roomThread.id, target.threadId), eq(roomThread.spaceId, spaceId)))
          .for('update');
        if (!locked) throw new ServiceError('not_found', 'That thread is not here.', 404);
        if (locked.archivedAt)
          throw new ServiceError('thread_archived', 'This thread is closed.', 409);
        thread = locked;
      } else {
        const title =
          target.title?.trim() || input.text.split('\n')[0]?.trim().slice(0, 200) || 'Thread';
        const [made] = await tx
          .insert(roomThread)
          .values({ id: newId('rth'), spaceId, title, createdBy: actor })
          .returning();
        if (!made) throw new Error('Thread insert returned no row');
        thread = made;
        first = true;
      }
      // Any agent the room can use answers to its name: the room's own, and
      // the others its space keeps that have not been deleted.
      const usable = await tx
        .select({ name: agent.name })
        .from(agent)
        .where(and(eq(agent.spaceId, spaceId), isNull(agent.deletedAt)));
      const { mentions, asks: named } = mentionsOf(input.text, [
        persona.name,
        ...usable.map((row) => row.name),
      ]);
      // Asked outright: by name, by starting the thread with an ask, or by
      // following straight on from the agent's answer to this person.
      const asked =
        named ||
        (first && 'askAgent' in target && target.askAgent === true) ||
        (!first && (await this.followsAnswer(tx, thread.id, actor)));
      const asks = await this.mayAsk(tx, spaceId, actor, role, asked);
      const held = asks && (await threadHeld(tx, thread.id));
      const [inserted] = await tx
        .insert(roomMessage)
        .values({
          id: newId('rmg'),
          spaceId,
          threadId: thread.id,
          authorPrincipalId: actor,
          text: input.text,
          mentions,
          requestState: asks ? 'pending' : 'none',
          submissionId: key,
          ...(origin ? { surface: origin.surface, externalRef: origin.external_ref ?? null } : {}),
        })
        .returning();
      if (!inserted) throw new Error('Message insert returned no row');
      await tx
        .update(roomThread)
        .set({ lastActivityAt: new Date() })
        .where(eq(roomThread.id, thread.id));
      let message = await touchMessage(tx, inserted);
      if (asks && !held) {
        if (await startRequest(tx, this.deps, message)) {
          const [current] = await tx
            .select()
            .from(roomMessage)
            .where(eq(roomMessage.id, message.id));
          if (current) message = current;
        } else {
          // An ask that cannot start stops asking, as a released one does, so
          // the thread never waits behind it.
          const [dropped] = await tx
            .update(roomMessage)
            .set({ requestState: 'none' })
            .where(eq(roomMessage.id, message.id))
            .returning();
          if (dropped) message = await touchMessage(tx, dropped);
        }
      }
      return { thread, message };
    });
    const names = await namesOf(this.deps.db, spaceId, [
      result.thread.createdBy,
      result.message.authorPrincipalId,
    ]);
    return {
      thread: threadView(result.thread, names),
      message: messageView(result.message, names),
      request_job_id: result.message.requestJobId,
    };
  }

  /**
   * Whether a message asks the agent, under the room's settings. In a room set
   * to answer every message, every message asks. A guest asks only where the
   * room lets guests ask, and an ask past the room's hourly limit, or the
   * person's, is refused when it was asked outright and is plain conversation
   * otherwise.
   */
  private async mayAsk(
    tx: Transaction,
    spaceId: string,
    actor: string,
    role: RoomRole,
    asked: boolean,
  ): Promise<boolean> {
    const policy = await readRoomPolicy(tx, spaceId);
    if (!asked && policy.agent_turns !== 'every_message') return false;
    if (role === 'guest' && !policy.guests_may_ask) {
      if (asked)
        throw new ServiceError('guests_may_not_ask', "Guests cannot ask this room's agent.", 403);
      return false;
    }
    const limit = await askLimitReached(tx, spaceId, actor, policy);
    if (!limit) return true;
    if (!asked) return false;
    throw new ServiceError(
      'rate_limited',
      limit === 'room'
        ? `This room has asked its agent ${policy.requests_per_hour} times in the last hour. Try again later.`
        : `You have asked this room's agent ${policy.requests_per_person_hour} times in the last hour. Try again later.`,
      429,
    );
  }

  /**
   * Whether a message follows straight on from the agent's answer to its
   * author: the thread's last message is the author's own ask, and that
   * request has answered.
   */
  private async followsAnswer(tx: Transaction, threadId: string, actor: string) {
    const [last] = await tx
      .select()
      .from(roomMessage)
      .where(eq(roomMessage.threadId, threadId))
      .orderBy(desc(roomMessage.createdAt), desc(roomMessage.id))
      .limit(1);
    if (!last || last.authorPrincipalId !== actor || !last.requestJobId) return false;
    const [request] = await tx.select().from(job).where(eq(job.id, last.requestJobId));
    return Boolean(request && !['queued', 'running'].includes(request.state));
  }

  /**
   * The computers one of the room's requests is using. Everyone in the room may
   * watch them; the sessions this returns are taken over only by the room's
   * owners, which the computer itself checks again.
   */
  async computers(spaceId: string, jobId: string, actor: string) {
    await this.access(this.deps.db, spaceId, actor);
    const [row] = await this.deps.db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.id, jobId), eq(job.spaceId, spaceId), eq(job.audience, 'room')));
    if (!row) throw new ServiceError('not_found', 'That request is not here.', 404);
    if (!this.deps.computers) return { computers: [] };
    const computers = await this.deps.computers.list(jobId, actor).catch((error: unknown) => {
      if (error instanceof ComputerFault) throw missing();
      throw error;
    });
    return { computers };
  }

  /** Stop a request's turn in flight: the person who asked it, or a room owner. */
  async stop(spaceId: string, jobId: string, actor: string) {
    const access = await this.access(this.deps.db, spaceId, actor);
    const [row] = await this.deps.db
      .select()
      .from(job)
      .where(and(eq(job.id, jobId), eq(job.spaceId, spaceId), eq(job.audience, 'room')));
    if (!row) throw new ServiceError('not_found', 'That request is not here.', 404);
    if (row.requestedByPrincipalId !== actor && access.role !== 'owner')
      throw new ServiceError(
        'scope_denied',
        'Only the person who asked, or an owner of this room, can stop it.',
        403,
      );
    if (!this.deps.runner) return unavailable('Stopping is not connected to the agent yet.');
    if (row.currentTurnId) await this.deps.runner.stopConversation(jobId);
    const [after] = await this.deps.db.select().from(job).where(eq(job.id, jobId));
    const names = await namesOf(
      this.deps.db,
      spaceId,
      row.requestedByPrincipalId ? [row.requestedByPrincipalId] : [],
    );
    const permissions = this.deps.permissions;
    return {
      request: await requestView(
        this.deps.db,
        after ?? row,
        names,
        permissions ? (approvalId) => permissions.roomCard(spaceId, approvalId) : undefined,
      ),
    };
  }

  /** How the room works. Everyone in it may read this. */
  async policy(spaceId: string, actor: string) {
    await this.access(this.deps.db, spaceId, actor);
    return { policy: await readRoomPolicy(this.deps.db, spaceId) };
  }

  /**
   * Change how the room works. Owners only. A new approver rule applies to
   * every permission answered from now on, the ones already waiting included:
   * who may answer is checked when the answer is given. Turning guests' asks
   * off ends the requests guests already made, as removing a guest would.
   */
  async setPolicy(spaceId: string, actor: string, patch: Partial<RoomPolicy>) {
    const jobs = this.deps.jobs;
    const result = await jobs.transaction(async (tx) => {
      const access = await this.access(tx, spaceId, actor, true);
      if (access.role !== 'owner') throw roomOwnerOnly();
      const before = await readRoomPolicy(tx, spaceId);
      const policy = await writeRoomPolicy(tx, spaceId, actor, patch);
      const cancelled =
        before.guests_may_ask && !policy.guests_may_ask
          ? await this.endGuestRequests(tx, spaceId)
          : [];
      return { policy, cancelled };
    });
    for (const id of result.cancelled) jobs.onCancelled?.(id);
    return { policy: result.policy };
  }

  /**
   * End every request a guest asked of the room that is still under way, once
   * guests may no longer ask. Work in flight is fenced as a change to the
   * room's connections fences it, the permissions it waits on are withdrawn,
   * and the thread says why the request stopped.
   */
  private async endGuestRequests(tx: Transaction, spaceId: string): Promise<string[]> {
    const asked = (
      await tx
        .select({ id: job.id, state: job.state })
        .from(job)
        .innerJoin(principal, eq(principal.id, job.requestedByPrincipalId))
        .where(and(eq(job.spaceId, spaceId), eq(job.audience, 'room'), eq(principal.kind, 'guest')))
        .orderBy(job.id)
    ).filter((row) => !isTerminal(row.state as JobState));
    if (!asked.length) return [];
    const [parent] = await tx
      .update(space)
      .set({ policyGeneration: sql`${space.policyGeneration} + 1` })
      .where(eq(space.id, spaceId))
      .returning();
    if (!parent) throw missing();
    const ids = asked.map((row) => row.id);
    await new PolicyService(this.deps.jobs).invalidateInTransaction(
      tx,
      spaceId,
      parent.policyGeneration,
      null,
      'policy_changed',
      ids,
    );
    const room = await roomPrincipalOf(tx, spaceId);
    const cancelled: string[] = [];
    for (const id of ids) {
      const row = await this.deps.jobs.lock(tx, id);
      if (!row || isTerminal(row.state as JobState)) continue;
      await this.deps.jobs.cancelInTransaction(tx, row, 'guests_may_not_ask', { end: true });
      cancelled.push(id);
      if (row.roomThreadId)
        await postToThread(tx, {
          spaceId,
          threadId: row.roomThreadId,
          author: room.id,
          kind: 'system',
          viaAgent: false,
          text: 'Guests can no longer ask the agent in this room, so this request has stopped.',
          key: `guests-off:${id}`,
        });
    }
    return cancelled;
  }

  /**
   * Answer one of the room's permissions. Only the people the room's rule
   * names may, and the answer is bound to the exact content and the card it
   * was given against.
   */
  async decide(
    spaceId: string,
    approvalId: string,
    actor: string,
    input: { option: 'allow_once' | 'deny'; version: string; payload_hash: string },
  ) {
    await this.access(this.deps.db, spaceId, actor);
    const permissions = this.deps.permissions;
    if (!permissions) return unavailable('Answering is not connected to the agent yet.');
    const wanted = input.option === 'deny' ? 'denied' : 'approved';
    // A card someone has already answered says who answered it and how, to a
    // second answer the same or the opposite: one person's answer stands.
    const answered = async () => {
      const [row] = await this.deps.db
        .select({ decision: approval.decision, decidedBy: approval.decidedBy })
        .from(approval)
        .where(eq(approval.id, approvalId));
      if (!row?.decision || !row.decidedBy) return null;
      if (row.decidedBy === actor && row.decision === wanted) return null;
      const names = await namesOf(this.deps.db, spaceId, [row.decidedBy]);
      const who = names.get(row.decidedBy);
      // Withdrawn by the service rather than answered by a person.
      if (!who) return null;
      const how = row.decision === 'approved' ? 'allowed' : 'denied';
      return new ServiceError(
        'already_answered',
        row.decidedBy === actor ? `You already ${how} this.` : `${who} already ${how} this.`,
        409,
      );
    };
    const before = await answered();
    if (before) throw before;
    try {
      await permissions.decideInRoom(spaceId, approvalId, input, actor);
    } catch (error) {
      // Two answers at once: the one recorded first stands.
      const raced = await answered();
      if (raced) throw raced;
      throw error;
    }
    const [recorded] = await this.deps.db
      .select({ decidedBy: approval.decidedBy })
      .from(approval)
      .where(eq(approval.id, approvalId));
    if (recorded?.decidedBy !== actor) {
      const raced = await answered();
      if (raced) throw raced;
      // An answer to a card that changed meanwhile withdraws it rather than
      // answering it; that is said, not reported as this person's answer.
      throw new ServiceError(
        'permission_withdrawn',
        'This request changed before you answered, so it was withdrawn.',
        409,
      );
    }
    const names = await namesOf(this.deps.db, spaceId, [actor]);
    return {
      status: 'ok' as const,
      option: input.option,
      decided_by: { principal_id: actor, display_name: names.get(actor) ?? 'Someone' },
    };
  }

  /** The connections in the room's space, and which of them serve the room's requests. */
  async connections(spaceId: string, actor: string) {
    const { role } = await this.access(this.deps.db, spaceId, actor);
    // Owners see every connection in the room's space; everyone else sees only
    // those that serve the room. One kept for the owner (a mailbox, say) stays theirs.
    const rows = await this.deps.db
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.spaceId, spaceId),
          ne(connection.status, 'revoked'),
          role === 'owner' ? undefined : eq(connection.sharedUse, 'room'),
        ),
      )
      .orderBy(asc(connection.createdAt), asc(connection.id));
    return { connections: rows.map(connectionView) };
  }

  /**
   * Let a connection serve the room's requests, or keep it to the owner's own
   * work. Owners only. Who a connection serves changes what work may act
   * through it, so work under way in the room is fenced and starts again, and
   * permissions waiting on it are withdrawn.
   */
  async setConnection(
    spaceId: string,
    actor: string,
    connectionId: string,
    sharedUse: 'owner' | 'room',
  ) {
    const jobs = this.deps.jobs;
    const result = await jobs.transaction(async (tx) => {
      const access = await this.access(tx, spaceId, actor, true);
      if (access.role !== 'owner') throw roomOwnerOnly();
      const [source] = await tx
        .select()
        .from(connection)
        .where(and(eq(connection.id, connectionId), eq(connection.spaceId, spaceId)))
        .for('update');
      if (!source || source.status === 'revoked')
        throw new ServiceError('not_found', 'That connection is not in this room.', 404);
      if (source.sharedUse === sharedUse) return { row: source, controls: [] };
      const [parent] = await tx
        .update(space)
        .set({ policyGeneration: sql`${space.policyGeneration} + 1` })
        .where(eq(space.id, spaceId))
        .returning();
      if (!parent) throw missing();
      const [row] = await tx
        .update(connection)
        .set({ sharedUse, generation: source.generation + 1 })
        .where(eq(connection.id, connectionId))
        .returning();
      if (!row) throw new Error('Locked connection disappeared');
      const controls = await new PolicyService(jobs).invalidateInTransaction(
        tx,
        spaceId,
        parent.policyGeneration,
        connectionId,
        'policy_changed',
      );
      return { row, controls };
    });
    for (const control of result.controls) jobs.onCancelled?.(control.job_id);
    return { connection: connectionView(result.row) };
  }

  async presence(spaceId: string, actor: string) {
    await this.access(this.deps.db, spaceId, actor);
    await this.deps.db
      .insert(roomPresence)
      .values({ spaceId, principalId: actor })
      .onConflictDoUpdate({
        target: [roomPresence.spaceId, roomPresence.principalId],
        set: { lastSeenAt: new Date() },
      });
    return { present: await presentIn(this.deps.db, spaceId) };
  }

  /**
   * One page of a thread's live frames after `after`: messages as they are now,
   * and the conversation events of the thread's requests, in commit order. The
   * requests are projected as the room's principal, the identity they belong
   * to, after the viewer's own membership has been checked.
   */
  async frames(
    spaceId: string,
    threadId: string,
    actor: string,
    after: number,
    limit = 100,
  ): Promise<RoomStreamFrame[]> {
    const access = await this.access(this.deps.db, spaceId, actor);
    await this.requireThread(this.deps.db, spaceId, threadId);
    const requests = await this.deps.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(eq(job.roomThreadId, threadId), eq(job.spaceId, spaceId), eq(job.audience, 'room')),
      );
    const ids = requests.map((request) => request.id);
    const events = this.deps.events;
    if (events)
      for (const id of ids)
        await principalContext.run(access.roomPrincipal, () =>
          events.sync(spaceId, id, access.roomPrincipal),
        );
    const messages = await this.deps.db
      .select()
      .from(roomMessage)
      .where(and(eq(roomMessage.threadId, threadId), gt(roomMessage.streamSeq, after)))
      .orderBy(asc(roomMessage.streamSeq))
      .limit(limit);
    const projected = ids.length
      ? await this.deps.db
          .select()
          .from(event)
          .where(
            and(
              inArray(event.jobId, ids),
              gt(event.seq, after),
              sql`${event.payload}->>'kind' = 'experience'`,
            ),
          )
          .orderBy(asc(event.seq))
          .limit(limit)
      : [];
    const names = await namesOf(
      this.deps.db,
      spaceId,
      messages.map((message) => message.authorPrincipalId),
    );
    const frames: RoomStreamFrame[] = [
      ...messages.map((message) =>
        roomStreamFrame.parse({
          seq: message.streamSeq,
          kind: 'message',
          message: messageView(message, names),
        }),
      ),
      ...projected.map((row) => {
        const payload = row.payload as Record<string, unknown>;
        return roomStreamFrame.parse({
          seq: row.seq,
          kind: 'request',
          request_job_id: row.jobId,
          event: {
            seq: row.seq,
            conversation_id: row.jobId,
            turn_id: payload.turn_id ?? null,
            created_at: payload.at ?? row.createdAt.toISOString(),
            item: payload.item,
          },
        });
      }),
    ].sort((a, b) => a.seq - b.seq);
    // Two sources each cut at `limit`: only the frames below both cuts are complete.
    const cut = Math.min(
      messages.length === limit
        ? (messages.at(-1)?.streamSeq ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
      projected.length === limit
        ? (projected.at(-1)?.seq ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
    );
    return frames.filter((frame) => frame.seq <= cut);
  }

  /** Whether the person may still read the room, for a stream's per-frame check. */
  async stillIn(spaceId: string, actor: string): Promise<boolean> {
    return this.access(this.deps.db, spaceId, actor).then(
      () => true,
      (error: unknown) => {
        if (error instanceof ServiceError) return false;
        throw error;
      },
    );
  }
}
