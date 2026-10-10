/**
 * Deleting an account.
 *
 * A person deletes their own account; the person who set Melete up can
 * delete one they made for someone else. Either way it happens in this order:
 *
 * 1. At once, in one transaction, the account can no longer be used: its
 *    email, name, password and passkey are wiped, and its sign-in sessions,
 *    linked sign-ins, reset links, assistant grants, push subscriptions and
 *    pending notification texts are deleted. The email is free again.
 * 2. It leaves the rooms other people own, as leaving one does: its place
 *    there ends and the work it started there stops.
 * 3. Every space it owns is removed by the space removal: its own space and
 *    the rooms it made, with everything in them. The same phased sweep and
 *    final count that removing one space runs, so a space is reported gone
 *    only once a recount finds nothing left.
 * 4. Once none of its spaces is left, the account's remaining records go,
 *    and its row with them. Where messages it wrote in someone else's room
 *    still name it, the row stays, with nothing in it but its id, so that
 *    room's history still reads; it says "a removed account".
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
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { principalContext } from '../principals/authority.ts';
import type { PrincipalService } from '../principals/service.ts';
import type { SpaceRemovalService } from '../spaces/removal.ts';
import { iso, ownedSpaces } from './export.ts';

/** The email a deleted account is left with: its own id, at a domain nothing can receive mail for. */
export const removedEmail = (principalId: string) =>
  `removed+${principalId.toLowerCase()}@removed.invalid`;

export const SETUP_OWNER_KEPT =
  'The account that set Melete up can’t be deleted: it runs this Melete and manages the other accounts. You can erase everything in your space instead, or remove Melete from the computer it runs on.';

/** Records kept for an account rather than a space, which go with it. */
const ACCOUNT_RECORDS = [
  'session',
  'principal_identity',
  'password_reset',
  'mcp_authorization',
  'mcp_token',
  'push_subscription',
  'push_intent',
];

/** What is left of an account once its spaces are gone, should its row have to stay. */
const LEFTOVER_RECORDS = [
  ...ACCOUNT_RECORDS,
  'push_setting',
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
  'managed_call',
];

export type AccountRemovalDeps = {
  sql: Sql;
  spaces: SpaceRemovalService;
  principals: PrincipalService;
  /** The space a running browser worker mounts, which cannot be removed under it. */
  browserSpace?: string;
  log?: (line: string) => void;
};

type Account = {
  id: string;
  email: string;
  display_name: string | null;
  kind: string;
  created_at: string;
};

export class AccountRemovalService {
  private timer?: ReturnType<typeof setInterval>;
  private passing?: Promise<unknown>;
  private readonly log: (line: string) => void;

  constructor(readonly deps: AccountRemovalDeps) {
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  private async setupOwner(): Promise<string | null> {
    const [row] = await this.deps.sql<{ id: string }[]>`select id from owner limit 1`;
    return row?.id ?? null;
  }

  private async account(principalId: string): Promise<Account | undefined> {
    const [row] = await this.deps.sql<Account[]>`select id, email, display_name, kind, created_at
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
            and status <> 'revoked') as connections`;
      counts.set(space.id, row ?? { chats: 0, files: 0, connections: 0 });
    }
    const rooms = await this.deps.sql<{ id: string; name: string }[]>`
      select s.id, s.name from space s join space_membership m on m.space_id = s.id
      where m.principal_id = ${principalId} and m.revoked_at is null and m.role <> 'owner'
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
        passkey = null, display_name = null where id = ${principalId}`;
      for (const table of ACCOUNT_RECORDS)
        await tx`delete from ${tx(table)} where principal_id = ${principalId}`;
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
   */
  private async carryOn(principalId: string): Promise<void> {
    const { sql, spaces, principals } = this.deps;
    await principalContext.run(principalId, async () => {
      const rooms = await sql<{ space_id: string }[]>`select m.space_id from space_membership m
        join space s on s.id = m.space_id
        where m.principal_id = ${principalId} and m.revoked_at is null and m.role <> 'owner'
          and m.role <> 'agent' and s.kind = 'shared' and s.removed_at is null`;
      for (const room of rooms)
        await principals
          .revoke(principalId, room.space_id, principalId)
          .catch((error) =>
            this.log(
              `account deletion: leaving ${room.space_id} did not finish yet (${describe(error)})`,
            ),
          );
      for (const space of await ownedSpaces(sql, principalId)) {
        const row = await spaces
          .fence(principalId, space.id, space.name, { forAccountDeletion: true })
          .catch((error) => {
            this.log(
              `account deletion: removing ${space.id} did not start yet (${describe(error)})`,
            );
            return null;
          });
        if (row) spaces.dispatch(row.id);
      }
    });
  }

  /**
   * Step 4, once nothing of the account's spaces is left: its remaining
   * records and its row. Answers whether the account is fully gone.
   */
  private async finish(principalId: string): Promise<boolean> {
    const { sql } = this.deps;
    if ((await ownedSpaces(sql, principalId)).length) return false;
    const [unfinished] = await sql`select 1 from space_removal
      where requested_by = ${principalId} and state <> 'complete' limit 1`;
    if (unfinished) return false;
    const [owns] = await sql`select 1 from space where owner_principal_id = ${principalId} limit 1`;
    if (owns) return false;
    await sql`delete from feedback where principal_id = ${principalId}`;
    await sql`delete from voice_usage where principal_id = ${principalId}`;
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
      return true;
    }
  }

  /** Every account being deleted, carried on, and finished where it can be. */
  async resume(): Promise<number> {
    const pending = await this.deps.sql<{ id: string }[]>`select id from principal
      where email = 'removed+' || lower(id) || '@removed.invalid'`;
    let finished = 0;
    for (const { id } of pending) {
      await this.carryOn(id);
      if (await this.finish(id)) finished += 1;
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
    if (actor !== setupOwner)
      throw new ServiceError(
        'scope_denied',
        'Only the account that set Melete up manages accounts.',
        403,
      );
    // A deleted account whose row has to stay, because a room someone else
    // owns still names it, is not an account any more and is not listed.
    const rows = await this.deps.sql<Account[]>`select p.id, p.email, p.display_name, p.kind,
        p.created_at from principal p
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
    state: removing ? 'removing' : 'active',
  };
}

const describe = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');
