/**
 * The agent's computer panel: the empty state says what to connect, the page
 * and its holder are named, commands show what they printed, and a person's
 * pointer and keys become page input in the agent's window.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, AgentComputer } from '../experience/types.ts';
import { ComputerPanel, computerEmptyWords } from './ComputerPanel.tsx';
import { keyInput, modsOf, pagePoint, pasteInput, shownAddress } from './live.ts';

const AT = '2026-09-30T09:00:00.000Z';
const NOVA = {
  id: 'agent_1',
  name: 'Nova',
  colour: '#2f5fd6',
  surface: 'matte',
  eye_colour: 'white',
  face_image: null,
} as unknown as Agent;
const render = (computer: AgentComputer | null, error: string | null = null) =>
  renderToStaticMarkup(
    <ComputerPanel
      agent={NOVA}
      computer={computer}
      error={error}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
const browser = (control: 'agent' | 'you') => ({
  session_id: 'bs_1',
  control,
  url: 'https://tables.example/venues/luna',
  title: 'Luna Trattoria',
  screenshot: { artifact_id: 'art_page' },
  seen_at: AT,
});

test('with neither a browser nor a sandbox, the panel says how to give the agent one', () => {
  const html = render({
    browser: null,
    terminal: [],
    available: { browser: false, terminal: false },
  });
  expect(html).toContain('Nova has no computer yet');
  expect(html).toContain('#/settings/connections');
  expect(html).not.toContain('Take over');
});

test('with both available and nothing done yet, the panel says what will show', () => {
  expect(computerEmptyWords('Nova', { browser: true, terminal: true })).toEqual({
    title: 'Nothing on Nova’s computer yet',
    body: 'When Nova opens a page or runs a command in this chat, it shows here, and you can take over the browser at any time.',
    connect: false,
  });
  expect(computerEmptyWords('Nova', { browser: true, terminal: false }).connect).toBe(true);
  expect(computerEmptyWords('Nova', { browser: false, terminal: true }).body).toContain(
    'cannot browse yet',
  );
});

test('the agent’s page, who holds it, and the commands it ran', () => {
  const html = render({
    browser: browser('agent'),
    terminal: [
      {
        id: 'act_1',
        command: 'python3 overlap.py',
        output: 'First time all three are free: 19:30',
        status: 'done',
        exit_code: 0,
        started_at: AT,
      },
      {
        id: 'act_2',
        command: 'bun test',
        output: '',
        status: 'running',
        exit_code: null,
        started_at: AT,
      },
    ],
    available: { browser: true, terminal: true },
  });
  expect(html).toContain('tables.example/venues/luna');
  expect(html).toContain('/artifacts/art_page/content');
  expect(html).toContain('alt="The page Nova is on: Luna Trattoria"');
  expect(html).toContain('Nova has control');
  expect(html).toContain('Take over');
  expect(html).toContain('python3 overlap.py');
  expect(html).toContain('First time all three are free: 19:30');
  expect(html).toContain('Running…');
  expect(html).not.toContain('Hand back');
});

test('while the person holds the browser, the page is live and can be handed back', () => {
  const html = render({
    browser: browser('you'),
    terminal: [],
    available: { browser: true, terminal: true },
  });
  expect(html).toContain('You have control');
  expect(html).toContain('Hand back');
  expect(html).toContain('role="application"');
  expect(html).toContain('Press Escape twice to leave it');
  // The recorded picture is not shown in place of the live page.
  expect(html).not.toContain('/artifacts/art_page/content');
});

test('a page with no picture says so rather than showing an old one', () => {
  const html = render({
    browser: { ...browser('agent'), screenshot: null },
    terminal: [],
    available: { browser: true, terminal: false },
  });
  expect(html).toContain('No picture of this page yet.');
});

test('a read that failed before anything arrived is said plainly', () => {
  expect(render(null, 'That item is not here.')).toContain('That item is not here.');
});

test('a point on the drawn picture is a point in the agent’s window', () => {
  const box = { left: 100, top: 50, width: 512, height: 384 };
  expect(pagePoint(box, 356, 242)).toEqual({ x: 512, y: 384 });
  expect(pagePoint(box, 0, 0)).toEqual({ x: 0, y: 0 });
  expect(pagePoint(box, 9999, 9999)).toEqual({ x: 1024, y: 768 });
});

test('keys become page keys: typed characters carry text, shortcuts do not', () => {
  const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  expect(keyInput({ ...plain, key: 'a', code: 'KeyA', keyCode: 65 }, true)).toEqual({
    k: 'key',
    down: true,
    key: 'a',
    code: 'KeyA',
    vk: 65,
    mods: 0,
    text: 'a',
  });
  expect(keyInput({ ...plain, key: 'a', code: 'KeyA', keyCode: 65 }, false)).not.toHaveProperty(
    'text',
  );
  expect(
    keyInput({ ...plain, ctrlKey: true, key: 'a', code: 'KeyA', keyCode: 65 }, true),
  ).not.toHaveProperty('text');
  expect(keyInput({ ...plain, key: 'Enter', code: 'Enter', keyCode: 13 }, true)).toMatchObject({
    text: '\r',
  });
  expect(keyInput({ ...plain, key: 'Unidentified', code: '', keyCode: 0 }, true)).toBeNull();
  expect(modsOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  expect(pasteInput('')).toBeNull();
  expect(pasteInput('x'.repeat(5000))).toEqual({ k: 'text', text: 'x'.repeat(4000) });
  expect(shownAddress('https://tables.example/')).toBe('tables.example');
});
