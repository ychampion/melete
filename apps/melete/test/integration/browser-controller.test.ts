import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { type BrowserWorkerClient, BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type {
  BrowserCommandResult,
  BrowserSubmitIntent,
} from '../../src/workers/browser/controller.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { startBrowserFixture } from '../helpers/browser-fixture.ts';

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)('Chromium controller', () => {
  let fixture: ReturnType<typeof startBrowserFixture>;
  let pool: BrowserWorkerPool;
  let worker: BrowserWorkerClient;
  let session: BrowserSession;
  beforeAll(async () => {
    fixture = startBrowserFixture();
    pool = new BrowserWorkerPool({
      spacesRoot: await mkdtemp(join(tmpdir(), 'melete-w10b-controller-')),
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
    });
    worker = await pool.get('sp_controller');
    session = await worker.lease('job_controller', {
      public_compartment: false,
      allowed_domains: ['127.0.0.1'],
    });
    await call({ kind: 'observe' });
  }, 20_000);
  afterAll(async () => {
    await pool?.close();
    await fixture?.close();
  }, 25_000);
  const call = (operation: unknown, epoch = session.control_epoch) =>
    worker.request<BrowserCommandResult>('/command', {
      session_id: session.id,
      job_id: 'job_controller',
      control_epoch: epoch,
      operation,
    });
  test('semantic fills, read, downscaled artifacts and a bound native POST produce one effect', async () => {
    const opened = await call({ kind: 'open', url: `${fixture.url}/form/baseline?run=controller` });
    expect(opened.observation?.schema.map((control) => control.label)).toEqual([
      'Name',
      'Email',
      'Save',
    ]);
    const png = Buffer.from(opened.observation?.screenshot ?? '', 'base64');
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(384);
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    const observed = await call({ kind: 'observe' });
    const intent = ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0];
    expect(intent?.fields).toEqual({ person_name: 'A Person', email: 'person@example.com' });
    expect((await call({ kind: 'read', role: 'heading', name: 'Contact form' })).result?.text).toBe(
      'Contact form',
    );
    await call({ kind: 'submit', intent });
    expect(fixture.effects.filter((effect) => effect.run === 'controller')).toHaveLength(1);
    expect(fixture.effects[0]?.fields.person_name).toBe('A Person');
  }, 20_000);
  test('controller refuses the second fill after takeover, and handback requires fresh observation', async () => {
    await call({ kind: 'open', url: `${fixture.url}/form/takeover?run=takeover` });
    await call({ kind: 'fill', label: 'Name', value: 'Before takeover' });
    const oldEpoch = session.control_epoch;
    session = await worker.takeover(session.id);
    let reason = '';
    try {
      await call({ kind: 'fill', label: 'Email', value: 'must-not-enter@example.com' }, oldEpoch);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toBe('stale_control_epoch');
    expect(fixture.effects.filter((effect) => effect.run === 'takeover')).toHaveLength(0);
    session = await worker.handback(session.id);
    try {
      await call({ kind: 'fill', label: 'Email', value: 'must-not-enter@example.com' });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toBe('fresh_observation_required');
    const refreshed = await call({ kind: 'observe' });
    expect(refreshed.observation?.tree).not.toContain('must-not-enter');
    expect(refreshed.observation?.tree).toContain('Before takeover');
    await call({ kind: 'fill', label: 'Email', value: 'after@example.com' });
  }, 15_000);
  test('a guarded document redirect uses a new page with the actual final URL', async () => {
    const result = await call({ kind: 'open', url: `${fixture.url}/redirect?run=redirect` });
    expect(result.observation?.url).toBe(`${fixture.url}/form/baseline?run=redirect`);
  }, 15_000);
  test('a reversible click cannot commit either a native form or a scripted POST', async () => {
    await call({ kind: 'open', url: `${fixture.url}/form/reversible_effect?run=reversible` });
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    await expect(call({ kind: 'click', role: 'button', name: 'Save' })).rejects.toThrow(
      'commit_requires_submit',
    );
    // A script may enqueue its request after the click returns. Both the reversible
    // network window and the idle window deny it before the destination is reached.
    await call({ kind: 'click', role: 'button', name: 'Change view' }).catch((error: Error) => {
      expect(error.message).toBe('network_reversible');
    });
    await call({ kind: 'observe' });
    expect(fixture.effects.filter((effect) => effect.run === 'reversible')).toHaveLength(0);
  }, 15_000);
  test.each(['tampered_submit', 'shadowed_serializer'])(
    '%s: a page script cannot change the approved POST bytes',
    async (variant) => {
      await call({ kind: 'open', url: `${fixture.url}/form/${variant}?run=${variant}` });
      await call({ kind: 'fill', label: 'Name', value: 'A Person' });
      await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
      const observed = await call({ kind: 'observe' });
      const intent = ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0];
      expect(intent).toBeDefined();
      await expect(call({ kind: 'submit', intent })).rejects.toThrow('commit_payload_mismatch');
      expect(fixture.effects.filter((effect) => effect.run === variant)).toHaveLength(0);
    },
    15_000,
  );
  test('credential pages refuse captures, reads, and automated authentication input', async () => {
    await expect(
      call({ kind: 'open', url: `${fixture.url}/form/credentials?run=credentials` }),
    ).rejects.toThrow('sensitive_input_require_takeover');
    await expect(call({ kind: 'observe' })).rejects.toThrow('sensitive_input_require_takeover');
    await expect(call({ kind: 'read', selector: 'body' })).rejects.toThrow(
      'sensitive_input_require_takeover',
    );
    await expect(call({ kind: 'fill', label: 'Password', value: 'not-recorded' })).rejects.toThrow(
      'sensitive_input_require_takeover',
    );
    await expect(
      call({ kind: 'fill', label: 'Verification code', value: '072614' }),
    ).rejects.toThrow('sensitive_input_require_takeover');
    expect(fixture.effects.filter((effect) => effect.run === 'credentials')).toHaveLength(0);
  }, 15_000);
  test('hidden destinations are included in the complete observed submit intent', async () => {
    await call({ kind: 'open', url: `${fixture.url}/form/hidden_destination?run=hidden` });
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    const observed = await call({ kind: 'observe' });
    const intent = ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0];
    expect(intent?.fields).toEqual({
      person_name: 'A Person',
      email: 'person@example.com',
      destination_picker_7: 'hidden@example.test',
    });
    expect(fixture.effects.filter((effect) => effect.run === 'hidden')).toHaveLength(0);
  }, 15_000);
  test('an accessible label changed by a fill triggers another observation', async () => {
    await call({ kind: 'open', url: `${fixture.url}/form/label_transition?run=rename` });
    const filled = await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    expect(filled.observation?.schema.map((control) => control.label)).toContain('Contact email');
    expect(filled.observation?.tree).toContain('Contact email');
  }, 15_000);
  test('multiline form values bind the native URL-encoded bytes and produce one effect', async () => {
    await call({ kind: 'open', url: `${fixture.url}/form/multiline?run=multiline` });
    await call({ kind: 'fill', label: 'Name', value: 'First line\nSecond line' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    const observed = await call({ kind: 'observe' });
    const intent = ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0];
    if (!intent) throw new Error('Missing multiline submit intent');
    await call({ kind: 'submit', intent });
    expect(intent.fields.person_name).toBe('First line\r\nSecond line');
    expect(fixture.effects.filter((effect) => effect.run === 'multiline')).toEqual([
      { run: 'multiline', fields: intent.fields },
    ]);
  }, 15_000);
});
