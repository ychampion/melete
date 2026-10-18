/**
 * Deleting an account.
 *
 * A person deletes their own account; the person who set Melete up can
 * delete one they made for someone else. Either way it happens in this order:
 *
 * 1. At once, in one transaction, the account can no longer be used: its
 *    email, name, password and passkey are wiped, and its sign-in sessions,
 *    linked sign-ins, reset links, assistant grants, push subscriptions and
 *    pending notification texts are deleted, and its paired computers are
 *    disconnected. The email is free again. The responses it sent to apps in
 *    other people's spaces stay with those apps, naming nobody; apps shared
 *    with it are no longer shared with it; and it is no longer shown as
 *    having any room open.
 * 2. It leaves the rooms other people own, as leaving one does: its place
 *    there ends and the work it started there stops. Its own chats there,
 *    which only it could read, are deleted as deleting each would delete it;
 *    what it said to the room stays with the room.
 * 3. Every space it owns is removed by the space removal: its own space and
 *    the rooms it made, with everything in them. The same phased sweep and
 *    final count that removing one space runs, so a space is reported gone
 *    only once a recount finds nothing left.
 * 4. Once none of its spaces is left, the account's remaining records go,
 *    and its row with them. Where something in a room someone else owns
 *    still names it (a message or thread it wrote there, a chat it held with
 *    the room, something the room handed it, an invite it made or used, an
 *    app it published or shared there), the row stays,
 *    with nothing in it but its id, so that room's history still reads; the
 *    room calls it "Someone".
 *
 * Steps 2 to 4 run again at startup and every minute until they are done, so
 * a deletion interrupted by a restart finishes. What marks an account as being
 * deleted is its wiped email, which names its own id.
 *
 * The account that set Melete up cannot be deleted: it runs the installation,
 * and only it can manage the others. It can erase everything it holds
 * instead, which empties its own space, or remove Melete from its computer.
 */
import type { AccountRemovalPreview, AccountSummary } from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { endAccess } from '../api/account-access.ts';
import { ServiceError } from '../api/errors.ts';
import { ItemFailures } from '../ops/item-failures.ts';
import { principalContext } from '../principals/authority.ts';
import type { PrincipalService } from '../principals/service.ts';
import type { SpaceRemovalService } from '../spaces/removal.ts';
import { iso, ownedSpaces } from './export.ts';

/** The email a deleted account is left with: its own id, at a domain nothing can receive mail for. */
export const removedEmail = (principalId: string) =>
  `removed+${principalId.toLowerCase()}@removed.invalid`;

/** Whether an account's address is the one its deletion left it with: it is no account to sign in to. */
export const isRemovedEmail = (principalId: string, email: string) =>
  email === removedEmail(principalId);

export const SETUP_OWNER_KEPT =
  'The account that set Melete up can’t be deleted: it runs this Melete and manages the other accounts. You can erase everything in your space instead, or remove Melete from the computer it runs on.';

/** Records kept for an account rather than a space, which go with it. */
const ACCOUNT_RECORDS = [
  'session',
  'principal_identity',
  'oidc_identity',
  'password_reset',
  'mcp_authorization',
  'mcp_token',
  'push_subscription',
  'push_intent',
  'magic_link',
];

/** What is left of an account once its spaces are gone, should its row have to stay. */
const LEFTOVER_RECORDS = [
  ...ACCOUNT_RECORDS,
  'push_setting',
  'client_focus',
  'memory_settings',
  'model_secondary',
  'engine_skill_prohibition',
  'reach_consent',
  'reach_contact',
  'reach_number',
  'clock',
  'situation',
  'intent',
  'triage_verdict',
  'triage_item',
  'awaited_reply',
  'company_scan',
  'company_message',
  'company',
  'ledger_item',
  'voice_usage',
  'call_usage',
  'managed_call',
];

export type AccountRemovalDeps = {
  sql: Sql;
  spaces: SpaceRemovalService;
  principals: PrincipalService;
  /** The space a running browser worker mounts, which cannot be removed under it. */
  browserSpace?: string;
  /** Deletes chats and their files as deleting a chat does. */
  removeChats?: (jobIds: readonly string[]) => Promise<unknown>;
  log?: (line: string) => void;
};

type Account = {
  id: string;
  email: string;
  display_name: string | null;
  kind: string;
  created_at: string;
  /** Granted by the setup owner, and still able to sign in. */
  admin: boolean;
};

export class AccountRemovalService {
  private timer?: ReturnType<typeof setInterval>;
  private passing?: Promise<unknown>;
  private readonly log: (line: string) => void;
  /** Accounts whose deletion pass failed, each tried again later on its own. */
  private readonly failures: ItemFailures;
  /**
   * Deleted accounts whose row had to stay, empty, because a room someone
   * else owns still names it, once every other step went through. There is
   * nothing more to do for them, so they are not tried again until the
   * service restarts.
   */
  private readonly settled = new Set<string>();

  constructor(readonly deps: AccountRemovalDeps) {
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.failures = new ItemFailures('account deletion', {
      firstMs: 60_000,
      maxMs: 60 * 60_000,
      say: this.log,
    });
  }

  private async setupOwner(): Promise<string | null> {
    const [row] = await this.deps.sql<{ id: string }[]>`select id from owner limit 1`;
    return row?.id ?? null;
  }

  private async account(principalId: string): Promise<Account | undefined> {
    const [row] = await this.deps.sql<Account[]>`select id, email, display_name, kind, created_at,
        admin and disabled_at is null as admin
      from principal where id = ${principalId}`;
    return row;
  }

  /**
   * Who may delete this account: the account itself, or the person who set
   * Melete up. Anyone else is told it does not exist.
   */
  private async authorize(actor: string, principalId: string): Promise<Account> {
    const setupOwner = await this.setupOwner();
    const account = await this.account(principalId);
    if (!account || account.kind === 'room' || (actor !== principalId && actor !== setupOwner))
      throw new ServiceError('not_found', 'No such account.', 404);
    if (principalId === setupOwner) throw new ServiceError('setup_owner', SETUP_OWNER_KEPT, 409);
    return account;
  }

  /** What deleting this account takes with it, before anything is deleted. */
  async preview(actor: string, principalId: string): Promise<AccountRemovalPreview> {
    const setupOwner = await this.setupOwner();
    const account = await this.account(principalId);
    if (!account || account.kind === 'room' || (actor !== principalId && actor !== setupOwner))
      throw new ServiceError('not_found', 'No such account.', 404);
    const spaces = await ownedSpaces(this.deps.sql, principalId);
    const counts = new Map<string, { chats: number; files: number; connections: number }>();
    for (const space of spaces) {
      const [row] = await this.deps.sql<{ chats: number; files: number; connections: number }[]>`
        select (select count(*)::int from job where space_id = ${space.id} and kind = 'chat') as chats,
          (select count(*)::int from artifact where space_id = ${space.id}) as files,
          (select count(*)::int from connection where space_id = ${space.id}
            and status <> 'revoked' and configuration->>'builtin' is null) as connections`;
      counts.set(space.id, row ?? { chats: 0, files: 0, connections: 0 });
    }
    const rooms = await this.deps.sql<{ id: string; name: string }[]>`
      select s.id, s.name from space s join space_membership m on m.space_id = s.id
      where m.principal_id = ${principalId} and m.revoked_at is null and m.role <> 'agent'
        and s.owner_principal_id is distinct from ${principalId}
        and s.kind = 'shared' and s.removed_at is null order by s.name`;
    const blocked =
      principalId === setupOwner
        ? SETUP_OWNER_KEPT
        : this.deps.browserSpace && spaces.some((space) => space.id === this.deps.browserSpace)
          ? 'The browser worker uses one of this account’s spaces. Point it at another space and restart it first.'
          : null;
    return {
      account: summary(account, setupOwner),
      spaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        kind: space.kind === 'personal' ? 'personal' : 'room',
        chats: counts.get(space.id)?.chats ?? 0,
        files: counts.get(space.id)?.files ?? 0,
        connections: counts.get(space.id)?.connections ?? 0,
      })),
      rooms_left: rooms.map((room) => ({ id: room.id, name: room.name })),
      confirm: account.email,
      blocked_reason: blocked,
    };
  }

  /**
   * Delete an account. The person types its email to confirm. Answers once it
   * can no longer be used and the removal of its spaces has started.
   */
  async remove(actor: string, principalId: string, confirmEmail: string) {
    const account = await this.authorize(actor, principalId);
    if (confirmEmail.trim().toLowerCase() !== account.email.toLowerCase())
      throw new ServiceError(
        'confirmation_mismatch',
        'That is not this account’s email. Type it exactly as it is shown.',
        400,
      );
    const spaces = await ownedSpaces(this.deps.sql, principalId);
    if (this.deps.browserSpace && spaces.some((space) => space.id === this.deps.browserSpace))
      throw new ServiceError(
        'space_in_use',
        'The browser worker uses one of this account’s spaces. Point it at another space and restart it first.',
        409,
      );
    await this.deps.sql.begin(async (tx) => {
      const [locked] = await tx`select id from principal where id = ${principalId} for update`;
      if (!locked) throw new ServiceError('not_found', 'No such account.', 404);
      await tx`update principal set email = ${removedEmail(principalId)}, password_hash = null,
        passkey = null, display_name = null, disabled_at = coalesce(disabled_at, now())
        where id = ${principalId}`;
      // Every way in ends now, as signing out everywhere ends it: its paired
      // computers and unused pairing codes too, without waiting for the sweep
      // of its spaces to reach them.
      const devices = await endAccess(tx, principalId, null);
      if (devices.length)
        await tx`update connection set status = 'revoked', generation = generation + 1
          where id in (select connection_id from paired_device where id = any(${devices}))
            and status <> 'revoked'`;
      for (const table of ACCOUNT_RECORDS)
        await tx`delete from ${tx(table)} where principal_id = ${principalId}`;
      await unlinkElsewhere(tx, principalId);
    });
    await this.carryOn(principalId);
    return this.status(principalId);
  }

  /** Where a deletion has got to: its spaces' removals, and whether the account row is gone. */
  async status(principalId: string) {
    const removals = await this.deps.sql<
      { id: string; space_id: string; space_name: string; state: string }[]
    >`select distinct on (space_id) id, space_id, space_name, state from space_removal
      where requested_by = ${principalId} order by space_id, started_at desc`;
    const [row] = await this.deps.sql`select 1 from principal
      where id = ${principalId} and email <> ${removedEmail(principalId)}`;
    if (row) throw new ServiceError('not_found', 'This account is not being deleted.', 404);
    const left = await ownedSpaces(this.deps.sql, principalId);
    return {
      principal_id: principalId,
      state:
        removals.every((removal) => removal.state === 'complete') && left.length === 0
          ? ('removed' as const)
          : ('removing' as const),
      spaces: removals.map((removal) => ({
        space_id: removal.space_id,
        name: removal.space_name,
        removal_id: removal.id,
        state: removal.state,
      })),
    };
  }

  /**
   * Steps 2 and 3: leave other people's rooms and start removing each space
   * it owns that is not being removed yet. Safe to run again at any point.
   * Answers whether every step went through.
   */
  private async carryOn(principalId: string): Promise<boolean> {
    const { sql, spaces, principals } = this.deps;
    let done = true;
    const missed = (line: string) => {
      done = false;
      this.log(line);
    };
    await principalContext.run(principalId, async () => {
      const rooms = await sql<{ space_id: string }[]>`select m.space_id from space_membership m
        join space s on s.id = m.space_id
        where m.principal_id = ${principalId} and m.revoked_at is null and m.role <> 'agent'
          and s.owner_principal_id is distinct from ${principalId}
          and s.kind = 'shared' and s.removed_at is null`;
      for (const room of rooms)
        await principals
          .revoke(principalId, room.space_id, principalId)
          .catch((error) =>
            missed(
              `account deletion: leaving ${room.space_id} did not finish yet (${describe(error)})`,
            ),
          );
      for (const space of await ownedSpaces(sql, principalId)) {
        const row = await spaces
          .fence(principalId, space.id, space.name, { forAccountDeletion: true })
          .catch((error) => {
            missed(`account deletion: removing ${space.id} did not start yet (${describe(error)})`);
            return null;
          });
        if (row) spaces.dispatch(row.id);
      }
    });
    // Its own chats in rooms someone else owns: nobody else could read them,
    // so nothing of the room's is lost with them. Rooms it owns go whole above.
    const removeChats = this.deps.removeChats;
    if (!removeChats) return done;
    const own = await sql<{ id: string }[]>`select j.id from job j join space s on s.id = j.space_id
      where j.principal_id = ${principalId} and j.audience = 'principal'
        and s.kind = 'shared' and s.removed_at is null
        and s.owner_principal_id is distinct from ${principalId}
      order by j.id`;
    if (own.length)
      await removeChats(own.map((row) => row.id)).catch((error) =>
        missed(`account deletion: its chats in rooms did not go yet (${describe(error)})`),
      );
    return done;
  }

  /**
   * Step 4, once nothing of the account's spaces is left: its remaining
   * records and its row. Answers whether the account is fully gone. `settle`
   * says the steps before went through, so a row that has to stay is done.
   */
  private async finish(principalId: string, settle: boolean): Promise<boolean> {
    const { sql } = this.deps;
    if ((await ownedSpaces(sql, principalId)).length) return false;
    const [unfinished] = await sql`select 1 from space_removal
      where requested_by = ${principalId} and state <> 'complete' limit 1`;
    if (unfinished) return false;
    const [owns] = await sql`select 1 from space where owner_principal_id = ${principalId} limit 1`;
    if (owns) return false;
    await sql`delete from feedback where principal_id = ${principalId}`;
    await sql`delete from voice_usage where principal_id = ${principalId}`;
    await sql`delete from call_usage where principal_id = ${principalId}`;
    await sql`delete from managed_call where principal_id = ${principalId}`;
    await sql`delete from space_membership where principal_id = ${principalId}
      and revoked_at is not null`;
    try {
      await sql`delete from principal where id = ${principalId}`;
      return true;
    } catch {
      // Something in a room another person owns still names it, such as a
      // message it wrote there. Its records go; the row stays, empty.
      for (const table of LEFTOVER_RECORDS)
        await sql`delete from ${sql(table)} where principal_id = ${principalId}`.catch(() => {});
      if (settle) this.settled.add(principalId);
      return true;
    }
  }

  /** Every account being deleted, carried on, and finished where it can be. */
  async resume(): Promise<number> {
    const pending = await this.deps.sql<{ id: string }[]>`select id from principal
      where email = 'removed+' || lower(id) || '@removed.invalid'`;
    if (!pending.length) return 0;
    // Before any is finished, for all of them at once: a response that landed
    // as a deletion began, and the links of an account whose deletion began
    // before step 1 unlinked them, whether or not its spaces are gone yet.
    await unlinkElsewhere(this.deps.sql, null);
    let finished = 0;
    // One account whose deletion fails never holds up the others.
    for (const { id } of pending) {
      if (this.settled.has(id) || !this.failures.due(id)) continue;
      try {
        const done = await this.carryOn(id);
        if (await this.finish(id, done)) finished += 1;
        this.failures.succeeded(id);
      } catch (error) {
        this.failures.failed(id, error);
      }
    }
    return finished;
  }

  /** Resume now and every minute after, without holding up whoever started it. */
  start(everyMs = 60_000): void {
    if (this.timer) return;
    const pass = () => {
      if (this.passing) return;
      this.passing = this.resume()
        .catch((error) => this.log(`account deletion pass failed (${describe(error)})`))
        .finally(() => {
          this.passing = undefined;
        });
    };
    pass();
    this.timer = setInterval(pass, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The accounts on this Melete, for the person who set it up. */
  async list(actor: string): Promise<AccountSummary[]> {
    const setupOwner = await this.setupOwner();
    const [standing] = await this.deps.sql<{ admin: boolean }[]>`select exists (select 1
      from principal where id = ${actor} and admin and kind = 'person' and disabled_at is null)
      as admin`;
    if (actor !== setupOwner && !standing?.admin)
      throw new ServiceError(
        'scope_denied',
        'Only the account that set Melete up, or an admin, sees the accounts.',
        403,
      );
    // A deleted account whose row has to stay, because a room someone else
    // owns still names it, is not an account any more and is not listed.
    const rows = await this.deps.sql<Account[]>`select p.id, p.email, p.display_name, p.kind,
        p.created_at, p.admin and p.disabled_at is null as admin from principal p
      where p.kind <> 'room' and (p.email <> 'removed+' || lower(p.id) || '@removed.invalid'
        or exists (select 1 from space_removal r where r.requested_by = p.id
          and r.state <> 'complete')
        or exists (select 1 from space s where s.owner_principal_id = p.id))
      order by p.created_at, p.id`;
    return rows.map((row) => summary(row, setupOwner));
  }
}

function summary(row: Account, setupOwner: string | null): AccountSummary {
  const removing = row.email === removedEmail(row.id);
  return {
    id: row.id,
    email: removing ? null : row.email,
    display_name: row.display_name,
    kind: row.kind === 'guest' ? 'guest' : 'person',
    created_at: iso(row.created_at),
    setup_owner: row.id === setupOwner,
    admin: row.id === setupOwner || (row.admin && row.kind === 'person' && !removing),
    state: removing ? 'removing' : 'active',
  };
}

/**
 * What of the account other people's spaces keep stops naming it. The
 * responses it sent to their apps are those apps' records and stay, as sent,
 * from nobody: no account on the response, nor on an earlier one its own
 * newer save replaced. Apps never get the viewer's name or email to put in a
 * response, so a response names someone only if they typed it. An app shared
 * with it is no longer shared with it, and whether it had a room open is
 * nobody's record: both go.
 *
 * Given no account, it does this for every account being deleted, each table
 * read once however many there are.
 */
async function unlinkElsewhere(q: Sql | TransactionSql, principalId: string | null) {
  const who = () =>
    principalId === null
      ? q`select id from principal where email = 'removed+' || lower(id) || '@removed.invalid'`
      : q`select ${principalId}::text`;
  await q`update app_submission set principal_id = null where principal_id in (${who()})`;
  await q`update app_submission set deleted_by = null where deleted_by in (${who()})`;
  await q`delete from app_grant where grantee_kind = 'principal' and grantee_id in (${who()})`;
  await q`delete from room_presence where principal_id in (${who()})`;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');
