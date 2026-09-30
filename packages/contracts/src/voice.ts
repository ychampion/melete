/**
 * Talking to Melete instead of typing.
 *
 * Push-to-talk records a short clip, the service transcribes it, and the words
 * land in the message box for the person to read and send. Voice mode streams
 * the microphone to a realtime transcription service with a single-use token
 * the service mints, sends each finished utterance as an ordinary message, and
 * reads the reply aloud. Neither keeps the audio.
 *
 * Every limit here is a fact the interface can state, not a guess: a clip
 * longer or larger than these is refused with a sentence that says so.
 */
import { z } from 'zod';

export const VOICE_LIMITS = {
  /** The longest push-to-talk clip. The recorder stops itself here. */
  recording_seconds: 120,
  /** The largest push-to-talk clip, far above what two minutes of speech takes. */
  recording_bytes: 5 * 1024 * 1024,
  /** The longest piece of text one request reads aloud. A reply is read in pieces. */
  speech_characters: 2_000,
} as const;

/** Which voice features this installation has. Unconfigured, both are false. */
export const voiceStatus = z.strictObject({
  push_to_talk: z.boolean(),
  voice_mode: z.boolean(),
  max_recording_seconds: z.number().int().positive(),
  max_recording_bytes: z.number().int().positive(),
});
export type VoiceStatus = z.infer<typeof voiceStatus>;

export const voiceTranscriptionQuery = z.strictObject({
  /** How long the clip is, as the recorder measured it. */
  duration_ms: z.coerce
    .number()
    .int()
    .positive()
    .max(VOICE_LIMITS.recording_seconds * 1000 * 10),
});

/** What was heard. Empty when the clip held no speech. */
export const voiceTranscription = z.strictObject({
  text: z.string().max(20_000),
  language: z.string().max(16).nullable(),
});
export type VoiceTranscription = z.infer<typeof voiceTranscription>;

/**
 * A realtime transcription session. The address carries a single-use token,
 * never the provider key, and stops working at `expires_at` or on first use.
 */
export const voiceSession = z.strictObject({
  url: z.string().regex(/^wss?:\/\//, 'a WebSocket address'),
  /** The PCM sample rate the session expects, 16-bit mono. */
  sample_rate: z.number().int().positive(),
  expires_at: z.iso.datetime({ offset: true }),
});
export type VoiceSession = z.infer<typeof voiceSession>;

export const voiceSpeechRequest = z.strictObject({
  text: z.string().trim().min(1).max(VOICE_LIMITS.speech_characters),
});
export type VoiceSpeechRequest = z.infer<typeof voiceSpeechRequest>;
