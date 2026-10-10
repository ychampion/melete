/**
 * Talking to Melete: push-to-talk and voice mode.
 *
 * Every route here needs a signed-in person and works in the space their
 * session resolved, as the conversation routes do. The two that belong to a
 * conversation find it the way those routes do, in the session space and owned
 * by the caller, so another person's conversation is simply not there.
 *
 * Audio passes through and is never written anywhere: a push-to-talk clip is
 * held in memory for one provider call, and speech is streamed straight from
 * the provider to the browser. What is kept is how much each person used, so a
 * daily allowance can hold. A refusal says which limit, in plain words; a
 * provider failure never repeats what the provider said.
 *
 * Audio, what was heard and the words read aloud go to the speech provider
 * directly, not through the model gateway, so the privacy router cannot redact
 * or reroute them. Voice is therefore off wherever the router would keep work
 * off a cloud model: a space or agent marked private, and a conversation found
 * to be about a sensitive topic. The check runs before any audio is read.
 */
import { randomUUID } from 'node:crypto';
import {
  VOICE_LIMITS,
  voiceAside,
  voiceAsideRequest,
  voiceContextQuery,
  voiceSession,
  voiceSpeechRequest,
  voiceStatus,
  voiceTranscription,
  voiceTranscriptionQuery,
} from '@melete/contracts';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import {
  type LiveVoice,
  REALTIME_SAMPLE_RATE,
  VoiceProviderError,
} from '../connectors/elevenlabs.ts';
import type { TranscriptionAdapter } from '../connectors/transcribe.ts';
import { wavDurationMs } from '../connectors/wav.ts';
import type { Database } from '../db/client.ts';
import { agent, connection, experienceTurn, job, question } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { answerStream, answerText } from '../experience/answer-filter.ts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import { ownJob } from '../principals/authority.ts';
import type { PrivacyRouter } from '../privacy/router.ts';
import { ServiceError } from './errors.ts';
import {
  COMPANION_LIMITS,
  type CompanionContext,
  pointToQuestion,
  type VoiceCompanion,
} from './voice-companion.ts';

export type VoiceUsageKind = 'transcribe' | 'speech' | 'session' | 'aside';

/** A person's daily voice allowance: taken before a provider call, given back if it failed. */
export interface VoiceAllowance {
  /** The reservation, or null when `amount` would take the last day past `limit`. */
  take(
    principalId: string,
    kind: VoiceUsageKind,
    amount: number,
    limit: number,
  ): Promise<string | null>;
  giveBack(reservation: string): Promise<void>;
}

/**
 * The allowance in Postgres. One person's use is counted under one lock, so two
 * requests cannot both take the last of the day, and rows older than the window
 * are cleared as new ones are written.
 */
export class PostgresVoiceAllowance implements VoiceAllowance {
  constructor(private readonly sql: Sql) {}

  take(principalId: string, kind: VoiceUsageKind, amount: number, limit: number) {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`voice:${principalId}:${kind}`}))`;
      await tx`delete from voice_usage where principal_id = ${principalId}
        and created_at < clock_timestamp() - interval '2 days'`;
      const [used] = await tx`select coalesce(sum(amount), 0)::int as amount from voice_usage
        where principal_id = ${principalId} and kind = ${kind}
          and created_at > clock_timestamp() - interval '1 day'`;
      if (Number(used?.amount ?? 0) + amount > limit) return null;
      const id = randomUUID();
      await tx`insert into voice_usage (id, principal_id, kind, amount)
        values (${id}, ${principalId}, ${kind}, ${amount})`;
      return id;
    });
  }

  async giveBack(reservation: string) {
    await this.sql`delete from voice_usage where id = ${reservation}`;
  }
}

export type VoiceProviders = {
  transcription: TranscriptionAdapter | null;
  live: LiveVoice | null;
};

export type VoiceLimits = {
  seconds: number;
  characters: number;
  sessions: number;
  /** Words with the agent while it works, each one short model call. */
  asides: number;
};

/** Asides one person may have in a day: a long working day of calls, never an open tap. */
export const DAILY_ASIDES = 600;

/** Why voice may not be used here, or null when it may. */
export type VoicePrivacyReason = 'private' | 'sensitive' | null;

/**
 * Whether a place is kept off cloud services. `conversationId` is one the
 * caller already found in `spaceId`; `agentId` is its agent, or the agent a new
 * chat will have.
 */
export type VoicePrivacy = (scope: {
  spaceId: string;
  agentId: string | null;
  conversationId: string | null;
}) => Promise<VoicePrivacyReason>;

/** The privacy router's answer: the same marks the model gateway and web reads follow. */
export function voicePrivacyFrom(router: PrivacyRouter): VoicePrivacy {
  return async ({ spaceId, agentId, conversationId }) => {
    if (await router.marksPrivate(spaceId, agentId)) return 'private';
    if (conversationId && (await router.store.conversation(conversationId)).sensitive)
      return 'sensitive';
    return null;
  };
}

const CLOUD =
  'Voice sends what you say, and the replies it reads aloud, to ElevenLabs, a cloud speech service.';

/** What the person is told, per reason. A check that fails keeps voice off. */
const OFF_HERE: Record<'private' | 'sensitive' | 'unchecked', string> = {
  private: `Voice is off here because this space or its agent is marked private. ${CLOUD}`,
  sensitive: `Voice is off in this conversation because it looks like it is about a sensitive topic. ${CLOUD}`,
  unchecked: `Voice is off for now because Melete could not check this conversation’s privacy settings. ${CLOUD}`,
};

export function voiceProvidersFromEnv(env: Env): VoiceProviders {
  const configured = capabilitiesFromEnv({
    ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: env.ELEVENLABS_VOICE_ID,
    ELEVENLABS_SECOND_VOICE_ID: env.ELEVENLABS_SECOND_VOICE_ID,
    ELEVENLABS_SPEECH_MODEL: env.ELEVENLABS_SPEECH_MODEL,
    ELEVENLABS_STREAMING_MODEL: env.ELEVENLABS_STREAMING_MODEL,
    ELEVENLABS_TRANSCRIPTION_MODEL: env.ELEVENLABS_TRANSCRIPTION_MODEL,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
    MELETE_ENABLE_FAKE_PROVIDER: String(env.MELETE_ENABLE_FAKE_PROVIDER),
  });
  return { transcription: configured.transcription, live: configured.live };
}

export const voiceLimitsFromEnv = (env: Env): VoiceLimits => ({
  seconds: env.MELETE_VOICE_DAILY_SECONDS,
  characters: env.MELETE_VOICE_DAILY_CHARACTERS,
  sessions: env.MELETE_VOICE_DAILY_SESSIONS,
  asides: DAILY_ASIDES,
});

/** The recording types push-to-talk reads, and the file name the provider is given. */
const CLIP_NAMES: Record<string, string> = {
  'audio/webm': 'clip.webm',
  'audio/ogg': 'clip.ogg',
  'audio/mp4': 'clip.m4a',
  'audio/mpeg': 'clip.mp3',
  'audio/wav': 'clip.wav',
  'audio/x-wav': 'clip.wav',
  'audio/wave': 'clip.wav',
};

/** A recorder's own count of its length can run a little past where it was stopped. */
const DURATION_GRACE_MS = 1000;

const unavailable = () =>
  new ServiceError('voice_unavailable', 'Voice is not set up on this installation.', 404);

const DAILY: Record<VoiceUsageKind, string> = {
  transcribe: 'You have used today’s allowance for voice messages. It frees up over the next day.',
  speech: 'You have used today’s allowance for replies read aloud. It frees up over the next day.',
  session: 'You have used today’s allowance of voice conversations. It frees up over the next day.',
  aside:
    'You have used today’s allowance for talking while Melete works. It frees up over the next day.',
};

const providerFailed = (what: string) =>
  new ServiceError(
    'voice_provider_failed',
    `The speech service could not ${what} just now. Try again in a moment.`,
    502,
  );

/**
 * A refused key stops Speech and Transcription as surely as voice: the default
 * rows for both read the same key, so they are shown failing at once rather
 * than Connected until someone presses Test. A passing Test sets them back.
 */
async function markSpeechFailing(db: Database) {
  try {
    await db
      .update(connection)
      .set({ health: 'failing', lastCheckedAt: new Date() })
      .where(
        and(
          eq(connection.provider, 'generation'),
          eq(connection.status, 'active'),
          ne(connection.health, 'failing'),
          inArray(sql`${connection.configuration}->>'builtin'`, ['generation', 'transcription']),
        ),
      );
  } catch {
    process.stderr.write('voice: speech connections could not be marked failing\n');
  }
}

/** Whether a space's speech connections passed their last check, by what each serves. */
export type SpeechHealth = (
  spaceId: string,
) => Promise<{ speech: boolean; transcription: boolean }>;

/**
 * Read from the space's own Voice and Voice to text rows: one whose last check
 * failed, as a refused key leaves both, is not offered until a passing Test
 * sets it back. A space without the rows, or a read that fails, is not held back.
 */
export function speechHealthFrom(db: Database): SpeechHealth {
  return async (spaceId) => {
    const builtin = sql<string>`${connection.configuration}->>'builtin'`;
    const rows = await db
      .select({ builtin, health: connection.health })
      .from(connection)
      .where(
        and(
          eq(connection.spaceId, spaceId),
          eq(connection.provider, 'generation'),
          eq(connection.status, 'active'),
          inArray(builtin, ['generation', 'transcription']),
        ),
      );
    const failing = (key: string) =>
      rows.some((row) => row.builtin === key && row.health === 'failing');
    return { speech: !failing('generation'), transcription: !failing('transcription') };
  };
}

export function mountVoice(
  app: Hono,
  deps: {
    db: Database;
    allowance: VoiceAllowance | undefined;
    providers: VoiceProviders;
    limits: VoiceLimits;
    /** Required: a route that sends words to the provider must know where it is. */
    privacy: VoicePrivacy;
    /** The light conversation alongside a running turn. Left out, asides are not offered. */
    companion?: VoiceCompanion | null;
    /** What the companion is shown of a conversation. Left out, read from the database. */
    context?: (conversationId: string, agentId: string | null) => Promise<CompanionContext>;
    /** The clock the aside rate limit reads; tests supply one. */
    now?: () => number;
    /** Whether the speech connections are working. Left out, read from the database. */
    speechHealth?: SpeechHealth;
  },
): void {
  const { db, allowance, providers, limits, privacy } = deps;
  const now = deps.now ?? Date.now;
  /** When each person's recent asides were asked, held in memory only. */
  const asides = new Map<string, number[]>();
  const context = deps.context ?? ((id, agentId) => conversationContext(db, id, agentId));
  const speechHealth = deps.speechHealth ?? speechHealthFrom(db);
  const pushToTalk = Boolean(providers.transcription && allowance);
  const voiceMode = Boolean(providers.live && allowance);

  /** The session space and the person, as the conversation routes read them. */
  const caller = (c: Context) => {
    const spaceId = c.get('experienceSpaceId');
    const principalId = c.get('owner')?.id;
    if (!spaceId || !principalId)
      throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
    return { spaceId, principalId };
  };

  /** The caller's own conversation in the session space, or not found. */
  const findConversation = async (spaceId: string, principalId: string, id: string) => {
    const [row] = await db
      .select({ id: job.id, agentId: job.agentId })
      .from(job)
      .where(
        and(
          eq(job.id, id),
          eq(job.spaceId, spaceId),
          eq(job.kind, 'chat'),
          ownJob(job.principalId, principalId),
        ),
      );
    if (!row) throw new ServiceError('not_found', 'That item is not here.', 404);
    return { conversationId: row.id, agentId: row.agentId ?? null };
  };

  const conversation = async (c: Context) => {
    const { spaceId, principalId } = caller(c);
    const found = await findConversation(spaceId, principalId, c.req.param('id') ?? '');
    return { spaceId, principalId, ...found };
  };

  /**
   * The place a request names: its conversation (whose own agent counts), or
   * the agent a new chat will have, or just the session space.
   */
  const place = async (
    spaceId: string,
    principalId: string,
    query: { conversation_id?: string | undefined; agent_id?: string | undefined },
  ) =>
    query.conversation_id
      ? await findConversation(spaceId, principalId, query.conversation_id)
      : { conversationId: null, agentId: query.agent_id ?? null };

  type Place = { spaceId: string; agentId: string | null; conversationId: string | null };

  /** Why voice is off at this place, as a sentence for the person, or null. */
  const offReason = async (scope: Place): Promise<string | null> => {
    const reason = await privacy(scope).catch(() => 'unchecked' as const);
    return reason ? OFF_HERE[reason] : null;
  };

  /** Refuse before any audio or text is read when the place is kept off cloud services. */
  const refuseWhenPrivate = async (scope: Place) => {
    const reason = await offReason(scope);
    if (reason) throw new ServiceError('voice_private', reason, 403);
  };

  /** Take from the allowance, run the provider call, and give it back if the provider refused. */
  async function metered<T>(
    principalId: string,
    kind: VoiceUsageKind,
    amount: number,
    limit: number,
    what: string,
    call: () => Promise<T>,
  ): Promise<T> {
    if (!allowance) throw unavailable();
    const reservation = await allowance.take(principalId, kind, amount, limit);
    if (!reservation) throw new ServiceError('voice_daily_limit', DAILY[kind], 429);
    try {
      return await call();
    } catch (error) {
      // An answered refusal did no work, so it costs nothing. A call that never
      // came back may have been served, and stays counted.
      if (error instanceof VoiceProviderError && error.status !== null)
        await allowance.giveBack(reservation).catch(() => undefined);
      if (error instanceof VoiceProviderError) {
        // The operator reads why; the person is told only that it failed.
        process.stderr.write(`voice: ${kind} failed: ${error.message}\n`);
        if (error.keyRefused) await markSpeechFailing(db);
        throw providerFailed(what);
      }
      throw error;
    }
  }

  app.get('/voice', async (c) => {
    const { spaceId, principalId } = caller(c);
    const query = voiceContextQuery.safeParse(c.req.query());
    if (!query.success) throw new ServiceError('invalid_request', 'Invalid voice query.', 400);
    const at = await place(spaceId, principalId, query.data);
    // Offered only while it works: a speech service that refused its last check
    // would fail as soon as it was pressed.
    const healthy =
      pushToTalk || voiceMode
        ? await speechHealth(spaceId).catch(() => ({ speech: true, transcription: true }))
        : { speech: false, transcription: false };
    const talk = pushToTalk && healthy.transcription;
    const mode = voiceMode && healthy.speech;
    return c.json(
      voiceStatus.parse({
        push_to_talk: talk,
        voice_mode: mode,
        max_recording_seconds: VOICE_LIMITS.recording_seconds,
        max_recording_bytes: VOICE_LIMITS.recording_bytes,
        off_reason: talk || mode ? await offReason({ spaceId, ...at }) : null,
      }),
    );
  });

  app.post('/voice/transcriptions', async (c) => {
    const { spaceId, principalId } = caller(c);
    const adapter = providers.transcription;
    if (!adapter || !allowance) throw unavailable();
    const tooLarge = () =>
      new ServiceError(
        'recording_too_large',
        `Voice messages can be up to ${VOICE_LIMITS.recording_bytes / (1024 * 1024)} MB. This recording is larger.`,
        413,
      );
    const tooLong = () =>
      new ServiceError(
        'recording_too_long',
        `Voice messages can be up to ${VOICE_LIMITS.recording_seconds / 60} minutes. This recording is longer.`,
        413,
      );
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > VOICE_LIMITS.recording_bytes) throw tooLarge();
    const query = voiceTranscriptionQuery.safeParse(c.req.query());
    if (!query.success)
      throw new ServiceError('invalid_request', 'Say how long the recording is.', 400);
    // Before the body is read: a private place's audio is not even held.
    await refuseWhenPrivate({ spaceId, ...(await place(spaceId, principalId, query.data)) });
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const filename = CLIP_NAMES[type];
    if (!filename)
      throw new ServiceError(
        'recording_unreadable',
        'That recording is not in a format Melete can read.',
        400,
      );
    const limitMs = VOICE_LIMITS.recording_seconds * 1000;
    if (query.data.duration_ms > limitMs + DURATION_GRACE_MS) throw tooLong();
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length > VOICE_LIMITS.recording_bytes) throw tooLarge();
    if (audio.length === 0)
      throw new ServiceError('recording_unreadable', 'That recording is empty.', 400);
    // A WAV states its own length, which is believed over the recorder's count.
    const measured = Math.max(query.data.duration_ms, wavDurationMs(audio) ?? 0);
    if (measured > limitMs + DURATION_GRACE_MS) throw tooLong();
    const seconds = Math.max(1, Math.ceil(measured / 1000));
    const transcript = await metered(
      principalId,
      'transcribe',
      seconds,
      limits.seconds,
      'transcribe that',
      () => adapter.transcribe({ audio, filename, mime: type, diarize: false }, c.req.raw.signal),
    );
    return c.json(
      voiceTranscription.parse({
        text: transcript.text.slice(0, 20_000),
        language: transcript.language?.slice(0, 16) ?? null,
      }),
    );
  });

  app.post('/conversations/:id/voice/session', async (c) => {
    const { principalId, ...scope } = await conversation(c);
    const live = providers.live;
    if (!live || !allowance) throw unavailable();
    await refuseWhenPrivate(scope);
    const opened = await metered(
      principalId,
      'session',
      1,
      limits.sessions,
      'start listening',
      () => live.session(),
    );
    return c.json(voiceSession.parse({ ...opened, sample_rate: REALTIME_SAMPLE_RATE }), 201);
  });

  app.post('/conversations/:id/voice/aside', async (c) => {
    const { principalId, ...scope } = await conversation(c);
    const companion = deps.companion;
    if (!providers.live || !allowance || !companion)
      throw new ServiceError(
        'voice_unavailable',
        'Talking while Melete works is not set up here.',
        404,
      );
    // The same refusal as every voice route: a private place's words go nowhere.
    await refuseWhenPrivate(scope);
    const parsed = voiceAsideRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ServiceError('invalid_request', 'Check the request and try again.', 400);
    const at = now();
    const recent = (asides.get(principalId) ?? []).filter((time) => at - time < ASIDE_WINDOW_MS);
    if (recent.length >= ASIDES_PER_WINDOW)
      throw new ServiceError(
        'voice_aside_limit',
        'That is a lot of talking in a short time. Give it a moment.',
        429,
      );
    recent.push(at);
    asides.set(principalId, recent);
    // Counted against the day like every voice call; a refusal that generated nothing is given back.
    const reservation = await allowance.take(principalId, 'aside', 1, limits.asides);
    if (!reservation) throw new ServiceError('voice_daily_limit', DAILY.aside, 429);
    const known = await context(scope.conversationId, scope.agentId);
    const result = await companion
      .answer({
        spaceId: scope.spaceId,
        conversationId: scope.conversationId,
        principalId,
        request: parsed.data,
        context: known,
        signal: c.req.raw.signal,
      })
      .catch(() => ({ failed: 'unanswered' as const }));
    if ('failed' in result) {
      if (result.failed === 'refused' || result.failed === 'limit')
        await allowance.giveBack(reservation).catch(() => undefined);
      // The person hears when the limit resets, not a general failure.
      if (result.failed === 'limit')
        throw new ServiceError('spending_limit_reached', result.message, 402);
      throw new ServiceError('voice_aside_failed', 'Melete could not answer that just now.', 502);
    }
    return c.json(voiceAside.parse(pointToQuestion(parsed.data, known, result.answer)));
  });

  app.post('/conversations/:id/voice/speech', async (c) => {
    const { principalId, ...scope } = await conversation(c);
    const live = providers.live;
    if (!live || !allowance) throw unavailable();
    await refuseWhenPrivate(scope);
    const { text } = voiceSpeechRequest.parse(await c.req.json().catch(() => null));
    const spoken = await metered(
      principalId,
      'speech',
      text.length,
      limits.characters,
      'read that aloud',
      () => live.speak(text, c.req.raw.signal),
    );
    return new Response(spoken.body, {
      headers: {
        'content-type': spoken.mime,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

/** Asides one person may ask within the window: a word every few seconds, never a flood. */
const ASIDES_PER_WINDOW = 20;
const ASIDE_WINDOW_MS = 60_000;

/**
 * What the companion is shown: the agent's name and the conversation's latest
 * turns, as the chat shows them. The last is the turn that is running.
 */
async function conversationContext(
  db: Database,
  conversationId: string,
  agentId: string | null,
): Promise<CompanionContext> {
  const [named] = agentId
    ? await db.select({ name: agent.name }).from(agent).where(eq(agent.id, agentId))
    : [];
  const rows = await db
    .select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, conversationId))
    .orderBy(desc(experienceTurn.createdAt), desc(experienceTurn.id))
    .limit(COMPANION_LIMITS.turns);
  const [open] = await db
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.jobId, conversationId), eq(question.state, 'open')))
    .limit(1);
  return {
    agentName: named?.name?.trim() || 'Melete',
    asking: open !== undefined,
    turns: rows.reverse().map((row) => ({
      said: row.text,
      answer: (['queued', 'working', 'streaming', 'stalled'].includes(row.status)
        ? answerStream(row.answer)
        : answerText(row.answer)
      ).trim(),
    })),
  };
}
