import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Loaded } from '../experience/hooks.ts';
import type { Connection } from '../experience/types.ts';
import { ConnectionsTab } from './Settings.tsx';

const loaded = (connections: Connection[]): Loaded<{ connections: Connection[] }> => ({
  data: { connections },
  error: null,
  unavailable: null,
  loading: false,
  reload: () => {},
  set: () => {},
});

const notion: Connection = {
  id: 'conn_notion',
  app: 'Notion',
  label: 'Notion',
  status: 'connected',
  access: 'asks_before_acting',
  catalog_id: 'notion',
};
const files: Connection = {
  id: 'conn_files',
  app: 'Files',
  label: 'Files',
  status: 'connected',
  access: 'asks_before_acting',
  builtin: true,
};
const voice: Connection = {
  id: 'conn_voice',
  app: 'Speech',
  label: 'Voice',
  status: 'error',
  access: 'asks_before_acting',
  builtin: true,
  problem: { kind: 'failing', detail: 'Its last check failed. Press Test to check it again.' },
};
const rooms: Connection = {
  id: 'conn_rooms',
  app: 'Rooms',
  label: 'Rooms',
  status: 'error',
  access: 'asks_before_acting',
  builtin: true,
  problem: { kind: 'not_running', detail: 'Installed, but not running right now.' },
};

test('the person’s own apps come first, then what to connect, and the built-in tools fold away last', () => {
  const html = renderToStaticMarkup(
    <ConnectionsTab connections={loaded([files, notion, voice, rooms])} />,
  );
  const at = (text: string) => {
    const index = html.indexOf(text);
    expect(index).toBeGreaterThan(-1);
    return index;
  };
  expect(at('aria-label="Your apps"')).toBeLessThan(at('Connect an app'));
  expect(at('Connect an app')).toBeLessThan(at('Built-in tools'));
  // Only Notion is in the person's own list; the tools that come with Melete are inside the fold.
  const fold = at('<details');
  expect(at('>Notion</span>')).toBeLessThan(fold);
  expect(at('>Files</span>')).toBeGreaterThan(fold);
  expect(html).not.toContain('<details open');
});

test('a built-in tool that is not working is said calmly, without the reason or a red state', () => {
  const html = renderToStaticMarkup(<ConnectionsTab connections={loaded([voice, rooms])} />);
  expect(html).toContain('Voice isn’t available right now.');
  expect(html).toContain('Rooms isn’t available right now.');
  expect(html).toContain('Not available');
  expect(html).not.toContain('Failing');
  expect(html).not.toContain('Not running');
  expect(html).not.toContain('Its last check failed');
  expect(html).not.toContain('connection-problem');
});

test('the headline says what Melete does on its own and what it asks first', () => {
  const html = renderToStaticMarkup(<ConnectionsTab connections={loaded([notion])} />);
  expect(html).not.toContain('asks before it writes anywhere');
  expect(html).toContain('It asks you first before it sends, posts or pays for anything.');
});
