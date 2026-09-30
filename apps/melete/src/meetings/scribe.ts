/**
 * Transcription with ElevenLabs Scribe, used when the person gave an
 * ElevenLabs key. Scribe fetches the recording itself from Recall's
 * pre-signed address, so the video never passes through this service.
 *
 * Shape from the ElevenLabs reference (elevenlabs.io/docs/api-reference/
 * speech-to-text/convert): `POST https://api.elevenlabs.io/v1/speech-to-text`,
 * `multipart/form-data` with `model_id`, `source_url` and `diarize`, the key in
 * `xi-api-key`; the answer carries `words`, each with `text`, `start`, `type`
 * and, when diarized, `speaker_id`.
 */
import { z } from 'zod';
import { type Fetcher, RecallError, type Utterance } from './recall.ts';

export const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const SCRIBE_MODEL = 'scribe_v1';
/** A long meeting takes a while to transcribe; the call is answered when it is done. */
const SCRIBE_TIMEOUT_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const scribeReply = z.object({
  words: z.array(
    z.object({
      text: z.string(),
      start: z.number().nullish(),
      type: z.string().nullish(),
      speaker_id: z.string().nullish(),
    }),
  ),
});

/** Why Scribe could not transcribe, told apart from Recall's own failures. */
export class ScribeError extends RecallError {
  override name = 'ScribeError';
}

export async function transcribeWithScribe(
  key: string,
  recordingUrl: string,
  fetcher: Fetcher = fetch,
): Promise<Utterance[]> {
  const form = new FormData();
  form.set('model_id', SCRIBE_MODEL);
  form.set('source_url', recordingUrl);
  form.set('diarize', 'true');
  form.set('tag_audio_events', 'false');
  let response: Response;
  try {
    response = await fetcher(SCRIBE_URL, {
      method: 'POST',
      headers: { 'xi-api-key': key, accept: 'application/json' },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new ScribeError(null, 'ElevenLabs could not be reached');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ScribeError(response.status, `ElevenLabs answered ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ScribeError(response.status, 'the transcript was larger than expected');
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES)
    throw new ScribeError(response.status, 'the transcript was larger than expected');
  let parsed: z.infer<typeof scribeReply>;
  try {
    parsed = scribeReply.parse(JSON.parse(text));
  } catch {
    throw new ScribeError(response.status, 'the transcript was not in the expected form');
  }
  return fromScribe(parsed.words);
}

/** Consecutive words from one speaker make one turn; spacing tokens keep their spaces. */
export function fromScribe(words: z.infer<typeof scribeReply>['words']): Utterance[] {
  const turns: Utterance[] = [];
  const labels = new Map<string, string>();
  let current: (Utterance & { id: string }) | null = null;
  for (const word of words) {
    if (word.type === 'audio_event') continue;
    const id = word.speaker_id ?? 'speaker';
    if (!current || (word.type !== 'spacing' && id !== current.id)) {
      if (current?.text.trim()) turns.push({ ...current, text: current.text.trim() });
      if (!labels.has(id)) labels.set(id, `Speaker ${labels.size + 1}`);
      current = {
        id,
        speaker: labels.get(id) ?? 'Speaker',
        start: word.start ?? null,
        text: '',
      };
      if (word.type === 'spacing') continue;
    }
    current.text += word.type === 'spacing' ? ' ' : word.text;
  }
  if (current?.text.trim()) turns.push({ ...current, text: current.text.trim() });
  return turns.map(({ speaker, start, text }) => ({
    speaker,
    start,
    text: text.replace(/\s+/g, ' '),
  }));
}
