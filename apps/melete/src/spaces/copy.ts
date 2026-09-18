/**
 * What a person reads when they remove a space.
 *
 * Two pieces: the confirmation, which is shown before anything happens and
 * says plainly what removal does not reach, and the finished report, which
 * says what went and what is left for them to do somewhere else.
 *
 * Both are written in the product's voice: ordinary words, no jargon, and no
 * promise the sweep cannot keep. A removal that ended blocked never produces a
 * sentence saying the space was deleted.
 */
import type {
  RemovalProvider,
  SpaceRemoval,
  SpaceRemovalKind,
  SpaceRemovalPreview,
  SpaceRemovalReport,
} from '@melete/contracts';

/**
 * The things a removal does not undo, in the order a person should read them.
 * Every line is about something outside this installation, because that is the
 * whole of what stays.
 */
export function whatStays(providers: readonly RemovalProvider[]): string[] {
  const lines = [
    'Messages that were already sent stay where they were sent. This clears what Melete kept about them here.',
    'Files copied somewhere else, and pages published to another service, stay at that service.',
  ];
  if (providers.length > 0)
    lines.push(
      `App passwords and connection keys keep working at the service that issued them. Revoke them there: ${listOf(providers.map((entry) => entry.label || entry.provider))}.`,
    );
  lines.push(
    'The browser profile goes with the space, which signs it out of every site it was signed in to.',
    'Sandboxes and their saved snapshots are deleted at the provider as part of this.',
  );
  return lines;
}

export function confirmationLine(name: string, kind: SpaceRemovalKind): string {
  return kind === 'emptied'
    ? `Emptying ${name} clears everything in it and leaves you the space itself, ready to start again. Type ${name} to go ahead.`
    : `Removing ${name} clears everything in it, and the space with it. Type ${name} to go ahead.`;
}

export function previewCopy(
  name: string,
  kind: SpaceRemovalKind,
  providers: readonly RemovalProvider[],
): Pick<SpaceRemovalPreview, 'stays' | 'confirmation'> {
  return { stays: whatStays(providers), confirmation: confirmationLine(name, kind) };
}

/**
 * The finished account. `complete` is the only state that gets a past tense;
 * anything else says where the removal has got to and what it is waiting on.
 */
export function reportFor(
  removal: SpaceRemoval,
  providers: readonly RemovalProvider[],
): SpaceRemovalReport {
  return {
    removal,
    headline: headlineFor(removal),
    cleared: removal.state === 'complete' ? clearedLines(removal.kind) : [],
    still_yours: removal.state === 'complete' ? whatStays(providers) : [],
  };
}

function headlineFor(removal: SpaceRemoval): string {
  const name = removal.space_name;
  if (removal.state === 'complete')
    return removal.kind === 'emptied'
      ? `${name} is empty. The space is yours to start again whenever you like.`
      : `${name} is gone.`;
  if (removal.state === 'blocked')
    return `${name} is part way through being cleared, and one thing could not be reached: ${removal.blocked_reason ?? 'the verification pass could not account for everything'}. Melete keeps trying, and the space stays closed until it can finish.`;
  return `${name} is being cleared. It is closed to everyone while that runs.`;
}

function clearedLines(kind: SpaceRemovalKind): string[] {
  return [
    'Its work, and everything each piece of work produced.',
    'Its memory: what was remembered, where each of those came from, and the index over them.',
    'Its knowledge files and their history, its artifacts, and its skills.',
    'Its connections and the keys held for them here.',
    'Its browser profile, including the cookies that kept it signed in.',
    kind === 'emptied'
      ? 'The space itself is still here, with a fresh, empty repository.'
      : 'The space itself, and everyone else’s access to it.',
  ];
}

function listOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}
