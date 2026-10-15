/**
 * Home's starter tasks for a new person: which to offer, filled in for them,
 * and putting them away.
 *
 * They are offered once setup is done, until the person has a few chats of
 * their own or puts them away; putting them away is kept by account, so it
 * holds on every device. The list is the installation's: the built-in one,
 * or the operator's from MELETE_STARTERS.
 */
import {
  cityFromTimeZone,
  DEFAULT_STARTERS,
  fillStarter,
  STARTER_CHAT_LIMIT,
  type StartersResponse,
  type StarterTask,
  starterList,
  starterVisibility,
} from '@melete/contracts';
import type { Sql } from 'postgres';

/**
 * The installation's starters: the operator's JSON list when one is set, else
 * the built-in list. A list that does not parse or does not fit the shape is
 * refused with the reason, so a mistake is seen when the service starts.
 */
export function startersFromSetting(raw: string | undefined): readonly StarterTask[] {
  if (!raw?.trim()) return DEFAULT_STARTERS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('MELETE_STARTERS must be a JSON array of starters');
  }
  const parsed = starterList.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`MELETE_STARTERS is not a valid list${where}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/**
 * Whether a space's setup is done, given whether it is recorded as done: the
 * rule Home's profile uses (ExperienceHome.onboarded), so a space set up
 * before setup was recorded is offered starters too.
 */
export type SpaceOnboarded = (spaceId: string, recorded: boolean) => Promise<boolean>;

export class StarterService {
  constructor(
    private readonly sql: Sql,
    private readonly starters: readonly StarterTask[] = DEFAULT_STARTERS,
    private readonly onboarded: SpaceOnboarded = async (_spaceId, recorded) => recorded,
  ) {}

  /** What Home offers this person in this space, and why nothing when nothing. */
  async view(spaceId: string, personId: string): Promise<StartersResponse> {
    const [profile] = await this.sql`select time_zone, onboarded_at from experience_profile
      where space_id = ${spaceId}`;
    const [dismissed] = await this.sql`select 1 from starter_dismissal
      where principal_id = ${personId}`;
    const onboarded = await this.onboarded(spaceId, Boolean(profile?.onboarded_at));
    // Nothing is offered before setup or once put away, so the chats are not counted then.
    const before = starterVisibility({ onboarded, dismissed: Boolean(dismissed), chats: 0 });
    if (!before.show) return { ...before, starters: [] };
    // Their own chats in any space, counted only as far as the limit. A chat
    // with no principal is the installation owner's. Written as an OR, not a
    // coalesce, so an index on job (principal_id) where kind = 'chat' serves it.
    const chats = await this.sql`select 1 from job j
      where j.kind = 'chat'
        and (j.principal_id = ${personId}
          or (j.principal_id is null and ${personId} = (select id from owner limit 1)))
      limit ${STARTER_CHAT_LIMIT}`;
    const visibility = starterVisibility({ onboarded, dismissed: false, chats: chats.length });
    if (!visibility.show) return { ...visibility, starters: [] };
    const city = cityFromTimeZone(profile?.time_zone ? String(profile.time_zone) : null);
    return { ...visibility, starters: this.starters.map((starter) => fillStarter(starter, city)) };
  }

  /** Puts the starters away for this person; doing it again changes nothing. */
  async dismiss(personId: string): Promise<{ status: 'ok' }> {
    await this.sql`insert into starter_dismissal (principal_id) values (${personId})
      on conflict (principal_id) do nothing`;
    return { status: 'ok' };
  }
}
