import { expect, test } from 'bun:test';
import type { Action, SignInOutcome } from '@melete/contracts';
import { MAX_DISPATCH_BUDGET_MS, toolDeadline } from '../broker/catalog.ts';
import type { BrowserWorkerClient } from '../workers/browser/client.ts';
import { SIGN_IN_REQUEST_MS, SIGN_IN_STEP_MS } from '../workers/browser/sign-in-page.ts';
import { browserManifest, createBrowserConnector } from './browser.ts';
import { runSignIn, SIGN_IN_DISPATCH_MS, type SignInVaultPort } from './browser-sign-in.ts';
import type { VaultRecord } from './sign-in-vault.ts';
import type { ConnectorContext } from './types.ts';

const ORIGIN = 'https://www.example.com';
const record: VaultRecord = {
  id: 'ssi_01JZ0000000000000000000000',
  spaceId: 'sp_1',
  principalId: 'pr_1',
  origin: ORIGIN,
  label: 'Example',
  username: 'jo.rivera@example.com',
  secretRef: 'sec_1',
  keyId: 'k1:0',
  hasCode: false,
  policy: 'whenever_needed',
  createdAt: new Date(),
  updatedAt: new Date(),
  lastUsedAt: null,
  lastOutcome: null,
};
const action = {
  id: 'act_1',
  kind: 'browser.sign_in',
  connection_id: 'conn_1',
  canonical_payload: {
    site: 'www.example.com',
    sign_in_id: record.id,
    saved: {
      origin: ORIGIN,
      label: 'Example',
      account: 'j***@…',
      ask_first: false,
      has_code: false,
    },
  },
} as unknown as Action;

/** One sign-in through a worker that answers each step with `result`, recording each request. */
async function run(result: Record<string, unknown>) {
  const calls: Array<{ path: string; body: unknown; timeoutMs: number | undefined }> = [];
  const uses: SignInOutcome[] = [];
  const worker = {
    request: async (path: string, body: unknown, timeoutMs?: number) => {
      calls.push({ path, body, timeoutMs });
      return { session_id: 'bs_1', control_epoch: 1, result };
    },
  } as unknown as BrowserWorkerClient;
  const vault = {
    principalOf: async () => 'pr_1',
    get: async () => record,
    withCredential: async (_record, use) =>
      use({ username: record.username, password: 'Planted-password', totp: null }),
    recordUse: async (_record, use) => {
      uses.push(use.outcome);
    },
  } as Partial<SignInVaultPort> as SignInVaultPort;
  const outcome = await runSignIn({
    vault,
    action,
    ctx: { job_id: 'job_1', space_id: 'sp_1' } as unknown as ConnectorContext,
    lease: async () => ({ session: { id: 'bs_1', control_epoch: 1 }, worker, opened: false }),
    handOff: async () => {},
  });
  return { outcome, calls, uses };
}

test('the service waits for a sign-in step longer than the worker may take with it', async () => {
  // Past its bound the worker starts nothing new; what is under way then (a send, a page
  // load cut to the bound, the last look, clearing the field) ends within a minute.
  expect(SIGN_IN_REQUEST_MS).toBeGreaterThanOrEqual(SIGN_IN_STEP_MS + 60_000);
  const { calls } = await run({ sign_in: 'signed_in', at: ORIGIN });
  expect(calls.map((call) => [call.path, call.timeoutMs])).toEqual([
    ['/command', SIGN_IN_REQUEST_MS],
  ]);
});

test('a username sent with no password field after it is said so, never as nothing found', async () => {
  const { outcome, uses } = await run({
    sign_in: 'username_sent',
    at: ORIGIN,
    username_sent: true,
  });
  expect(outcome).toMatchObject({ outcome: 'failed' });
  const reason = outcome.outcome === 'failed' ? outcome.reason : '';
  expect(reason).toContain('The saved username was sent to www.example.com');
  expect(reason).not.toContain("Couldn't find");
  expect(uses).toEqual(['form_not_found']);
});

test('a page that left for another site after the username went does not say nothing was typed', async () => {
  const { outcome } = await run({
    sign_in: 'wrong_site',
    at: 'https://accounts.other.test',
    username_sent: true,
  });
  const reason = outcome.outcome === 'failed' ? outcome.reason : '';
  expect(reason).toContain(
    "the saved username was sent to www.example.com, but the password wasn't typed",
  );
  expect(reason).not.toContain('nothing was typed');
});

test('a form or script on the saved site that sends elsewhere is said so, not as a refused password', async () => {
  const { outcome, uses } = await run({ sign_in: 'wrong_site', at: ORIGIN });
  const reason = outcome.outcome === 'failed' ? outcome.reason : '';
  expect(reason).toContain(
    'sends to another address than the saved site, so the browser held it back',
  );
  expect(reason).not.toContain("didn't accept");
  expect(uses).toEqual(['wrong_site']);
});

test('a form that would put the sign-in in an address is said so', async () => {
  const { outcome, uses } = await run({ sign_in: 'unsafe_form', at: ORIGIN });
  const reason = outcome.outcome === 'failed' ? outcome.reason : '';
  expect(reason).toContain("in the page's address, so it wasn't sent");
  expect(uses).toEqual(['form_not_found']);
});

test('the broker waits for a sign-in as long as its password step and its code step may take', () => {
  const connector = createBrowserConnector({
    sessions: {
      lease: async () => {
        throw new Error('not leased in this test');
      },
      park: async () => {},
    },
    artifacts: async () => ({}),
  } as unknown as Parameters<typeof createBrowserConnector>[0]);
  const budget = connector.dispatchBudgetMs?.({ kind: 'browser.sign_in', canonical_payload: {} });
  expect(budget).toBe(SIGN_IN_DISPATCH_MS);
  // Each step may take the service's full wait, and a look or a lease may come before each.
  expect(SIGN_IN_DISPATCH_MS).toBeGreaterThanOrEqual(2 * SIGN_IN_REQUEST_MS + 60_000);
  expect(SIGN_IN_DISPATCH_MS).toBeLessThanOrEqual(MAX_DISPATCH_BUDGET_MS);
  // The same bound reaches the runtime's own deadline for the tool.
  expect(toolDeadline(connector, 'browser.sign_in')).toBe(SIGN_IN_DISPATCH_MS);
  // Every other browser action keeps the broker's own bound.
  for (const tool of browserManifest.tools)
    if (tool.name !== 'browser.sign_in')
      expect([
        tool.name,
        connector.dispatchBudgetMs?.({ kind: tool.name, canonical_payload: {} }) ?? 0,
      ]).toEqual([tool.name, 0]);
});
