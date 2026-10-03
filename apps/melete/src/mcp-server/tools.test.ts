import { describe, expect, test } from 'bun:test';
import { callTool, type RouteCall, TOOL_DEFINITIONS, TOOL_INPUTS, UnknownTool } from './tools.ts';

const actor = {
  principalId: 'own_1',
  spaceId: 'sp_1',
  membershipGeneration: 0,
  clientId: 'mcpc_probe',
  clientName: 'Probe',
};

function deps(answer: Awaited<ReturnType<RouteCall>> = { status: 200, body: {} }) {
  const calls: Array<[string, string, unknown]> = [];
  const proposals: unknown[] = [];
  return {
    calls,
    proposals,
    deps: {
      actor,
      route: (async (method, path, body) => {
        calls.push([method, path, body]);
        return answer;
      }) as RouteCall,
      sendConnection: async () => 'conn_1',
      proposeSend: async (input: unknown) => {
        proposals.push(input);
        return { id: 'act_1', job_id: 'job_1', status: 'needs_approval' };
      },
    },
  };
}

describe('the MCP tools', () => {
  test('every tool is listed with the input it parses', () => {
    expect(TOOL_DEFINITIONS.map((tool): string => tool.name).sort()).toEqual(
      Object.keys(TOOL_INPUTS).sort(),
    );
  });

  test('an id is one path segment, so it cannot climb to another route', async () => {
    for (const id of ['..', '../permissions/x', 'a/b', 'a?b=1', '%2e%2e']) {
      const probe = deps();
      const handled = await callTool(probe.deps, 'handle', { item_id: id });
      const read = await callTool(probe.deps, 'status', { job_id: id });
      expect([handled.isError, read.isError]).toEqual([true, true]);
      expect(probe.calls).toEqual([]);
    }
  });

  test("someone else's record reads as absent, whether the route says missing or forbidden", async () => {
    for (const status of [403, 404]) {
      const probe = deps({ status, body: { error: { message: 'Space is not accessible.' } } });
      const result = await callTool(probe.deps, 'status', { job_id: 'job_other' });
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Melete has nothing by that id for you.' }],
        isError: true,
      });
    }
  });

  test('safe_send only proposes, as the token’s person, from their own mailbox', async () => {
    const probe = deps();
    const result = await callTool(probe.deps, 'safe_send', {
      to: 'a@example.test',
      subject: 'Hello',
      body: 'Hi',
    });
    expect(result.structuredContent).toEqual({
      status: 'awaiting_approval',
      job_id: 'job_1',
      action_id: 'act_1',
    });
    expect(probe.proposals).toEqual([
      {
        spaceId: 'sp_1',
        principalId: 'own_1',
        connectionId: 'conn_1',
        payload: { to: ['a@example.test'], subject: 'Hello', body: 'Hi' },
        assistant: 'Probe',
      },
    ]);
    expect(probe.calls).toEqual([]);
    // An address field the tool does not declare is refused, not passed along.
    const hidden = await callTool(probe.deps, 'safe_send', {
      to: 'a@example.test',
      bcc: 'b@example.test',
      subject: 'Hello',
      body: 'Hi',
    });
    expect(hidden.isError).toBe(true);
  });

  test('handle refuses an item a connected app added, and starts nothing', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const route = (async (method, path, body) => {
      calls.push([method, path, body]);
      return method === 'GET'
        ? {
            status: 200,
            body: { item: { id: 'li_1', source: { label: 'Project tracker', actions: [] } } },
          }
        : { status: 201, body: { job_id: 'job_1' } };
    }) as RouteCall;
    const result = await callTool({ ...deps().deps, route }, 'handle', { item_id: 'li_1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Project tracker added this item');
    expect(calls.map(([method]) => method)).toEqual(['GET']);
  });

  test('handle starts a chase for an item found in the mailbox, as before', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const route = (async (method, path, body) => {
      calls.push([method, path, body]);
      return method === 'GET'
        ? { status: 200, body: { item: { id: 'li_1' } } }
        : { status: 201, body: { job_id: 'job_1' } };
    }) as RouteCall;
    const result = await callTool({ ...deps().deps, route }, 'handle', { item_id: 'li_1' });
    expect(result.structuredContent).toEqual({ job_id: 'job_1', status: 'started' });
    expect(calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', '/ledger/li_1?space_id=sp_1'],
      ['POST', '/ledger/li_1/handle?space_id=sp_1'],
    ]);
  });

  test('waiting_on names the app that added an item', async () => {
    const probe = deps({
      status: 200,
      body: {
        companies: [{ id: 'co_1', name: 'Harbour Studio' }],
        items: [
          {
            id: 'li_1',
            company_id: 'co_1',
            kind: 'commitment',
            direction: 'owed_to_you',
            amount_minor: null,
            currency: null,
            due_at: null,
            status: 'found',
            job_id: null,
            summary: 'Signed contract back',
            source: { label: 'Project tracker' },
          },
          {
            id: 'li_2',
            company_id: 'co_1',
            kind: 'refund_owed',
            direction: 'owed_to_you',
            amount_minor: 500,
            currency: 'GBP',
            due_at: null,
            status: 'found',
            job_id: null,
            summary: 'Refund',
          },
        ],
      },
    });
    const result = await callTool(probe.deps, 'waiting_on', {});
    const items = (result.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items.find((item) => item.item_id === 'li_1')?.added_by).toBe('Project tracker');
    expect(items.find((item) => item.item_id === 'li_2')).not.toHaveProperty('added_by');
  });

  test('a name it does not offer is a protocol error', async () => {
    await expect(callTool(deps().deps, 'send_now', {})).rejects.toBeInstanceOf(UnknownTool);
    await expect(callTool(deps().deps, 'toString', {})).rejects.toBeInstanceOf(UnknownTool);
  });
});
