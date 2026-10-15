import type { ProviderFailure, ResultCard } from '@melete/contracts';

/** Where the person picks a model and connects its key. */
export const MODEL_SETTINGS_PLACE = '#/settings/models';

/** What the person reads when the model provider turned the turn away for good. */
export const PROVIDER_FAILURE_NOTES: Record<ProviderFailure, string> = {
  key_refused:
    'I couldn’t reach the model: your model provider didn’t accept the API key. Check the key in Settings → Models, then send your message again.',
  quota:
    'I couldn’t reach the model: your model provider account is out of credit or over its usage limit. Add credit with the provider, or choose another model in Settings → Models.',
  rate_limited:
    'I couldn’t reach the model: your model provider is limiting how many requests this key can send right now. Wait a minute, then send your message again.',
  model_not_found:
    'I couldn’t reach the model: the model chosen for this chat isn’t available from your provider. Choose another one in Settings → Models.',
  context_too_long:
    'This conversation is now longer than the model can read at once. Start a new chat, or choose a model that can read more in Settings → Models.',
  provider_down:
    'I couldn’t reach the model: your model provider isn’t answering right now. Try again in a few minutes.',
};

/** What the person reads while the turn waits to ask a busy provider again. */
export function providerRetryNote(failure: ProviderFailure, seconds: number): string {
  const wait = seconds <= 1 ? 'in a moment' : `in about ${seconds} seconds`;
  return failure === 'rate_limited'
    ? `Your model provider asked me to slow down. I’ll try again ${wait}.`
    : `Your model provider isn’t answering right now. I’ll try again ${wait}.`;
}

/** Failures that a change in Settings → Models fixes. */
const SETTINGS_FIXES: ReadonlySet<ProviderFailure> = new Set([
  'key_refused',
  'quota',
  'model_not_found',
  'context_too_long',
]);

const CARD_TITLES: Partial<Record<ProviderFailure, string>> = {
  key_refused: 'The model key was not accepted',
  quota: 'The model account is out of credit',
  model_not_found: 'The chosen model is not available',
  context_too_long: 'This chat is too long for the model',
};

/** The card that takes the person to the fix, when the fix is in Settings → Models. */
export function providerFailureCard(
  failure: ProviderFailure,
  attemptId: string,
): ResultCard | null {
  if (!SETTINGS_FIXES.has(failure)) return null;
  return {
    id: `provider-failure:${attemptId}`,
    title: CARD_TITLES[failure] ?? 'The model could not be reached',
    meta: 'Settings → Models',
    facts: [],
    primary_action: { label: 'Open model settings', kind: 'open', handle: MODEL_SETTINGS_PLACE },
    secondary_actions: [],
    source_connection: null,
  };
}
