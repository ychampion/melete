/**
 * Where ElevenLabs connects for a call, and the header that proves it is
 * ElevenLabs. Shared by the service and the web app's proxy, which passes this
 * one WebSocket through; it imports nothing, so the web image can carry it.
 */

/** The service path of a call's upstream WebSocket; the public one is under `/api`. */
export const CALL_UPSTREAM_PATH = '/voice/call/upstream';

/** The header each upstream connection carries its JWT in, lower-cased. */
export const SPEECH_ENGINE_AUTH_HEADER = 'x-elevenlabs-speech-engine-authorization';
