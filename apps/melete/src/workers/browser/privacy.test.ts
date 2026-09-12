import { expect, test } from 'bun:test';
import type { JsonObject, RuntimeEvent } from '@melete/contracts';
import { browserEventForPersistence, isBrowserTool } from './privacy.ts';

const ulid = `01J${'0'.repeat(23)}`;
const base = {
  attempt_id: `att_${ulid}`,
  local_seq: 0,
  dedup_key: `att_${ulid}:0`,
  at: '2026-09-12T00:00:00Z',
};
const session = 'brws_00000000-0000-4000-8000-000000000001';
const observation = 'obs_00000000-0000-4000-8000-000000000002';
const artifact = `art_${ulid}`;
const action = `act_${ulid}`;
const credential = 'attempted-private-password-072614';

function result(value: JsonObject): Extract<RuntimeEvent, { type: 'tool_result' }> {
  return { ...base, type: 'tool_result', call_id: 'browser-call', ok: true, result: value };
}

test('all browser arguments are redacted before persistence without changing execution bytes', () => {
  for (const tool of [
    'browser.fill',
    'browser.select',
    'browser.open',
    'browser.submit',
    'browser.read',
    'browser.observe',
  ]) {
    const args = Object.freeze({
      session_id: session,
      control_epoch: 3,
      label: 'Password',
      value: credential,
      url: `https://public.example/?code=${credential}`,
      intent: { fields: { password: credential } },
    });
    const event: RuntimeEvent = Object.freeze({
      ...base,
      type: 'tool_call_proposed',
      tool,
      call_id: 'input-1',
      arguments: args,
    });
    const saved = browserEventForPersistence(event);
    expect(saved).toMatchObject({ tool, call_id: 'input-1', arguments: { redacted: true } });
    expect(JSON.stringify(saved)).not.toContain(credential);
    expect(event.arguments.value).toBe(credential);
    expect(event.arguments.intent).toEqual({ fields: { password: credential } });
  }
});

test('browser results retain handles and control metadata but no page text, schema or native form fields', () => {
  const live = result({
    status: 'succeeded',
    action_id: action,
    instruction: credential,
    receipt: {
      action_id: action,
      external_ref: credential,
      detail: {
        session_id: session,
        control_epoch: 3,
        observation: {
          id: observation,
          url: `https://public.example/?code=${credential}`,
          schema: [{ label: credential }],
          tree: { artifact_id: artifact, path: credential, text: credential },
          screenshot: { artifact_id: artifact, bytes: credential },
        },
        result: {
          text: credential,
          submit_intents: [{ fields: { password: credential } }],
          changed: true,
        },
      },
    },
  });
  const saved = browserEventForPersistence(live, true);
  expect(saved).toMatchObject({
    call_id: 'browser-call',
    ok: true,
    result: {
      redacted: true,
      status: 'succeeded',
      action_id: action,
      receipt: {
        action_id: action,
        detail: {
          session_id: session,
          control_epoch: 3,
          observation: {
            id: observation,
            tree: { artifact_id: artifact },
            screenshot: { artifact_id: artifact },
          },
          result: { changed: true },
        },
      },
    },
  });
  const json = JSON.stringify(saved);
  for (const absent of [
    credential,
    'submit_intents',
    'schema',
    'external_ref',
    'instruction',
    'path',
  ])
    expect(json).not.toContain(absent);
  expect(JSON.stringify(live)).toContain(credential);
});

test('a forged browser result cannot smuggle credentials through handle names or nested error text', () => {
  const saved = browserEventForPersistence(
    result({
      session_id: credential,
      artifact_id: credential,
      observation_id: credential,
      action_id: credential,
      control_epoch: credential,
      status: credential,
      error: { message: credential },
      observation: { id: credential, screenshot: credential, tree: { artifact_id: credential } },
      detail: { result: { value: credential, password: credential } },
    }),
    true,
  );
  expect(saved).toMatchObject({ result: { redacted: true } });
  if (saved.type !== 'tool_result') throw new Error('expected a tool result');
  expect(saved.result).toEqual({ redacted: true });
});

test('nonbrowser tool proposals and results keep their existing persistence behavior', () => {
  const proposal: RuntimeEvent = {
    ...base,
    type: 'tool_call_proposed',
    tool: 'test.read',
    call_id: 'test-call',
    arguments: { query: 'ordinary input' },
  };
  const completed = result({ text: 'ordinary result', nested: { preserved: true } });
  expect(browserEventForPersistence(proposal)).toBe(proposal);
  expect(browserEventForPersistence(completed, false)).toBe(completed);
  expect(isBrowserTool('test.browser')).toBe(false);
  expect(isBrowserTool('browserish.fill')).toBe(false);
  expect(isBrowserTool(' BROWSER.FILL ')).toBe(true);
});

test('result labels cannot decide whether durable browser identity requires redaction', () => {
  const claimedNonbrowser = result({ tool: 'test.read', text: credential });
  expect(browserEventForPersistence(claimedNonbrowser, true)).toMatchObject({
    result: { redacted: true },
  });
  expect(JSON.stringify(browserEventForPersistence(claimedNonbrowser, true))).not.toContain(
    credential,
  );
});
