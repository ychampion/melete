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

/**
 * Where voice would be used: a conversation, or the agent a new chat will have.
 * A private space or agent, or a conversation about a sensitive topic, has
 * voice off, because audio and the words read aloud go to a cloud speech
 * service.
 */
export const voiceContextQuery = z.strictObject({
  conversation_id: z.string().min(1).max(200).optional(),
  agent_id: z.string().min(1).max(200).optional(),
});
export type VoiceContextQuery = z.infer<typeof voiceContextQuery>;

/** Which voice features this installation has. Unconfigured, both are false. */
export const voiceStatus = z.strictObject({
  push_to_talk: z.boolean(),
  voice_mode: z.boolean(),
  max_recording_seconds: z.number().int().positive(),
  max_recording_bytes: z.number().int().positive(),
  /**
   * Why voice is off where it was asked about, in a sentence to show the
   * person, or null when it may be used there.
   */
  off_reason: z.string().nullable(),
});
export type VoiceStatus = z.infer<typeof voiceStatus>;

export const voiceTranscriptionQuery = voiceContextQuery.extend({
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

/**
 * Talking with Melete while it works. The work goes on in the conversation's
 * running turn; this is a separate, light conversation alongside it. It can
 * answer a quick question, say how the work is going, or recognise that what
 * was said is an instruction for the work. It never acts: it has no tools and
 * decides nothing.
 */
export const VOICE_ASIDE_LIMITS = {
  /** The longest thing the person said that one aside reads. */
  heard_characters: 1_000,
  /** How many of the running turn's steps an aside is shown, the latest kept. */
  steps: 12,
  step_characters: 200,
  /** The longest thing an aside says back. */
  say_characters: 400,
} as const;

/** What the running turn is doing, as the screen shows it. */
export const voiceActivity = z.strictObject({
  /** The step under way now, when there is one. */
  now: z.string().trim().max(VOICE_ASIDE_LIMITS.step_characters).nullable(),
  /** The steps finished so far in this turn, oldest first. */
  steps: z
    .array(z.string().trim().min(1).max(VOICE_ASIDE_LIMITS.step_characters))
    .max(VOICE_ASIDE_LIMITS.steps),
});
export type VoiceActivity = z.infer<typeof voiceActivity>;

export const voiceAsideRequest = z.discriminatedUnion('kind', [
  /** The person said something while the work runs. */
  z.strictObject({
    kind: z.literal('heard'),
    text: z.string().trim().min(1).max(VOICE_ASIDE_LIMITS.heard_characters),
    activity: voiceActivity,
  }),
  /** A natural moment to say how the work is going, if there is anything new to say. */
  z.strictObject({ kind: z.literal('progress'), activity: voiceActivity }),
]);
export type VoiceAsideRequest = z.infer<typeof voiceAsideRequest>;

/**
 * What the aside makes of it. `talk`: say `say`. `steer`: what was said is an
 * instruction for the work, to be passed on; `say` acknowledges it. `stop`: the
 * person wants the work stopped. `quiet`: nothing worth saying.
 */
export const voiceAside = z.strictObject({
  intent: z.enum(['talk', 'steer', 'stop', 'quiet']),
  say: z.string().max(VOICE_ASIDE_LIMITS.say_characters).nullable(),
});
export type VoiceAside = z.infer<typeof voiceAside>;
