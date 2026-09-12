import { recordTask, TASK_PREFIX } from '../../../../conformance/learning/records.ts';
import { createScriptedProvider, type FakeTurn } from '../../src/gateway/fake.ts';
import type { GatewayOptions } from '../../src/gateway/index.ts';

/** The fake model sees only HTTP prompt bytes, never bundles, expected answers or database rows. */
export function capabilityProvider() {
  const requests = new Map<string, Record<string, unknown>[]>();
  const turns = new Map<string, number>();
  const fake: NonNullable<GatewayOptions['fake']> = async (body, id, protocol) => {
    requests.set(id, [...(requests.get(id) ?? []), structuredClone(body)]);
    const messages = (body.messages ?? []) as { role: string; content?: unknown }[];
    const text = messages.map((message) => String(message.content ?? '')).join('\n');
    let turn: FakeTurn;
    if (id.startsWith('proposal:')) {
      turn = {
        text: JSON.stringify({
          target: 'skill_body',
          steps: ['sort-typed-values', 'keep-header-and-rows'],
          test: 'ordering-and-shape',
        }),
      };
    } else if (text.includes(TASK_PREFIX)) {
      const encoded =
        text.slice(text.indexOf(TASK_PREFIX) + TASK_PREFIX.length).split('\n')[0] ?? '';
      const task = recordTask.parse(JSON.parse(encoded));
      const typed =
        text.includes('using the declared column type') ||
        /## From the owner\n\n[^#]*chronolog/i.test(text);
      const asText = text.includes('comparing the selected values as text');
      const rows = [...task.rows];
      const value = (row: (typeof rows)[number]): number | string => {
        const raw = row[task.key];
        if (asText) return String(raw);
        if (task.type === 'number') return Number(raw);
        if (typed && task.type === 'date') {
          if (task.dateFormat === 'dmy') {
            const [day, month, year] = String(raw).split('/');
            return Date.parse(`${year}-${month}-${day}T00:00:00Z`);
          }
          return Date.parse(String(raw));
        }
        return String(raw);
      };
      if (typed || asText || task.type === 'number')
        rows.sort((a, b) => {
          const left = value(a);
          const right = value(b);
          const compared = left < right ? -1 : left > right ? 1 : 0;
          return task.direction === 'ascending' ? compared : -compared;
        });
      turn = { text: JSON.stringify({ columns: task.columns, rows }) };
    } else if (text.includes('W14 MCP discovery')) {
      const index = turns.get(id) ?? 0;
      turns.set(id, index + 1);
      const names = ((body.tools ?? []) as { function?: { name?: string } }[]).map(
        (tool) => tool.function?.name,
      );
      if (index === 0)
        turn = {
          tool: {
            name: 'search_tools',
            arguments: { query: 'capability fixture' },
            id: 'search_fixture',
          },
        };
      else if (index === 1)
        turn = {
          tool: { name: 'load_tool', arguments: { name: 'mcp_fixture.read' }, id: 'load_fixture' },
        };
      else if (names.includes('mcp_fixture.read') && !text.includes('fixture-value-verified'))
        turn = { tool: { name: 'mcp_fixture.read', arguments: {}, id: 'read_fixture' } };
      else turn = { text: 'MCP discovery finished.' };
    } else turn = { text: 'The authorized shared task is complete.' };
    return createScriptedProvider([turn])(body, id, protocol);
  };
  return { fake, requests };
}
