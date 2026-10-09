/**
 * Taking over from a hand-off card: the work came to a page only the person
 * can get past, and the card's Take over gives them the agent's browser or the
 * desktop of the agent's computer, whichever the work was on. The chat then
 * shows the computer, with the live view theirs to use.
 */
import { adapter } from '../experience/adapter.ts';
import type { CardAction } from '../experience/types.ts';

type Calls = Pick<typeof adapter, 'takeOver' | 'sandboxTakeOver'>;

/** Takes the browser or the computer over; says what went wrong when it could not. */
export async function takeOverFromCard(
  action: CardAction,
  calls: Calls = adapter,
): Promise<{ ok: true; what: 'browser' | 'computer' } | { ok: false; error: string }> {
  const what = action.surface === 'browser' ? 'browser' : 'computer';
  const result =
    what === 'browser'
      ? await calls.takeOver(action.handle)
      : await calls.sandboxTakeOver(action.handle);
  if (result.data === null)
    return { ok: false, error: result.error ?? result.unavailable ?? 'Couldn’t take over' };
  return { ok: true, what };
}
