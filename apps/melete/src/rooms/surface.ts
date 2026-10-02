/**
 * Where a room meets the places people talk: the web first, and later a chat
 * platform. Every surface goes through the same three doors, and through
 * nothing else:
 *
 * - `postRoomMessage`: a person's message comes in;
 * - `RoomSurface.deliver`: the room's messages, answers, cards and decisions go out;
 * - `decideRoomApproval`: a person answers one of the room's permissions.
 *
 * Behind each door the room checks what it checks for the web: the person is
 * in the room now, a guest keeps a guest's limits, and only the people the
 * room's rule names may answer a permission. A surface never says who someone
 * is by name. The web's session has already proved the person; a platform's
 * account counts only through a link to a person here (`principal_identity`),
 * and an account with no link is refused, never taken for a guest.
 */
import type { RoomStreamFrame } from '@melete/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { principal } from '../db/schema.ts';
import type { EventChanges } from '../experience/events.ts';
import { principalIdentity, roomMessage } from './schema.ts';
import type { RoomService } from './service.ts';

/** How long a thread's follower waits for new frames when nothing says one was committed. */
export const ROOM_POLL_MS = 1000;

/** The web: its people are signed in, so its speakers are people's own ids. */
export const WEB_SURFACE = 'web';

/** How a platform names itself: the `provider` of its links. */
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
/** The account kinds a link may point to. A room's own principal speaks for nobody. */
const LINKABLE = ['person', 'guest'];

/** One frame of a thread, on its way out to one person on one surface. */
export type RoomOutbound = {
  room_id: string;
  thread_id: string;
  /** Who it goes to, as the surface knows them: the platform's account id, or a person's id on the web. */
  to: string;
  /** A message with its author's room label, or one event of a request: answer, card, receipt or decision. */
  frame: RoomStreamFrame;
  /** For a message: the surface it was written on, and that surface's id for it. */
  origin: { surface: string; external_ref: string | null } | null;
};

/** A chat platform a room can be talked to from. */
export interface RoomSurface {
  /** The platform's name, the `provider` of its accounts' links. Never `web`. */
  readonly provider: string;
  /** Called once, when rooms start: the only way in this surface has. */
  attach(gate: RoomGate): void;
  /** Send one frame to one person on the platform. */
  deliver(outbound: RoomOutbound): Promise<void>;
}

export type RoomSurfaceDeps = { db: Database; rooms: RoomService; changes?: EventChanges };

const unlinked = () =>
  new ServiceError(
    'unlinked_account',
    'This account is not linked to anyone here. Link it from Melete first.',
    403,
  );

/**
 * The doors of one surface, bound to it: a platform's gate resolves only its
 * own platform's accounts, and the web's only signed-in people.
 */
export class RoomGate {
  private constructor(
    private readonly deps: RoomSurfaceDeps,
    /** `web`, or the platform's provider name. */
    readonly surface: string,
    private readonly platform?: RoomSurface,
  ) {}

  static web(deps: RoomSurfaceDeps) {
    return new RoomGate(deps, WEB_SURFACE);
  }

  static platform(deps: RoomSurfaceDeps, surface: RoomSurface) {
    if (!PROVIDER.test(surface.provider) || surface.provider === WEB_SURFACE)
      throw new Error(`A chat platform cannot be named "${surface.provider}"`);
    return new RoomGate(deps, surface.provider, surface);
  }

  /**
   * The person behind a speaker. On the web the speaker is the signed-in
   * person. On a platform it is the platform's account id, which counts only
   * through its link, checked now: an account with no link, or one linked to
   * anything but a person or a guest, is refused.
   */
  async principalOf(speaker: string): Promise<string> {
    if (!this.platform) return speaker;
    const [row] = await this.deps.db
      .select({ id: principal.id, kind: principal.kind })
      .from(principalIdentity)
      .innerJoin(principal, eq(principal.id, principalIdentity.principalId))
      .where(
        and(
          eq(principalIdentity.provider, this.surface),
          eq(principalIdentity.externalId, speaker),
        ),
      );
    if (!row || !LINKABLE.includes(row.kind)) throw unlinked();
    return row.id;
  }

  /**
   * Link a platform account to a person. Call it only once the platform has
   * proved who holds the account and the person, signed in here, has said it
   * is theirs. A link is never moved: an account linked to someone else stays
   * theirs until it is unlinked.
   */
  async link(externalId: string, principalId: string) {
    if (!this.platform) throw new Error('The web has no accounts to link');
    if (externalId.length < 1 || externalId.length > 200)
      throw new ServiceError(
        'invalid_account',
        'That account id is not one a platform gives.',
        400,
      );
    const [person] = await this.deps.db
      .select({ kind: principal.kind })
      .from(principal)
      .where(eq(principal.id, principalId));
    if (!person || !LINKABLE.includes(person.kind))
      throw new ServiceError('not_found', 'Account not found.', 404);
    await this.deps.db
      .insert(principalIdentity)
      .values({ provider: this.surface, externalId, principalId })
      .onConflictDoNothing();
    const [held] = await this.deps.db
      .select({ principalId: principalIdentity.principalId })
      .from(principalIdentity)
      .where(
        and(
          eq(principalIdentity.provider, this.surface),
          eq(principalIdentity.externalId, externalId),
        ),
      );
    if (held?.principalId !== principalId)
      throw new ServiceError('already_linked', 'That account is linked to someone else here.', 409);
    return { provider: this.surface, external_id: externalId, principal_id: principalId };
  }

  /** Unlink a platform account. From then on it can neither speak, answer nor hear. */
  async unlink(externalId: string) {
    if (!this.platform) throw new Error('The web has no accounts to link');
    const removed = await this.deps.db
      .delete(principalIdentity)
      .where(
        and(
          eq(principalIdentity.provider, this.surface),
          eq(principalIdentity.externalId, externalId),
        ),
      )
      .returning();
    return { removed: removed.length > 0 };
  }

  /**
   * A person's message comes into a room: in a thread, or starting one. It
   * is posted as the person the speaker resolves to, labelled the way the
   * room labels them, and asks the agent only where the web's would.
   */
  async postRoomMessage(input: {
    room: string;
    author: string;
    text: string;
    submission_id: string;
    thread?: string;
    title?: string;
    ask_agent?: boolean;
    /** The platform's own id for the message. */
    external_ref?: string;
  }) {
    const actor = await this.principalOf(input.author);
    return this.deps.rooms.post(
      input.room,
      actor,
      { text: input.text, submission_id: input.submission_id },
      input.thread !== undefined
        ? { threadId: input.thread }
        : { title: input.title, askAgent: input.ask_agent },
      this.platform ? { surface: this.surface, external_ref: input.external_ref } : undefined,
    );
  }

  /**
   * A person answers one of the room's permissions, bound to the card's
   * version and the exact content. Who may answer is the room's rule, checked
   * against the person the speaker resolves to.
   */
  async decideRoomApproval(input: {
    room: string;
    approval: string;
    principal: string;
    option: 'allow_once' | 'deny';
    version: string;
    payload_hash: string;
  }) {
    const actor = await this.principalOf(input.principal);
    return this.deps.rooms.decide(input.room, input.approval, actor, {
      option: input.option,
      version: input.version,
      payload_hash: input.payload_hash,
    });
  }

  /**
   * Follow a thread for one person: every frame after `after`, in commit
   * order, delivered while they may still read the room. Before each frame it
   * checks the person is still in the room and, on a platform, that their
   * account is still linked to them; the moment either fails it stops, and
   * nothing more goes out. It also stops when `signal` aborts.
   *
   * The first page is read before anything is delivered, so a person who may
   * not read the thread is refused here, as an error, rather than sent nothing.
   */
  async follow(input: {
    room: string;
    thread: string;
    viewer: string;
    after: number;
    signal: AbortSignal;
    /** Frames already read for this person, from `after` on. */
    first?: RoomStreamFrame[];
    /** Where frames go; a platform's own `deliver` by default. */
    deliver?: (outbound: RoomOutbound) => Promise<void>;
    /** Called when nothing has gone out for a while, so a connection can be kept open. */
    idle?: () => Promise<void>;
  }): Promise<'stopped' | 'left'> {
    const { room, thread, viewer, signal } = input;
    const platform = this.platform;
    const deliver =
      input.deliver ?? (platform ? (outbound: RoomOutbound) => platform.deliver(outbound) : null);
    if (!deliver) throw new Error('A web follower says where its frames go');
    const person = await this.principalOf(viewer);
    const rooms = this.deps.rooms;
    // Still this person's account, and still in the room.
    const stillIn = async () => {
      const now = await this.principalOf(viewer).catch((error: unknown) => {
        if (error instanceof ServiceError) return null;
        throw error;
      });
      return now === person && (await rooms.stillIn(room, person));
    };
    let cursor = input.after;
    let buffered = input.first ?? (await rooms.frames(room, thread, person, cursor));
    let changed = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = this.deps.changes?.subscribe(() => {
      changed = true;
      wake?.();
    });
    const stop = () => wake?.();
    signal.addEventListener('abort', stop, { once: true });
    let lastWrite = Date.now();
    try {
      while (!signal.aborted) {
        const origins = await this.originsOf(buffered);
        for (const frame of buffered) {
          if (signal.aborted) return 'stopped';
          if (!(await stillIn())) return 'left';
          await deliver({
            room_id: room,
            thread_id: thread,
            to: viewer,
            frame,
            origin: frame.kind === 'message' ? (origins.get(frame.message.id) ?? null) : null,
          });
          cursor = frame.seq;
          lastWrite = Date.now();
        }
        if (!changed)
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, ROOM_POLL_MS);
          });
        wake = undefined;
        if (timer) clearTimeout(timer);
        if (signal.aborted) return 'stopped';
        changed = false;
        if (!(await stillIn())) return 'left';
        const next = await rooms.frames(room, thread, person, cursor).catch(() => null);
        if (!next) return 'left';
        buffered = next;
        if (!buffered.length && Date.now() - lastWrite >= ROOM_POLL_MS && input.idle) {
          await input.idle();
          lastWrite = Date.now();
        }
      }
      return 'stopped';
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      signal.removeEventListener('abort', stop);
    }
  }

  /** Where each message among these frames was written. */
  private async originsOf(frames: RoomStreamFrame[]) {
    const ids = frames.flatMap((frame) => (frame.kind === 'message' ? [frame.message.id] : []));
    const origins = new Map<string, { surface: string; external_ref: string | null }>();
    if (!ids.length) return origins;
    const rows = await this.deps.db
      .select({
        id: roomMessage.id,
        surface: roomMessage.surface,
        externalRef: roomMessage.externalRef,
      })
      .from(roomMessage)
      .where(inArray(roomMessage.id, ids));
    for (const row of rows)
      origins.set(row.id, { surface: row.surface, external_ref: row.externalRef });
    return origins;
  }
}
