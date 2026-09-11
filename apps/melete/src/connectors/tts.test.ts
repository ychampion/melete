import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  job_id: 'job_01J0000000000000000000000',
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
    job_id: 'job_01J0000000000000000000000',
    attempt_id: 'att_01J0000000000000000000000',
    connection_id: 'conn_01J0000000000000000000000',
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
    const spaceId = 'sp_01J0000000000000000000000';
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J0000000000000000000000';
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
    const spaceId = 'sp_01J0000000000000000000001';
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J0000000000000000000001';
    const action = proposal(actionId, { script, path: 'episode-two.wav' });
    const ctx = context(spaceId, actionId);
    expect((await connector.verify(action, ctx)).decision).toBe('failed');
    await connector.execute(action, ctx);
    const verified = await connector.verify(action, ctx);
    expect(verified.decision).toBe('succeeded');
  });

  test('a path that is not a simple file name is refused', async () => {
    const spacesRoot = await workspace();
    const connector = createCapabilityConnector({
      spacesRoot,
      adapter: fakeSpeechAdapter,
      provider: 'fake',
    });
    const actionId = 'act_01J0000000000000000000002';
    const action = proposal(actionId, { script, path: '../escape.wav' });
    await expect(
      connector.execute(action, context('sp_01J0000000000000000000002', actionId)),
    ).rejects.toThrow();
  });

  test('with no adapter it fails honestly instead of writing an empty file', async () => {
    const spacesRoot = await workspace();
    const connector = createCapabilityConnector({ spacesRoot, adapter: null, provider: 'none' });
    const actionId = 'act_01J0000000000000000000003';
    const result = await connector.execute(
      proposal(actionId, { script, path: 'nothing.wav' }),
      context('sp_01J0000000000000000000003', actionId),
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
