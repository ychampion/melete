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

export class StarterService {
  constructor(
    private readonly sql: Sql,
    private readonly starters: readonly StarterTask[] = DEFAULT_STARTERS,
  ) {}

  /** What Home offers this person in this space, and why nothing when nothing. */
  async view(spaceId: string, personId: string): Promise<StartersResponse> {
    const [profile] = await this.sql`select time_zone, onboarded_at from experience_profile
      where space_id = ${spaceId}`;
    const [dismissed] = await this.sql`select 1 from starter_dismissal
      where principal_id = ${personId}`;
    // Their own chats in any space, counted only as far as the limit.
    const chats = await this.sql`select 1 from job j
      where j.kind = 'chat'
        and coalesce(j.principal_id, (select id from owner limit 1)) = ${personId}
      limit ${STARTER_CHAT_LIMIT}`;
    const visibility = starterVisibility({
      onboarded: Boolean(profile?.onboarded_at),
      dismissed: Boolean(dismissed),
      chats: chats.length,
    });
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
