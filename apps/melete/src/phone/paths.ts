/**
 * The paths ElevenLabs reaches without a session: a line's turn endpoint, the
 * start of an inbound call, and the report at the end of a call. Each checks
 * the line's own key or signature instead of a session.
 */
export const PHONE_PUBLIC_PATH =
  /^\/phone\/conn_[0-9A-Z]{26}\/(?:llm\/v1(?:\/chat\/completions)?|inbound|events)$/;

/** A turn carries the conversation so far; this is room for a long call. */
export const PHONE_BODY_BYTES = 512 * 1024;
