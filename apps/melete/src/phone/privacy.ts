/**
 * Whether a call may carry a conversation to ElevenLabs.
 *
 * Everything said on a call, both sides, is heard and transcribed by
 * ElevenLabs, and the replies Melete writes are spoken by it. So a call follows
 * the same marks voice and the model gateway do: a space or agent the person
 * marked private, and a conversation that looks like it is about a sensitive
 * topic, place no call unless the person chose this one, and the person's own
 * calls to the line are not taken there at all. A check that cannot answer
 * counts as private.
 */
import type { PrivacyRouter } from '../privacy/index.ts';

export type CallPrivacyReason = 'private' | 'sensitive';

/**
 * Why a call may not carry this conversation, or null when it may. `jobId` is
 * the conversation the call belongs to: the job proposing it, or the line's
 * own conversation; null when there is none yet.
 */
export type CallPrivacy = (scope: {
  spaceId: string;
  jobId: string | null;
}) => Promise<CallPrivacyReason | null>;

/** The privacy router's answer: the same marks the model gateway and voice follow. */
export function callPrivacyFrom(router: PrivacyRouter): CallPrivacy {
  return async ({ spaceId, jobId }) => {
    if (!jobId) return (await router.marksPrivate(spaceId, null)) ? 'private' : null;
    const scope = await router.store.scope(jobId, '');
    // A conversation that is not in the line's space is never guessed about.
    if (scope.spaceId !== spaceId) throw new Error('call_scope_mismatch');
    if (await router.marksPrivate(spaceId, scope.agentId)) return 'private';
    if (scope.conversationId && (await router.store.conversation(scope.conversationId)).sensitive)
      return 'sensitive';
    return null;
  };
}

/** The check, with no check and a failed one both answering `unchecked`. */
export async function callPrivacyReason(
  privacy: CallPrivacy | undefined,
  scope: { spaceId: string; jobId: string | null },
): Promise<CallPrivacyReason | 'unchecked' | null> {
  if (!privacy) return 'unchecked';
  return privacy(scope).catch(() => 'unchecked' as const);
}

const PROVIDER =
  'A call sends everything said on it, both sides, to ElevenLabs, a cloud voice service.';

/** What the model is told when a call is not proposed, per reason. */
export const CALL_OFF_HERE: Record<CallPrivacyReason | 'unchecked', string> = {
  private: `This space, or this conversation's agent, is marked private. ${PROVIDER} Melete does not place calls from here unless the person says this call may go ahead anyway. Ask them; only if they agree, propose the call again with allow_from_private set to true, and the approval card will say so.`,
  sensitive: `This conversation looks like it is about a sensitive topic. ${PROVIDER} Melete does not place calls from it unless the person says this call may go ahead anyway. Ask them; only if they agree, propose the call again with allow_from_private set to true, and the approval card will say so.`,
  unchecked:
    "Melete could not check this conversation's privacy settings, so no call was proposed. Try again shortly.",
};

/** What the person hears when they call their line from a private space. It names nobody. */
export const PRIVATE_LINE_OPENING =
  'Hello. Calls are off on this line for now, because where it answers is marked private. Goodbye.';
