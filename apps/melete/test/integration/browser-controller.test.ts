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
import { CHECK_PAGES, SIGN_IN_PAGES } from '../helpers/real-pages.ts';
import { ORDINARY_LABELS, SECRET_LABELS } from '../helpers/secret-labels.ts';

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)('Chromium controller', () => {
  let fixture: ReturnType<typeof startBrowserFixture>;
  let pool: BrowserWorkerPool;
  let worker: BrowserWorkerClient;
  let session: BrowserSession;
  beforeAll(async () => {
    fixture = startBrowserFixture();
    pool = new BrowserWorkerPool({
      spacesRoot: await mkdtemp(join(tmpdir(), 'melete-browser-controller-')),
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [fixture.url],
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
  test('a time, date or number field takes its value, and is not mistaken for a secret', async () => {
    const opened = await call({ kind: 'open', url: `${fixture.url}/form/typed_fields?run=typed` });
    // Each field is listed once, by its label, and not by the parts the browser draws in it.
    expect(opened.observation?.schema.map((control) => [control.label, control.role])).toEqual([
      ['Name', 'textbox'],
      ['Email', 'textbox'],
      ['Delivery time', 'textbox'],
      ['Day', 'textbox'],
      ['Guests', 'spinbutton'],
      ['Colour', 'textbox'],
      ['Extra cheese', 'checkbox'],
      ['Save', 'button'],
    ]);
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    await call({ kind: 'fill', label: 'Delivery time', value: '19:30' });
    await call({ kind: 'fill', label: 'Day', value: '2026-10-15' });
    await call({ kind: 'fill', label: 'Guests', value: '4' });
    await call({ kind: 'fill', label: 'Colour', value: '#FF8800' });
    const observed = await call({ kind: 'observe' });
    const intent = ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0];
    expect(intent?.fields).toMatchObject({
      delivery: '19:30',
      day: '2026-10-15',
      guests: '4',
      shade: '#ff8800',
    });
    // A value of the wrong form is refused by name, and the field keeps what it had.
    await expect(
      call({ kind: 'fill', label: 'Delivery time', value: 'half past seven' }),
    ).rejects.toThrow('value_not_accepted');
    await expect(call({ kind: 'fill', label: 'Colour', value: 'orange' })).rejects.toThrow(
      'value_not_accepted',
    );
    const after = await call({ kind: 'observe' });
    expect(
      ((after.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0]?.fields,
    ).toMatchObject({ delivery: '19:30', shade: '#ff8800' });
    // A checkbox is clicked, not filled; neither is a reason to hand the page to the person.
    const refused = await call({ kind: 'fill', label: 'Extra cheese', value: 'yes' }).catch(
      (error: unknown) => error as Error,
    );
    expect(String(refused)).toContain('not_fillable');
    expect(String(refused)).not.toContain('sensitive_input_require_takeover');
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
    // The first look after a handback carries the page's shape and none of its contents, so
    // neither what was typed before the takeover nor anything refused during it appears.
    const refreshed = await call({ kind: 'observe' });
    expect(refreshed.observation?.tree).toContain('- textbox "Name"');
    for (const value of ['must-not-enter', 'Before takeover'])
      expect([value, refreshed.observation?.tree.includes(value)]).toEqual([value, false]);
    // So is every later look, and nothing can be read off the page, until automation leaves it.
    const second = await call({ kind: 'observe' });
    expect(second.observation?.screenshot).toBe('');
    expect(second.result).toEqual({ submit_intents: [] });
    expect(second.observation?.tree).not.toContain('Before takeover');
    await expect(call({ kind: 'read', selector: 'body' })).rejects.toThrow('read_after_handback');
    // A fill stays on the same document, so the page is still the handed-back one.
    await call({ kind: 'fill', label: 'Email', value: 'after@example.com' });
    const filled = await call({ kind: 'observe' });
    expect(filled.observation?.tree).not.toContain('after@example.com');
    expect(filled.observation?.screenshot).toBe('');
    // Opening a page loads a new document, and the look that comes with it is ordinary.
    const reopened = await call({ kind: 'open', url: `${fixture.url}/form/takeover?run=reopened` });
    expect(reopened.observation?.screenshot).not.toBe('');
    await call({ kind: 'fill', label: 'Name', value: 'After the page changed' });
    expect((await call({ kind: 'observe' })).observation?.tree).toContain('After the page changed');
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
  test('a sign-in form with an empty password field is looked at, and only the person types the password', async () => {
    const opened = await call({
      kind: 'open',
      url: `${fixture.url}/form/password_only?run=password`,
    });
    expect(opened.observation?.screenshot).not.toBe('');
    expect(opened.result?.secret_fields).toBe(true);
    expect(opened.result?.challenge).toBeUndefined();
    expect(
      opened.observation?.schema
        .filter((control) => control.sensitive)
        .map((control) => control.label),
    ).toEqual(['Password']);
    expect(String(opened.result?.note)).toContain('are the person’s to type');
    await call({ kind: 'observe' });
    await call({ kind: 'read', selector: 'body' });
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await expect(call({ kind: 'fill', label: 'Password', value: 'not-recorded' })).rejects.toThrow(
      'sensitive_input_require_takeover',
    );
    expect(fixture.effects.filter((effect) => effect.run === 'password')).toHaveLength(0);
  }, 15_000);
  test('a password field that already holds something refuses captures and reads', async () => {
    await expect(
      call({ kind: 'open', url: `${fixture.url}/form/password_held?run=held` }),
    ).rejects.toThrow('sensitive_input_require_takeover');
    await expect(call({ kind: 'observe' })).rejects.toThrow('sensitive_input_require_takeover');
    await expect(call({ kind: 'read', selector: 'body' })).rejects.toThrow(
      'sensitive_input_require_takeover',
    );
  }, 15_000);
  test.each(Object.keys(SIGN_IN_PAGES))(
    'the sign-in page %s is no check, and is looked at like any other',
    async (name) => {
      const seen = await call({ kind: 'open', url: `${fixture.url}/page/${name}` });
      expect(seen.result?.challenge).toBeUndefined();
      expect(seen.result?.secret_fields).toBe(true);
      expect(seen.observation?.screenshot).not.toBe('');
      expect(seen.observation?.schema.some((control) => control.sensitive)).toBe(true);
    },
    15_000,
  );
  test.each(Object.keys(CHECK_PAGES))(
    'the check page %s is a check only the person can pass, seen as the page opens',
    async (name) => {
      const seen = await call({ kind: 'open', url: `${fixture.url}/page/${name}` });
      expect(seen.result?.challenge).toBe(true);
    },
    15_000,
  );
  test('a page that only links to signing in is read like any other', async () => {
    const seen = await call({ kind: 'open', url: `${fixture.url}/form/sign_in_links?run=links` });
    expect(seen.observation?.schema.map((control) => control.label)).toEqual(
      expect.arrayContaining(['Sign in', 'Log in', 'Name']),
    );
    expect(seen.observation?.schema.every((control) => !control.sensitive)).toBe(true);
  }, 15_000);
  test('a visible bot check is reported from the page itself, and a notice about one is not', async () => {
    const checked = await call({ kind: 'open', url: `${fixture.url}/form/bot_check?run=check` });
    expect(checked.result?.challenge).toBe(true);
    const named = await call({ kind: 'open', url: `${fixture.url}/form/bot_notice?run=notice` });
    expect(named.result?.challenge).toBeUndefined();
    expect(named.observation?.tree).toContain('protected by reCAPTCHA');
  }, 15_000);
  test('a field labelled for a secret is the person’s to fill, and an ordinary one is not', async () => {
    // Name and Email are on every form of the fixture already.
    for (const label of ORDINARY_LABELS.filter((each) => each !== 'Name' && each !== 'Email')) {
      const run = `ordinary-${label}`;
      await call({
        kind: 'open',
        url: `${fixture.url}/form/labelled?label=${encodeURIComponent(label)}&run=${encodeURIComponent(run)}`,
      });
      await call({ kind: 'observe' });
      await call({ kind: 'fill', label, value: 'plain words' });
      await call({ kind: 'read', selector: 'body' });
    }
    for (const label of SECRET_LABELS) {
      const page = `${fixture.url}/form/labelled?label=${encodeURIComponent(label)}&run=secret`;
      await expect(call({ kind: 'open', url: page })).rejects.toThrow(
        'sensitive_input_require_takeover',
      );
      await expect(call({ kind: 'observe' })).rejects.toThrow('sensitive_input_require_takeover');
      await expect(call({ kind: 'fill', label, value: '123-45-6789' })).rejects.toThrow(
        'sensitive_input_require_takeover',
      );
    }
    expect(fixture.effects.filter((effect) => effect.run === 'secret')).toHaveLength(0);
  }, 120_000);
  test('a number, month or date field for a code or a card expiry is the person’s, by its label, name, id or hint', async () => {
    const page = (params: Record<string, string>) =>
      `${fixture.url}/form/valued?${new URLSearchParams({ ...params, run: 'valued-secret' })}`;
    // Named for a code or an expiry by its label alone: the look already treats the page as one
    // only the person types into, and a fill is refused.
    for (const [label, type] of [
      ['Code', 'number'],
      ['Enter code', 'number'],
      ['Enter the 6-digit code', 'number'],
      ['Expires', 'month'],
      ['CVV', 'number'],
      ['PIN', 'number'],
    ] as const) {
      await expect(call({ kind: 'open', url: page({ label, type }) })).rejects.toThrow(
        'sensitive_input_require_takeover',
      );
      await expect(call({ kind: 'fill', label, value: '4821' })).rejects.toThrow(
        'sensitive_input_require_takeover',
      );
    }
    // Labelled plainly, and known for a code or a card by its name, its id or its hint.
    const named: Record<string, string>[] = [
      { name: 'otp' },
      { name: 'verification_code' },
      { id: 'verificationCode' },
      { id: 'code' },
      { type: 'month', name: 'cc-exp' },
      { type: 'month', autocomplete: 'cc-exp' },
      { type: 'number', autocomplete: 'cc-exp-year' },
    ];
    for (const params of named) {
      await call({ kind: 'open', url: page({ label: 'Digits', ...params }) }).catch(() => {});
      await expect(call({ kind: 'fill', label: 'Digits', value: '2027' })).rejects.toThrow(
        'sensitive_input_require_takeover',
      );
    }
    expect(fixture.effects.filter((effect) => effect.run === 'valued-secret')).toHaveLength(0);
    // An ordinary number field is still filled.
    await call({ kind: 'open', url: page({ label: 'Guests', name: 'guests' }) });
    await call({ kind: 'fill', label: 'Guests', value: '4' });
  }, 60_000);
  test('a slider value it would move is refused, and an editable area is named for what it is', async () => {
    await call({
      kind: 'open',
      url: `${fixture.url}/form/valued?label=Volume&type=range&name=volume&run=slider`,
    });
    await call({ kind: 'fill', label: 'Name', value: 'A Person' });
    await call({ kind: 'fill', label: 'Email', value: 'person@example.com' });
    await call({ kind: 'fill', label: 'Volume', value: '7' });
    for (const value of ['15', '-3', '2.5', 'loud']) {
      const refused = await call({ kind: 'fill', label: 'Volume', value }).catch(
        (error: unknown) => error as Error,
      );
      expect(String(refused)).toContain('value_not_accepted');
      expect(String(refused)).toContain('from 0 to 10 in steps of 1');
    }
    // The field keeps the value it had.
    const observed = await call({ kind: 'observe' });
    expect(
      ((observed.result?.submit_intents ?? []) as BrowserSubmitIntent[])[0]?.fields,
    ).toMatchObject({ volume: '7' });
    const editable = await call({ kind: 'fill', label: 'Notes', value: 'hello' }).catch(
      (error: unknown) => error as Error,
    );
    expect(String(editable)).toContain('not_fillable');
    expect(String(editable)).toContain('contenteditable');
    expect(String(editable)).not.toContain('checkbox');
  }, 20_000);
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
      { run: 'multiline', fields: intent.fields as Record<string, string> },
    ]);
  }, 15_000);
});
