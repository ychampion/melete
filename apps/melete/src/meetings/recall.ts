/**
 * The Recall.ai meeting bot API, as far as a notetaker needs it.
 *
 * Shapes follow Recall's reference (docs.recall.ai): `POST /api/v1/bot/`
 * creates a bot from `meeting_url`, `bot_name`, an optional `join_at`,
 * `recording_config` and `chat.on_bot_join`; `GET /api/v1/bot/{id}/` answers
 * with `status_changes` and `recordings`, whose `media_shortcuts` carry the
 * transcript and the mixed video with a pre-signed `data.download_url`. The key
 * goes in the `Authorization` header, with no prefix, against the regional
 * host `https://<region>.recall.ai`.
 *
 * Nothing here decides anything about the meeting's content: it moves bytes
 * and says, in a closed set of states, where the notetaker has got.
 */
import type { RecallRegion } from '@melete/contracts';
import { z } from 'zod';

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Recall's hosts, by region. A region outside this list is refused by the contract first. */
export const recallBase = (region: RecallRegion) => `https://${region}.recall.ai`;

/** A transcript larger than this is not a meeting anyone can read back. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** Why a call to Recall did not answer as hoped, with the status when there was one. */
export class RecallError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'RecallError';
  }
  /** The key was refused: every later call will be too. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type CreateBotRequest = {
  meeting_url: string;
  bot_name: string;
  join_at?: string;
  /** Recall transcribes the call itself, or only the mixed video is kept for Scribe. */
  transcription: 'recall' | 'recording';
  /** Posted in the meeting chat as the notetaker joins. */
  announcement: string;
  /** Carried back on webhooks; names the approval the notetaker came from. */
  metadata: Record<string, string>;
};

/** The request body Recall's create-bot endpoint takes. */
export function createBotBody(request: CreateBotRequest) {
  return {
    meeting_url: request.meeting_url,
    bot_name: request.bot_name,
    ...(request.join_at ? { join_at: request.join_at } : {}),
    recording_config:
      request.transcription === 'recall'
        ? { transcript: { provider: { recallai_streaming: { mode: 'prioritize_accuracy' } } } }
        : { video_mixed_mp4: {} },
    // Meet and Teams only take `everyone`, and Meet holds a chat message to 500 characters.
    chat: { on_bot_join: { send_to: 'everyone', message: request.announcement.slice(0, 500) } },
    metadata: request.metadata,
  };
}

const mediaShortcut = z
  .object({
    status: z.object({ code: z.string() }).partial().nullish(),
    data: z.object({ download_url: z.string().nullish() }).partial().nullish(),
  })
  .partial()
  .nullish();
const recallBot = z.object({
  id: z.string().min(1),
  status_changes: z
    .array(
      z.object({
        code: z.string(),
        sub_code: z.string().nullish(),
        created_at: z.string().nullish(),
      }),
    )
    .nullish(),
  recordings: z
    .array(
      z.object({
        id: z.string().nullish(),
        status: z.object({ code: z.string() }).partial().nullish(),
        media_shortcuts: z
          .object({ transcript: mediaShortcut, video_mixed: mediaShortcut })
          .partial()
          .nullish(),
      }),
    )
    .nullish(),
});
export type RecallBot = z.infer<typeof recallBot>;

/**
 * Where a notetaker has got, read from its newest status. Recall says its codes
 * may grow, so anything unrecognised is simply "not finished yet".
 */
export type BotProgress =
  | { state: 'waiting' }
  | { state: 'done' }
  | { state: 'fatal'; sub_code: string | null };

export function botProgress(bot: RecallBot): BotProgress {
  const latest = bot.status_changes?.at(-1);
  if (latest?.code === 'done') return { state: 'done' };
  if (latest?.code === 'fatal') return { state: 'fatal', sub_code: latest.sub_code ?? null };
  return { state: 'waiting' };
}

/** What the recording offers so far: a finished media file, one still coming, or none. */
export type MediaState =
  | { state: 'ready'; url: string }
  | { state: 'processing' }
  | { state: 'failed' };

export function recordingMedia(bot: RecallBot, key: 'transcript' | 'video_mixed'): MediaState {
  const recordings = bot.recordings ?? [];
  if (!recordings.length) return { state: 'failed' };
  for (const recording of recordings) {
    const media = recording.media_shortcuts?.[key];
    const url = media?.data?.download_url;
    if (media?.status?.code === 'done' && url) return { state: 'ready', url };
  }
  const pending = recordings.some((recording) => {
    const code = recording.media_shortcuts?.[key]?.status?.code ?? recording.status?.code;
    return code === undefined || code === 'processing';
  });
  return pending ? { state: 'processing' } : { state: 'failed' };
}

/** A pre-signed download is only ever fetched over TLS. */
function downloadable(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new RecallError(null, 'the recording address was not a secure download');
  return parsed;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RecallError(response.status, 'the answer was larger than expected');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new RecallError(response.status, 'the answer was larger than expected');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class RecallClient {
  private readonly base: string;

  constructor(
    region: RecallRegion,
    private readonly key: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.base = recallBase(region);
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          authorization: this.key,
        },
      });
    } catch {
      throw new RecallError(null, 'Recall.ai could not be reached');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RecallError(response.status, `Recall.ai answered ${response.status}`);
    }
    const text = await boundedText(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new RecallError(response.status, 'Recall.ai answered with something unreadable');
    }
  }

  /** Create a bot. The answer names the new bot. */
  async createBot(request: CreateBotRequest, signal?: AbortSignal): Promise<RecallBot> {
    const parsed = recallBot.safeParse(
      await this.call('/api/v1/bot/', {
        method: 'POST',
        body: JSON.stringify(createBotBody(request)),
        ...(signal ? { signal } : {}),
      }),
    );
    if (!parsed.success) throw new RecallError(201, 'Recall.ai did not name the new notetaker');
    return parsed.data;
  }

  async retrieveBot(id: string): Promise<RecallBot> {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new RecallError(null, 'not a notetaker id');
    const parsed = recallBot.safeParse(await this.call(`/api/v1/bot/${id}/`));
    if (!parsed.success) throw new RecallError(200, 'Recall.ai described the notetaker oddly');
    return parsed.data;
  }

  /** Whether the key is accepted: one page of one bot, and nothing read from it. */
  async probe(signal?: AbortSignal): Promise<void> {
    await this.call('/api/v1/bot/?page_size=1', signal ? { signal } : {});
  }

  /** Download the finished transcript Recall made of the call. */
  async transcript(url: string): Promise<Utterance[]> {
    let response: Response;
    try {
      response = await this.fetcher(downloadable(url), {
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      if (error instanceof RecallError) throw error;
      throw new RecallError(null, 'the transcript could not be downloaded');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RecallError(response.status, 'the transcript could not be downloaded');
    }
    const parsed = recallTranscript.safeParse(
      JSON.parse(await boundedText(response, MAX_TRANSCRIPT_BYTES)),
    );
    if (!parsed.success) throw new RecallError(200, 'the transcript was not in the expected form');
    return fromRecall(parsed.data);
  }
}

/**
 * One speaker's turn, however it was transcribed. `start` is seconds from the
 * start of the recording.
 */
export type Utterance = { speaker: string; start: number | null; text: string };

const recallTranscript = z.array(
  z.object({
    participant: z.object({ name: z.string().nullish() }).partial().nullish(),
    words: z.array(
      z.object({
        text: z.string(),
        start_timestamp: z.object({ relative: z.number().nullish() }).partial().nullish(),
      }),
    ),
  }),
);

function fromRecall(entries: z.infer<typeof recallTranscript>): Utterance[] {
  return entries.flatMap((entry) => {
    const text = entry.words
      .map((word) => word.text.trim())
      .filter(Boolean)
      .join(' ');
    if (!text) return [];
    return [
      {
        speaker: entry.participant?.name?.trim() || 'Unnamed speaker',
        start: entry.words[0]?.start_timestamp?.relative ?? null,
        text,
      },
    ];
  });
}
