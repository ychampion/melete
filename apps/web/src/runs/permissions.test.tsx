/**
 * Long work that waits for the person's OK shows what it asked for where the
 * work is, with Approve and Decline: on its page and on its card in the chat.
 * Its helpers' asks count as its own. Home's queue names the work that asks.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue, NO_DECISIONS } from '../experience/hooks.ts';
import type { Permission, Run } from '../experience/types.ts';
import {
  COMPACT_FACT_CHARS,
  permissionsFor,
  RunPermissions,
  runOfPermission,
} from './RunPermissions.tsx';

const AT = '2026-10-08T23:38:00.000Z';
const ask = (id: string, job: string, created_at = AT): Permission => ({
  id,
  conversation_id: job,
  what: 'Do a few steps on its computer',
  why: ['This change needs your permission before it happens.'],
  options: ['allow_once', 'deny'],
  version: `v_${id}`,
  preview: null,
  created_at,
});
const run = {
  id: 'job_run',
  status: 'needs_you',
  steps: [{ id: 'job_helper', title: 'Read reviews', status: 'needs_you', result: null }],
} as unknown as Run;

test('the work’s own asks and its helpers’ are its own; another chat’s are not', () => {
  const asks = [
    ask('apr_3', 'job_helper', '2026-10-08T23:40:00.000Z'),
    ask('apr_2', 'job_chat'),
    ask('apr_1', 'job_run'),
  ];
  expect(permissionsFor(run, asks).map((entry) => entry.id)).toEqual(['apr_1', 'apr_3']);
  expect(runOfPermission([run], ask('apr_3', 'job_helper'))?.id).toBe('job_run');
  expect(runOfPermission([run], ask('apr_2', 'job_chat'))).toBeNull();
});

test('what it asked for is answered with Approve or Decline', () => {
  const app = {
    decisions: { ...NO_DECISIONS, loaded: true, permissions: [ask('apr_1', 'job_run')] },
    refreshConversations: () => {},
  } as unknown as AppContextValue;
  const html = renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <RunPermissions run={run} />
    </AppContext.Provider>,
  );
  expect(html).toContain('Do a few steps on its computer');
  expect(html).toContain('Approve');
  expect(html).toContain('Decline');
  expect(html).toContain('This change needs your permission before it happens.');
});

test('nothing asked draws nothing', () => {
  const app = {
    decisions: { ...NO_DECISIONS, loaded: true },
    refreshConversations: () => {},
  } as unknown as AppContextValue;
  expect(
    renderToStaticMarkup(
      <AppContext.Provider value={app}>
        <RunPermissions run={run} compact />
      </AppContext.Provider>,
    ),
  ).toBe('');
});

test('an ask to run a command shows the command and where it runs, even on the chat card', () => {
  const command = `curl -s http://127.0.0.1:40409/json; ${'x'.repeat(400)}`;
  const asked: Permission = {
    ...ask('apr_cmd', 'job_run'),
    what: "Run a command on the agent's computer",
    preview: {
      id: 'apr_cmd',
      title: "Run a command on the agent's computer",
      meta: 'Computer',
      facts: [
        { label: 'Command', value: command },
        { label: 'Runs in', value: '/work/flights' },
        { label: 'Computer', value: "The agent's own computer, not yours" },
      ],
      primary_action: null,
      secondary_actions: [],
      source_connection: 'conn_sandbox',
    },
  } as Permission;
  const app = {
    decisions: { ...NO_DECISIONS, loaded: true, permissions: [asked] },
    refreshConversations: () => {},
  } as unknown as AppContextValue;
  const draw = (compact: boolean) =>
    renderToStaticMarkup(
      <AppContext.Provider value={app}>
        <RunPermissions run={run} compact={compact} />
      </AppContext.Provider>,
    );
  const card = draw(true);
  expect(card).toContain('curl -s http://127.0.0.1:40409/json');
  expect(card).toContain(`${command.slice(0, COMPACT_FACT_CHARS)}…`);
  expect(card).not.toContain(command);
  expect(card).toContain('/work/flights');
  // The work's own page shows the command whole.
  expect(draw(false)).toContain(command);
});
