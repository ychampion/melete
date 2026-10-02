/**
 * @melete/runtime-hermes packages the engine: a pinned Hermes release configured
 * thin, with the reviewed seams in `patches/observer_bridge.py`, behind the
 * `RuntimeAdapter` interface from the contracts package. The image, the plugin,
 * the client and the adapter are the whole of it.
 */
export * from './adapter.ts';
export * from './client.ts';
export * from './engine-config.ts';
export * from './instructions.ts';
export * from './version.ts';
