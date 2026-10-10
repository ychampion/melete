/**
 * Which models can look at a picture, and how much room pictures take.
 *
 * The agent's screenshots of its own computer, and of a paired device, reach
 * the model as images only when the model reads images. Every other model gets
 * the text receipt it always got: where the picture was saved, its size and
 * its digest. Nothing is probed at run time (the engine has no route to a
 * provider), so the answer comes from this table, or from the owner, who can
 * say otherwise in the model settings. What a provider's own model list says
 * (`listedVision`) is shown to the owner beside the switch; it never turns
 * pictures on by itself.
 *
 * A model the table does not recognise is treated as text-only. Telling a
 * text-only model it can see makes its provider refuse the request; telling a
 * vision model it cannot only costs it the picture.
 */

/**
 * The DeepSeek models that read images: V4.1 Flash (`deepseek-v4p1-flash` on
 * Fireworks, `DeepSeek-V4.1-Flash` elsewhere) and the V4 Flash vision build.
 * Every other DeepSeek model, V4 Pro and the earlier V4 Flash checkpoints
 * among them, reads text only.
 */
const DEEPSEEK_VISION = [/deepseek-v4(?:p|\.)1-flash(?=$|[-_/:])/i, /deepseek-v4-flash-vision/i];

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
  /kimi-?k2(?:\.|p)?5/i,
  // Kimi K3 and its routers (`kimi-k3-fast`); not a later K3 point release.
  /kimi-?k3(?=$|[-_/:])/i,
  ...DEEPSEEK_VISION,
];

const VISION_FAMILIES: Record<string, RegExp[]> = {
  anthropic: [/^claude-/i],
  openai: [/^gpt-4o/i, /^gpt-4\.1/i, /^gpt-[5-9]/i, /^o[134](-|$)/i, /^chatgpt-4o/i],
  chatgpt: [/^gpt-[5-9]/i, /^codex-/i],
  google: [/^(models\/)?gemini-/i, /^(models\/)?gemma-?[34]/i],
  fireworks: OPEN_WEIGHT_VISION,
  'openai-compatible': [...OPEN_WEIGHT_VISION, /^gpt-4o/i, /^gpt-[5-9]/i, /^claude-/i, /gemini-/i],
};

/**
 * Families that carry a vision marker in their name but read only text. The
 * DeepSeek models named in `DEEPSEEK_VISION` are the exceptions.
 */
const TEXT_ONLY = [/deepseek/i, /embed/i, /whisper/i, /tts/i, /^gpt-3\.5/i, /-audio-/i];

/**
 * True when the catalog knows this model reads images. The scripted test
 * provider never does: its replies are written in advance.
 */
export function modelSupportsVision(provider: string, model: string): boolean {
  if (!Object.hasOwn(VISION_FAMILIES, provider)) return false;
  if (
    TEXT_ONLY.some((pattern) => pattern.test(model)) &&
    !DEEPSEEK_VISION.some((pattern) => pattern.test(model))
  )
    return false;
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
 * What one entry of a provider's model list says about reading images, when it
 * says anything. Fireworks answers `supports_image_input`; OpenRouter-style
 * lists answer `architecture.input_modalities`; some servers answer
 * `input_modalities`, `modalities.input`, `capabilities.image_input.supported`
 * or a `capabilities` list. Lists that say nothing (OpenAI's, Google's
 * OpenAI-compatible one) leave the answer to the catalog.
 */
export function listedVision(entry: unknown): boolean | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.supports_image_input === 'boolean') return record.supports_image_input;
  const modalities = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.some((item) => /^image/i.test(item))
      : undefined;
  const nested = (value: unknown, key: string) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const fromModalities =
    modalities(nested(record.architecture, 'input_modalities')) ??
    modalities(record.input_modalities) ??
    modalities(nested(record.modalities, 'input'));
  if (fromModalities !== undefined) return fromModalities;
  const capabilities = record.capabilities;
  if (Array.isArray(capabilities) && capabilities.every((item) => typeof item === 'string'))
    return capabilities.some((item) => /^(vision|image(_input)?)$/i.test(item));
  const supported = nested(nested(capabilities, 'image_input'), 'supported');
  if (typeof supported === 'boolean') return supported;
  const vision = nested(capabilities, 'vision');
  return typeof vision === 'boolean' ? vision : undefined;
}

/**
 * The models a provider's list answers for, by the id a call takes, and
 * whether each reads images. Models the list says nothing about are left out.
 */
export function listedVisionByModel(body: unknown): Map<string, boolean> {
  const answers = new Map<string, boolean>();
  if (!body || typeof body !== 'object') return answers;
  const record = body as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const value =
      (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    if (typeof value !== 'string' || !value || value.length > 300) continue;
    const vision = listedVision(entry);
    if (vision !== undefined) answers.set(value.replace(/^models\//, ''), vision);
  }
  return answers;
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
 * The most pictures one request may carry: the screenshots the engine keeps,
 * and the pictures a person attached, which the gateway shows in their place
 * only while the request has room for them.
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
