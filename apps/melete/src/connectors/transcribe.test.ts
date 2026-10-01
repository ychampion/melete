import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action } from '@melete/contracts';
import { canonicalizePayload } from '@melete/contracts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import {
  clock,
  createTranscriptionConnector,
  fakeTranscriptionAdapter,
  mediaTypeFor,
  TRANSCRIPT_MIME,
  transcriptionCapability,
  transcriptMarkdown,
} from './transcribe.ts';
import type { ConnectorContext } from './types.ts';
import { silentWav } from './wav.ts';

const JOB = 'job_01J00000000000000000000000';
const SPACE = 'sp_01J00000000000000000000000';
const script = 'A: Did the refund arrive?\nB: Not yet, I will chase it.';
const directories: string[] = [];

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'melete-transcribe-'));
  directories.push(root);
  const workRoot = join(root, 'work');
  const spacesRoot = join(root, 'spaces');
  await mkdir(join(workRoot, JOB), { recursive: true });
  await mkdir(spacesRoot, { recursive: true });
  return { workRoot, spacesRoot };
}

const context = (actionId: string): ConnectorContext => ({
  job_id: JOB,
  space_id: SPACE,
  idempotency_key: actionId,
  constraints: { deliverable: { kind: 'none' }, allowed_domains: [], public_compartment: false },
});

const proposal = (actionId: string, payload: Record<string, unknown>): Action => {
  const canonical = canonicalizePayload(payload);
  return {
    id: actionId,
    job_id: JOB,
    attempt_id: 'att_01J00000000000000000000000',
    connection_id: 'conn_01J00000000000000000000000',
    kind: 'audio.transcribe',
    effect_class: 'spend',
    canonical_payload: canonical.canonical,
    payload_hash: canonical.hash,
    intent_key: null,
    status: 'admitted',
    authorization_ref: null,
    budget_reservation: null,
    idempotency_key: actionId,
    dispatched_at: null,
    receipt: null,
    resolved_at: null,
    reconciliation: null,
    repair_trace: [],
    repair_counters: {},
    repair_disposition: null,
    retry_after_at: null,
    created_at: new Date().toISOString(),
  };
};

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

describe('the fake transcription adapter', () => {
  test('reads back the script a fake speech file carries, with two speakers', async () => {
    const transcript = await fakeTranscriptionAdapter.transcribe({
      audio: silentWav({ script }),
      filename: 'call.wav',
      mime: 'audio/wav',
      diarize: true,
    });
    expect(transcript.text).toBe('Did the refund arrive? Not yet, I will chase it.');
    expect(new Set(transcript.words.map((word) => word.speaker))).toEqual(
      new Set(['speaker_A', 'speaker_B']),
    );
    // Deterministic: the same file gives the same words.
    expect(
      await fakeTranscriptionAdapter.transcribe({
        audio: silentWav({ script }),
        filename: 'call.wav',
        mime: 'audio/wav',
        diarize: true,
      }),
    ).toEqual(transcript);
  });

  test('without speaker labels asked for, no word names a speaker', async () => {
    const transcript = await fakeTranscriptionAdapter.transcribe({
      audio: silentWav({ script: 'Remind me to call Sam.' }),
      filename: 'clip.wav',
      mime: 'audio/wav',
      diarize: false,
    });
    expect(transcript.text).toBe('Remind me to call Sam.');
    expect(transcript.words.every((word) => word.speaker === null)).toBe(true);
  });
});

describe('the transcript a person reads', () => {
  test('numbers speakers in order of first speech and times each turn', () => {
    const text = transcriptMarkdown(
      {
        language: 'en',
        text: 'Hi. Hello. Bye.',
        words: [
          { text: 'Hi.', start: 1, end: 1.5, speaker: 'speaker_7' },
          { text: 'Hello.', start: 65, end: 66, speaker: 'speaker_2' },
          { text: 'Bye.', start: 3700, end: 3701, speaker: 'speaker_7' },
        ],
      },
      'call.mp3',
      'scribe_v2',
    );
    expect(text).toBe(
      [
        '# Transcript of call.mp3',
        '',
        'Language: en. Transcribed with scribe_v2.',
        '',
        '**Speaker 1** · 0:01',
        'Hi.',
        '',
        '**Speaker 2** · 1:05',
        'Hello.',
        '',
        '**Speaker 1** · 1:01:40',
        'Bye.',
        '',
      ].join('\n'),
    );
  });

  test('silence is said out loud rather than left as an empty file', () => {
    expect(transcriptMarkdown({ language: null, text: '', words: [] }, 'a.wav', 'm')).toContain(
      '(No speech was found in this recording.)',
    );
  });

  test('clock and media types', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(59.9)).toBe('0:59');
    expect(clock(3600)).toBe('1:00:00');
    expect(mediaTypeFor('Interview.MP3')).toBe('audio/mpeg');
    expect(mediaTypeFor('talk.mp4')).toBe('video/mp4');
    expect(mediaTypeFor('notes.txt')).toBeNull();
  });
});

describe('the transcription capability', () => {
  test('is a spend that produces Markdown, absent without an adapter', () => {
    const manifest = transcriptionCapability(fakeTranscriptionAdapter, 'fake', 0.2);
    expect(manifest.kind).toBe('audio.transcribe');
    expect(manifest.effect_class).toBe('spend');
    expect(manifest.produces).toBe(TRANSCRIPT_MIME);
    expect(manifest.unit_cost_usd).toBe(0.2);
    expect(transcriptionCapability(null, 'none', 0).available).toBe(false);
  });

  test('ElevenLabs is preferred when its key is set, and carries voice mode', () => {
    const eleven = capabilitiesFromEnv({ ELEVENLABS_API_KEY: 'k', OPENAI_API_KEY: 'o' });
    expect(eleven.provider).toBe('elevenlabs');
    expect(eleven.manifests.map((manifest) => manifest.kind)).toEqual([
      'audio.synthesize',
      'audio.transcribe',
    ]);
    expect(eleven.live).not.toBeNull();
    const openai = capabilitiesFromEnv({ OPENAI_API_KEY: 'o' });
    expect(openai.provider).toBe('openai');
    expect(openai.transcription).toBeNull();
    expect(openai.live).toBeNull();
    const fake = capabilitiesFromEnv({ MELETE_ENABLE_FAKE_PROVIDER: 'true' });
    expect(fake.transcription).toBe(fakeTranscriptionAdapter);
    expect(fake.live).toBeNull();
    const none = capabilitiesFromEnv({ ELEVENLABS_API_KEY: '  ' });
    expect(none.manifests).toEqual([]);
  });
});

describe('the transcription connector', () => {
  test('transcribes a recording from the workspace into the space artifacts', async () => {
    const { workRoot, spacesRoot } = await roots();
    await mkdir(join(workRoot, JOB, 'calls'));
    await writeFile(join(workRoot, JOB, 'calls', 'refund.wav'), silentWav({ script }));
    const connector = createTranscriptionConnector({
      workRoot,
      spacesRoot,
      adapter: fakeTranscriptionAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J00000000000000000000001';
    const action = proposal(actionId, { source: 'calls/refund.wav', path: 'refund-transcript' });
    const result = await connector.execute(action, context(actionId));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.receipt.detail).toMatchObject({
      kind: 'artifact',
      path: 'artifacts/refund-transcript.md',
      mime: 'text/markdown',
      model: 'fake-stt-v1',
    });
    const written = await readFile(
      join(spacesRoot, SPACE, 'artifacts', 'refund-transcript.md'),
      'utf8',
    );
    expect(written).toContain('# Transcript of refund.wav');
    expect(written).toContain('**Speaker 1** · 0:00\nDid the refund arrive?');
    expect(written).toContain('**Speaker 2**');
    expect(connector.capability?.kind).toBe('audio.transcribe');
  });

  test('reads a recording from the space artifacts, and verify reads the transcript back', async () => {
    const { workRoot, spacesRoot } = await roots();
    await mkdir(join(spacesRoot, SPACE, 'artifacts'), { recursive: true });
    await writeFile(join(spacesRoot, SPACE, 'artifacts', 'episode.wav'), silentWav({ script }));
    const options = { workRoot, spacesRoot, adapter: fakeTranscriptionAdapter, provider: 'fake' };
    const actionId = 'act_01J00000000000000000000002';
    const action = proposal(actionId, {
      source: 'episode.wav',
      area: 'artifacts',
      path: 'episode.md',
    });
    const ctx = context(actionId);
    expect((await createTranscriptionConnector(options).verify(action, ctx)).decision).toBe(
      'undecided',
    );
    const executed = await createTranscriptionConnector(options).execute(action, ctx);
    const verified = await createTranscriptionConnector(options).verify(action, ctx);
    expect(verified.decision).toBe('succeeded');
    if (verified.decision !== 'succeeded' || executed.outcome !== 'succeeded') return;
    expect(verified.receipt).toEqual(executed.receipt);
    // A changed transcript no longer confirms the action.
    await writeFile(join(spacesRoot, SPACE, 'artifacts', 'episode.md'), 'edited');
    expect((await createTranscriptionConnector(options).verify(action, ctx)).decision).toBe(
      'undecided',
    );
  });

  test('a file that is not a recording, a path outside the area, and a bad name are refused', async () => {
    const { workRoot, spacesRoot } = await roots();
    await writeFile(join(workRoot, JOB, 'notes.txt'), 'hello');
    const connector = createTranscriptionConnector({
      workRoot,
      spacesRoot,
      adapter: fakeTranscriptionAdapter,
      provider: 'fake',
    });
    const refused = async (payload: Record<string, unknown>) => {
      const actionId = 'act_01J00000000000000000000003';
      await expect(
        connector.execute(proposal(actionId, payload), context(actionId)),
      ).rejects.toThrow();
    };
    await refused({ source: 'notes.txt', path: 'out.md' });
    await refused({ source: '../other/call.wav', path: 'out.md' });
    await refused({ source: 'missing.wav', path: 'out.md' });
    await writeFile(join(workRoot, JOB, 'call.wav'), silentWav({ script }));
    await refused({ source: 'call.wav', path: '../escape.md' });
  });

  test('with no adapter it fails honestly and reports itself degraded', async () => {
    const { workRoot, spacesRoot } = await roots();
    const connector = createTranscriptionConnector({
      workRoot,
      spacesRoot,
      adapter: null,
      provider: 'none',
    });
    const actionId = 'act_01J00000000000000000000004';
    const result = await connector.execute(
      proposal(actionId, { source: 'call.wav', path: 'out.md' }),
      context(actionId),
    );
    expect(result.outcome).toBe('failed');
    expect((await connector.health()).status).toBe('degraded');
    expect(connector.capability?.available).toBe(false);
  });
});
