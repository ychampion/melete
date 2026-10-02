/**
 * Which models can look at a picture, and how much room pictures take.
 *
 * The agent's screenshots of its own computer, and of a paired device, reach
 * the model as images only when the model reads images. Every other model gets
 * the text receipt it always got: where the picture was saved, its size and
 * its digest. Nothing is probed at run time (the engine has no route to a
 * provider), so the answer comes from this table, or from the owner, who can
 * say otherwise in the model settings.
 *
 * A model the table does not recognise is treated as text-only. Telling a
 * text-only model it can see makes its provider refuse the request; telling a
 * vision model it cannot only costs it the picture.
 */

/**
 * Model families known to read images, per provider. Matched against the model
 * id as the provider answers to it, case-insensitively. Providers that host
 * many families (Fireworks, an OpenAI-compatible server) are matched by the
 * markers vision builds carry in their names.
 */
const OPEN_WEIGHT_VISION = [
  /(^|[/_.-])(vl|vlm|vision|omni)([/_.-]|$)/i,
  /qwen[0-9.p]*-?vl/i,
  /llava/i,
  /pixtral/i,
  /gemma-?[34]/i,
  /llama-?(v?4|3\.2-vision|3p2-[0-9]+b-vision)/i,
  /minicpm-?v/i,
  /internvl/i,
  /kimi-?k2\.?5/i,
];

const VISION_FAMILIES: Record<string, RegExp[]> = {
  anthropic: [/^claude-/i],
  openai: [/^gpt-4o/i, /^gpt-4\.1/i, /^gpt-[5-9]/i, /^o[134](-|$)/i, /^chatgpt-4o/i],
  chatgpt: [/^gpt-[5-9]/i, /^codex-/i],
  google: [/^(models\/)?gemini-/i, /^(models\/)?gemma-?[34]/i],
  fireworks: OPEN_WEIGHT_VISION,
  'openai-compatible': [...OPEN_WEIGHT_VISION, /^gpt-4o/i, /^gpt-[5-9]/i, /^claude-/i, /gemini-/i],
};

/** Families that carry a vision marker in their name but read only text. */
const TEXT_ONLY = [/deepseek/i, /embed/i, /whisper/i, /tts/i, /^gpt-3\.5/i, /-audio-/i];

/**
 * True when the catalog knows this model reads images. The scripted test
 * provider never does: its replies are written in advance.
 */
export function modelSupportsVision(provider: string, model: string): boolean {
  if (!Object.hasOwn(VISION_FAMILIES, provider)) return false;
  if (TEXT_ONLY.some((pattern) => pattern.test(model))) return false;
  return (VISION_FAMILIES[provider] ?? []).some((pattern) => pattern.test(model));
}

/**
 * The model's vision as it will be used: the owner's word when they gave one,
 * otherwise the catalog's.
 */
export function effectiveVision(
  provider: string,
  model: string,
  override: boolean | null | undefined,
): boolean {
  return typeof override === 'boolean' ? override : modelSupportsVision(provider, model);
}

/**
 * Screenshots kept as pictures in what is sent to the model. Older ones are
 * replaced by their text receipt. This is the pinned engine's own number
 * (`_MAX_KEEP_TOOL_IMAGES` in agent/context_compressor.py), applied to every
 * request it sends; the gateway refuses a request carrying more than
 * `MAX_REQUEST_IMAGES`.
 */
export const MAX_CONTEXT_IMAGES = 3;

/**
 * The most pictures one request may carry. What a person attaches reaches the
 * engine as text, so the only pictures are the screenshots it keeps.
 */
export const MAX_REQUEST_IMAGES = MAX_CONTEXT_IMAGES;

/** The longest side a screenshot is scaled down to before the model sees it. */
export const VISION_IMAGE_MAX_EDGE = 1280;

/**
 * The largest picture one request may carry, as base64 text. The runtime
 * shrinks each screenshot below this (lower quality first, then a smaller
 * size); the gateway refuses anything larger.
 */
export const MAX_IMAGE_ENCODED_BYTES = 128 * 1024;

/**
 * What a picture is charged as, in input tokens. It is the pinned engine's own
 * estimate (`DEFAULT_IMAGE_TOKEN_COST` in agent/image_token_cost.py), so the
 * gateway and the engine's compaction agree on how full a request is; a
 * 1280-pixel picture costs between about 800 and 1,600 tokens at the providers
 * Melete talks to.
 */
export const IMAGE_INPUT_TOKENS = 1500;

/**
 * The part of the gateway's body limit set aside for pictures when the model
 * reads them, so the text the engine compacts by never pushes a request with
 * its retained screenshots past the limit.
 */
export const VISION_IMAGE_RESERVE_BYTES = MAX_REQUEST_IMAGES * MAX_IMAGE_ENCODED_BYTES;
