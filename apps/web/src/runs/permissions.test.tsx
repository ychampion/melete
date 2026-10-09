/**
 * Long work that waits for the person's OK shows what it asked for where the
 * work is, with Approve and Decline: on its page and on its card in the chat.
 * Its helpers' asks count as its own. Home's queue names the work that asks.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue, NO_DECISIONS } from '../experience/hooks.ts';
import type { Permission, Run } from '../experience/types.ts';
import { permissionsFor, RunPermissions, runOfPermission } from './RunPermissions.tsx';

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
