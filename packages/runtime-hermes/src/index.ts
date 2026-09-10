/**
 * @melete/runtime-hermes packages the v0.1 engine: a pinned, unmodified Hermes
 * release configured thin, behind the `RuntimeAdapter` interface from the
 * contracts package. The image, the plugin, and this client are the whole of it.
 */
export * from './client.ts';

/** The release this image is built from. Changing it is a decision, not a bump. */
export const HERMES_PINNED_TAG = 'v2026.9.7';
export const HERMES_REPOSITORY = 'https://github.com/NousResearch/hermes-agent';
export const RUNTIME_VERSION = `hermes@${HERMES_PINNED_TAG}`;
