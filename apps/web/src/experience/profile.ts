/**
 * The service answers with the name "there" until the person gives one, so a
 * greeting reads "Good evening, there". That word is a greeting's fallback,
 * never a name: a field the person fills in starts empty instead.
 */
export const UNNAMED = 'there';

/** The person's own name, or '' while they have not given one. */
export function givenName(profile: { name: string } | null | undefined): string {
  const name = profile?.name.trim() ?? '';
  return name === UNNAMED ? '' : name;
}

/** The saved profile, unchanged apart from setup being done. */
export const onboardedProfile = (saved: {
  name: string;
  time_zone: string;
  day_hours: { start: string; end: string };
}) => ({
  name: saved.name,
  time_zone: saved.time_zone,
  day_hours: saved.day_hours,
  onboarded: true,
});
