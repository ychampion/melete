/**
 * Which models can search the web themselves, through a search tool their
 * provider runs.
 *
 * The answer comes from this table, as vision's does from `model-vision.ts`:
 * nothing is probed at run time. A model the table does not recognise is
 * treated as having no search of its own, and Melete's own search serves it
 * instead, so a wrong "no" only costs the provider's own index.
 *
 * Only providers whose search tool travels over the protocol the gateway
 * speaks to them are listed. Gemini's grounding is not reachable through the
 * OpenAI-compatible endpoint Melete uses for Google, so Google is absent;
 * Fireworks and OpenAI-compatible servers have no search tool of their own.
 */
const SEARCH_FAMILIES: Record<string, RegExp[]> = {
  // The web search tool of the Messages API.
  anthropic: [
    /^claude-(opus|sonnet|haiku)-[4-9]/i,
    /^claude-3-7-sonnet/i,
    /^claude-3-5-(sonnet|haiku)/i,
  ],
  // The `web_search` tool of the Responses API.
  openai: [
    /^gpt-4o(?!.*(audio|realtime|transcribe|tts))/i,
    /^gpt-4\.1/i,
    /^gpt-[5-9]/i,
    /^o3/i,
    /^o4-mini/i,
  ],
};

/** Builds that the search tool refuses although their family accepts it. */
const NO_SEARCH = [/nano/i, /embed/i, /-audio/i, /realtime/i, /instruct/i];

/** True when the catalog knows this model can search the web through its provider. */
export function modelSupportsNativeSearch(provider: string, model: string): boolean {
  if (!Object.hasOwn(SEARCH_FAMILIES, provider)) return false;
  if (NO_SEARCH.some((pattern) => pattern.test(model))) return false;
  return (SEARCH_FAMILIES[provider] ?? []).some((pattern) => pattern.test(model));
}

/**
 * The model's own search as it will be used: the operator's word when they
 * gave one, otherwise the catalog's. Saying true for a provider with no search
 * tool still leaves it without one.
 */
export function effectiveNativeSearch(
  provider: string,
  model: string,
  override: boolean | null | undefined,
): boolean {
  if (!Object.hasOwn(SEARCH_FAMILIES, provider)) return false;
  return typeof override === 'boolean' ? override : modelSupportsNativeSearch(provider, model);
}
