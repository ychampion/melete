/**
 * Speech to text, as a capability.
 *
 * `audio.transcribe` reads an audio or video file that is already in the
 * space's files and writes a transcript beside the other artifacts: Markdown,
 * with each speaker's turns labelled and timed. It is a `spend` like speech,
 * so it takes the same path: one action, an approval bound to the payload
 * hash, a budget reservation, a receipt persisted before the runtime hears
 * anything, and a verify that reads the transcript back.
 *
 * The fake adapter reads the script a fake speech file carries, so a round
 * trip (speak a script, then transcribe the file) is a real test with no key
 * and no network. The real adapter is ElevenLabs Scribe (elevenlabs.ts).
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  Action,
  CapabilityManifest,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonValue,
  Receipt,
  VerifyResult,
} from '@melete/contracts';
import {
  artifactIdForAction,
  canonicalizePayload,
  capabilityTool,
  receipt,
} from '@melete/contracts';
import { z } from 'zod';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { noLinks, segmentsFor } from './files.ts';
import { atomicWrite, capabilityDirectory, digest, readBytes } from './tts.ts';
import type { Connector, ConnectorContext } from './types.ts';
import { scriptFromWav, spokenDurationMs } from './wav.ts';

export const TRANSCRIPT_MIME = 'text/markdown';
/** The largest file one call reads. The provider accepts more; the service holds it in memory. */
export const TRANSCRIBE_MAX_BYTES = 100 * 1024 * 1024;

export type TranscriptWord = { text: string; start: number; end: number; speaker: string | null };
export type Transcript = { language: string | null; text: string; words: TranscriptWord[] };
export type TranscriptionRequest = {
  audio: Uint8Array;
  filename: string;
  mime: string;
  /** Label who is speaking. A short push-to-talk clip has one speaker and skips it. */
  diarize: boolean;
  language?: string;
  speakers?: number;
};
/** What an adapter has to do: bytes in, words out. Nothing about files or rows. */
export type TranscriptionAdapter = {
  model: string;
  transcribe(request: TranscriptionRequest, signal?: AbortSignal): Promise<Transcript>;
};

/** The recordings and videos a transcription reads, by extension. */
export const MEDIA_TYPES: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
};

export const mediaTypeFor = (name: string): string | null =>
  MEDIA_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? null;

const transcribeSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', minLength: 1, maxLength: 400 },
    area: { type: 'string', enum: ['work', 'artifacts'] },
    path: { type: 'string', minLength: 1, maxLength: 200 },
    language: { type: 'string', pattern: '^[a-z]{2,3}$' },
    speakers: { type: 'integer', minimum: 1, maximum: 32 },
  },
  required: ['source', 'path'],
  additionalProperties: false,
} as const;

/**
 * The fake adapter: deterministic words for one file. A WAV the fake speech
 * adapter wrote gives back its script, with `A:`/`B:` line prefixes read as
 * two speakers; any other file gives one fixed sentence naming its size.
 */
export const fakeTranscriptionAdapter: TranscriptionAdapter = {
  model: 'fake-stt-v1',
  async transcribe(request) {
    const script = scriptFromWav(request.audio) ?? `A recording of ${request.audio.length} bytes.`;
    const words: TranscriptWord[] = [];
    let at = 0;
    for (const line of script.split('\n')) {
      const labelled = /^([A-Z]):\s*(.*)$/.exec(line.trim());
      const speaker = request.diarize ? (labelled ? `speaker_${labelled[1]}` : 'speaker_0') : null;
      for (const text of (labelled?.[2] ?? line).split(/\s+/u).filter(Boolean)) {
        const length = spokenDurationMs(text) / 1000 / 2.5;
        words.push({ text, start: at, end: at + length, speaker });
        at += length;
      }
    }
    return { language: 'en', text: words.map((word) => word.text).join(' '), words };
  },
};

export const transcriptionCapability = (
  adapter: TranscriptionAdapter | null,
  provider: string,
  unitCostUsd: number,
): CapabilityManifest => ({
  kind: 'audio.transcribe',
  provider,
  model: adapter?.model ?? 'unconfigured',
  description:
    'Transcribe an audio or video file from the space files and write the transcript, with speakers and times, into the space artifacts.',
  effect_class: 'spend',
  unit_cost_usd: unitCostUsd,
  produces: TRANSCRIPT_MIME,
  input_schema: transcribeSchema,
  required_scopes: ['audio.transcribe'],
  available: adapter !== null,
});

/** `m:ss`, or `h:mm:ss` past the hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** A new paragraph starts when the speaker changes, or after this long from one speaker. */
const PARAGRAPH_SECONDS = 60;

/**
 * The transcript as a person reads it. Speakers are numbered in the order they
 * first speak, because the provider's labels are arbitrary. Without word
 * timings the text is written as one block.
 */
export function transcriptMarkdown(transcript: Transcript, source: string, model: string): string {
  const lines = [`# Transcript of ${source}`, ''];
  lines.push(
    `${transcript.language ? `Language: ${transcript.language}. ` : ''}Transcribed with ${model}.`,
    '',
  );
  if (transcript.words.length === 0) {
    lines.push(transcript.text || '(No speech was found in this recording.)', '');
    return lines.join('\n');
  }
  const numbers = new Map<string, number>();
  let speaker: string | null | undefined;
  let started = 0;
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const label = speaker ? `Speaker ${numbers.get(speaker)}` : 'Speaker';
    lines.push(`**${label}** · ${clock(started)}`, paragraph.join(' '), '');
    paragraph = [];
  };
  for (const word of transcript.words) {
    if (word.speaker && !numbers.has(word.speaker)) numbers.set(word.speaker, numbers.size + 1);
    if (word.speaker !== speaker || word.start - started >= PARAGRAPH_SECONDS) {
      flush();
      speaker = word.speaker;
      started = word.start;
    }
    paragraph.push(word.text);
  }
  flush();
  return lines.join('\n');
}

const requiredString = (payload: Record<string, JsonValue>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a string`);
  return value;
};

/** A file name, not a path: the transcript lands in the space artifacts root. */
function transcriptName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value) || value.includes('..'))
    throw new Error('path must be a simple file name');
  return value.endsWith('.md') ? value : `${value}.md`;
}

const transcriptEvidence = z.object({
  version: z.literal(1),
  space_id: z.string(),
  job_id: z.string(),
  payload_hash: z.string(),
  receipt,
});

export type TranscriptionConnectorOptions = {
  workRoot: string;
  spacesRoot: string;
  adapter: TranscriptionAdapter | null;
  provider: string;
  unitCostUsd?: number;
};

export function createTranscriptionConnector(options: TranscriptionConnectorOptions): Connector {
  const capability = transcriptionCapability(
    options.adapter,
    options.provider,
    options.unitCostUsd ?? 0,
  );
  const manifest: ConnectorManifest = {
    name: 'generation',
    version: '0.1.0',
    provider: 'generation',
    description: 'Transcription through the configured speech provider.',
    credentials: [],
    health: true,
    tools: [capabilityTool(capability)],
  };

  const target = async (ctx: ConnectorContext, name: string) =>
    path.join(await capabilityDirectory(options.spacesRoot, ctx, null), transcriptName(name));
  const evidenceFile = async (action: Action, ctx: ConnectorContext) => {
    if (!/^act_[A-Za-z0-9]+$/.test(action.id)) throw new Error('invalid action identity');
    const directory = await capabilityDirectory(options.spacesRoot, ctx, '.transcript-receipts');
    return path.join(directory, `${action.id}.json`);
  };
  /** The source, from the job's workspace or the space artifacts, with every component checked. */
  const source = async (ctx: ConnectorContext, relative: string, area: string) => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id) || !/^sp_[A-Za-z0-9]+$/.test(ctx.space_id))
      throw new Error('invalid trusted file scope');
    const mime = mediaTypeFor(relative);
    if (!mime) throw new Error('source must be an audio or video file');
    const file =
      area === 'artifacts'
        ? await noLinks(
            await realpath(options.spacesRoot),
            [ctx.space_id, 'artifacts', ...segmentsFor(relative)],
            false,
          )
        : await new LocalWorkspaceFs(options.workRoot).resolve(ctx.job_id, relative, false);
    const bytes = await readBytes(file);
    if (!bytes) throw new Error('source file was not found');
    if (bytes.length > TRANSCRIBE_MAX_BYTES) throw new Error('source file is larger than 100 MB');
    return { bytes, mime, name: path.basename(file) };
  };

  return {
    manifest,
    capability,
    async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
      if (!options.adapter)
        return { outcome: 'failed', reason: 'no speech provider is configured', retryable: false };
      if (action.id !== ctx.idempotency_key || action.job_id !== ctx.job_id)
        throw new Error('connector action identity mismatch');
      const payload = action.canonical_payload;
      const name = requiredString(payload, 'path');
      const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
      const media = await source(ctx, requiredString(payload, 'source'), area);
      const transcript = await options.adapter.transcribe(
        {
          audio: media.bytes,
          filename: media.name,
          mime: media.mime,
          diarize: true,
          ...(typeof payload.language === 'string' ? { language: payload.language } : {}),
          ...(typeof payload.speakers === 'number' ? { speakers: payload.speakers } : {}),
        },
        ctx.signal,
      );
      const bytes = new TextEncoder().encode(
        transcriptMarkdown(transcript, media.name, options.adapter.model),
      );
      await atomicWrite(await target(ctx, name), bytes);
      const hash = digest(bytes);
      const proof: Receipt = {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: hash,
        detail: {
          kind: 'artifact',
          artifact_id: artifactIdForAction(action.id),
          path: `artifacts/${transcriptName(name)}`,
          mime: TRANSCRIPT_MIME,
          bytes: bytes.length,
          content_hash: hash,
          model: options.adapter.model,
          provider: capability.provider,
          source_hash: digest(media.bytes),
        },
        received_at: new Date().toISOString(),
        late: false,
      };
      // Evidence is published only after the whole transcript is named, as for speech.
      await atomicWrite(
        await evidenceFile(action, ctx),
        Buffer.from(
          JSON.stringify({
            version: 1,
            space_id: ctx.space_id,
            job_id: action.job_id,
            payload_hash: action.payload_hash,
            receipt: proof,
          }),
        ),
      );
      return { outcome: 'succeeded', receipt: proof };
    },
    async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
      const undecided = {
        decision: 'undecided',
        reason: 'No matching action-bound transcript evidence',
      } as const;
      if (action.id !== ctx.idempotency_key || action.job_id !== ctx.job_id) return undecided;
      const payload = action.canonical_payload;
      const name = typeof payload.path === 'string' ? payload.path : null;
      if (!name) return { decision: 'undecided', reason: 'the action names no file' };
      const bytes = await readBytes(await target(ctx, name));
      const saved = await readBytes(await evidenceFile(action, ctx));
      if (!bytes || !saved) return undecided;
      let evidence: z.infer<typeof transcriptEvidence>;
      try {
        evidence = transcriptEvidence.parse(JSON.parse(Buffer.from(saved).toString('utf8')));
      } catch {
        return undecided;
      }
      const proof = evidence.receipt;
      const hash = digest(bytes);
      if (
        evidence.space_id !== ctx.space_id ||
        evidence.job_id !== action.job_id ||
        evidence.payload_hash !== action.payload_hash ||
        canonicalizePayload(payload).hash !== action.payload_hash ||
        proof.action_id !== action.id ||
        proof.connection_id !== action.connection_id ||
        proof.detail.path !== `artifacts/${transcriptName(name)}` ||
        proof.detail.content_hash !== hash ||
        proof.external_ref !== hash ||
        proof.detail.bytes !== bytes.length
      )
        return undecided;
      return {
        decision: 'succeeded',
        evidence: { present: true, action_id: action.id, content_hash: hash, bytes: bytes.length },
        receipt: proof,
      };
    },
    async health(): Promise<ConnectorHealth> {
      return {
        status: options.adapter ? 'ok' : 'degraded',
        detail: options.adapter
          ? `${capability.kind} via ${capability.provider}/${options.adapter.model}`
          : 'no speech provider is configured',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
