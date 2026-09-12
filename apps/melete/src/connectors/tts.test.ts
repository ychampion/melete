import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action } from '@melete/contracts';
import { canonicalizePayload } from '@melete/contracts';
import {
  createCapabilityConnector,
  fakeSpeechAdapter,
  openAiSpeechAdapter,
  speechCapability,
} from './tts.ts';
import type { ConnectorContext } from './types.ts';
import { scriptFromWav, silentWav, spokenDurationMs, WAV_MIME } from './wav.ts';

const script = 'A: Why did the invoice go overdue?\nB: Because nobody opened the letter.';
const directories: string[] = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'melete-capability-'));
  directories.push(root);
  return root;
}

const context = (spaceId: string, actionId: string): ConnectorContext => ({
  job_id: 'job_01J00000000000000000000000',
  space_id: spaceId,
  idempotency_key: actionId,
  constraints: {
    deliverable: { kind: 'none' },
    allowed_domains: [],
    public_compartment: false,
  },
});

const proposal = (actionId: string, payload: Record<string, unknown>): Action => {
  const canonical = canonicalizePayload(payload);
  return {
    id: actionId,
    job_id: 'job_01J00000000000000000000000',
    attempt_id: 'att_01J00000000000000000000000',
    connection_id: 'conn_01J00000000000000000000000',
    kind: 'audio.synthesize',
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

describe('the silent WAV the fake adapter writes', () => {
  test('is a real RIFF/WAVE file, not a placeholder string', () => {
    const bytes = silentWav({ script });
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE');
    // The declared size matches the bytes that follow it.
    const declared = new DataView(bytes.buffer).getUint32(4, true);
    expect(declared).toBe(bytes.length - 8);
  });

  test('carries the script in its metadata, so a test can read back what was said', () => {
    expect(scriptFromWav(silentWav({ script }))).toBe(script);
  });

  test('a file that is not a WAV yields null rather than a guess', () => {
    expect(scriptFromWav(new TextEncoder().encode('not audio'))).toBeNull();
  });

  test('its length is roughly how long the script takes to read', () => {
    expect(spokenDurationMs('one')).toBe(1000);
    expect(spokenDurationMs('one two three')).toBe(1200);
    expect(spokenDurationMs(Array.from({ length: 300 }, () => 'word').join(' '))).toBe(120_000);
  });
});

describe('the speech capability', () => {
  test('is unavailable when no adapter is configured', () => {
    expect(speechCapability(null, 'none', 0).available).toBe(false);
    expect(speechCapability(fakeSpeechAdapter, 'fake', 0).available).toBe(true);
  });

  test('produces a typed artifact and says what it costs', () => {
    const manifest = speechCapability(fakeSpeechAdapter, 'fake', 0.015);
    expect(manifest.produces).toBe(WAV_MIME);
    expect(manifest.unit_cost_usd).toBe(0.015);
    expect(manifest.effect_class).toBe('spend');
  });
});

describe('the capability connector', () => {
  test('writes a playable artifact and returns a receipt naming its hash', async () => {
    const spacesRoot = await workspace();
    const spaceId = 'sp_01J00000000000000000000000';
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J00000000000000000000000';
    const action = proposal(actionId, { script, path: 'episode-one.wav', voice: 'alto' });
    const result = await connector.execute(action, context(spaceId, actionId));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.receipt.detail).toMatchObject({
      kind: 'artifact',
      path: 'artifacts/episode-one.wav',
      mime: WAV_MIME,
      model: 'fake-tts-v1',
    });
    const written = await readFile(join(spacesRoot, spaceId, 'artifacts', 'episode-one.wav'));
    expect(scriptFromWav(new Uint8Array(written))).toBe(script);
    expect(result.receipt.external_ref).toHaveLength(64);
  });

  test('verify reads the file back, so an unknown dispatch has an answer', async () => {
    const spacesRoot = await workspace();
    const spaceId = 'sp_01J00000000000000000000010';
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J00000000000000000000010';
    const action = proposal(actionId, { script, path: 'episode-two.wav' });
    const ctx = context(spaceId, actionId);
    expect((await connector.verify(action, ctx)).decision).toBe('undecided');
    await connector.execute(action, ctx);
    const verified = await connector.verify(action, ctx);
    expect(verified.decision).toBe('succeeded');
  });

  test('an unrelated target file cannot confirm an action that never executed', async () => {
    const spacesRoot = await workspace();
    const spaceId = 'sp_01J00000000000000000000000';
    const actionId = 'act_01J00000000000000000000000';
    const directory = join(spacesRoot, spaceId, 'artifacts');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'episode.wav'), 'unrelated bytes');
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const result = await connector.verify(
      proposal(actionId, { script, path: 'episode.wav' }),
      context(spaceId, actionId),
    );
    expect(result.decision).toBe('undecided');
  });

  test('an older episode cannot confirm a new action at the same path', async () => {
    const spacesRoot = await workspace();
    const spaceId = 'sp_01J00000000000000000000000';
    const oldId = 'act_01J00000000000000000000001';
    const newId = 'act_01J00000000000000000000002';
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    await connector.execute(
      proposal(oldId, { script: 'Older episode', path: 'episode.wav' }),
      context(spaceId, oldId),
    );
    expect(
      (
        await connector.verify(
          proposal(newId, { script, path: 'episode.wav' }),
          context(spaceId, newId),
        )
      ).decision,
    ).toBe('undecided');
  });

  test('restart verification restores the action-bound receipt and refuses changed bytes or identity', async () => {
    const spacesRoot = await workspace();
    const spaceId = 'sp_01J00000000000000000000000';
    const actionId = 'act_01J00000000000000000000003';
    const options = { spacesRoot, adapter: fakeSpeechAdapter, provider: 'fake' };
    const action = proposal(actionId, { script, path: 'episode.wav' });
    const ctx = context(spaceId, actionId);
    const executed = await createCapabilityConnector(options).execute(action, ctx);
    if (executed.outcome !== 'succeeded') throw new Error('Expected synthesis');
    const restarted = createCapabilityConnector(options);
    const verified = await restarted.verify(action, ctx);
    expect(verified.decision).toBe('succeeded');
    if (verified.decision !== 'succeeded') return;
    expect(verified.receipt).toEqual(executed.receipt);
    const changed = proposal(actionId, { script: 'Different script', path: 'episode.wav' });
    expect((await restarted.verify(changed, ctx)).decision).toBe('undecided');
    expect(
      (await restarted.verify({ ...action, connection_id: 'conn_01J00000000000000000000004' }, ctx))
        .decision,
    ).toBe('undecided');
    expect(
      (await restarted.verify({ ...action, job_id: 'job_01J00000000000000000000004' }, ctx))
        .decision,
    ).toBe('undecided');
    await writeFile(
      join(spacesRoot, spaceId, 'artifacts', 'episode.wav'),
      silentWav({ script: 'Unrelated replacement' }),
    );
    expect((await restarted.verify(action, ctx)).decision).toBe('undecided');
  });

  test('a path that is not a simple file name is refused', async () => {
    const spacesRoot = await workspace();
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J00000000000000000000020';
    const action = proposal(actionId, { script, path: '../escape.wav' });
    await expect(
      connector.execute(action, context('sp_01J00000000000000000000020', actionId)),
    ).rejects.toThrow();
  });

  test('with no adapter it fails honestly instead of writing an empty file', async () => {
    const spacesRoot = await workspace();
    const connector = createCapabilityConnector({ spacesRoot, adapter: null, provider: 'none' });
    const actionId = 'act_01J00000000000000000000030';
    const result = await connector.execute(
      proposal(actionId, { script, path: 'nothing.wav' }),
      context('sp_01J00000000000000000000030', actionId),
    );
    expect(result.outcome).toBe('failed');
    expect((await connector.health()).status).toBe('degraded');
  });
});

const key = process.env.OPENAI_API_KEY;
const withKey = key ? describe : describe.skip;

withKey('the real OpenAI-compatible speech adapter', () => {
  test('returns audio bytes for a short script', async () => {
    const adapter = openAiSpeechAdapter({
      apiKey: key ?? '',
      ...(process.env.OPENAI_COMPAT_BASE_URL
        ? { baseUrl: `${process.env.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, '')}/` }
        : {}),
    });
    const bytes = await adapter.synthesize({ script: 'One short line.', voice: 'alto' });
    expect(bytes.length).toBeGreaterThan(0);
  }, 60_000);
});
