/**
 * The Processes strip under the agent's computer: each process with its state,
 * how long it has run, its port and last line; Preview only where the service
 * offers one, and Stop only while it runs.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentComputer, ComputerProcess } from '../experience/types.ts';
import { ComputerPanel } from './ComputerPanel.tsx';
import { ProcessesPanel } from './ProcessesPanel.tsx';
import { previewDue, processStateWords, runningFor } from './processes.ts';

const process = (overrides: Partial<ComputerProcess>): ComputerProcess => ({
  id: 'prc_1',
  name: 'dev server',
  state: 'running',
  started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  port: 5173,
  last_line: 'Local: http://localhost:5173/',
  can_preview: true,
  ...overrides,
});

test('how long a process has run, the way a person says it', () => {
  expect(runningFor(30_000)).toBe('under a minute');
  expect(runningFor(12 * 60_000 + 5_000)).toBe('12 min');
  expect(runningFor(2 * 3_600_000)).toBe('2 h');
  expect(runningFor(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
  expect(processStateWords('expired')).toBe('Reached its time limit');
});

test('a running server shows its port and last line, with Preview, output and Stop', () => {
  const html = renderToStaticMarkup(
    <ProcessesPanel processes={[process({})]} onChanged={() => {}} />,
  );
  expect(html).toContain('aria-label="Processes"');
  expect(html).toContain('dev server');
  expect(html).toContain(':5173');
  expect(html).toContain('Running · 12 min');
  expect(html).toContain('Local: http://localhost:5173/');
  expect(html).toContain('Preview');
  expect(html).toContain('Read output');
  expect(html).toContain('Stop');
});

test('Preview shows only where it is offered, and Stop only while the process runs', () => {
  const html = renderToStaticMarkup(
    <ProcessesPanel
      processes={[
        process({ id: 'prc_theirs', name: 'theirs', can_preview: false }),
        process({ id: 'prc_done', name: 'tests', state: 'exited', port: null, can_preview: false }),
      ]}
      onChanged={() => {}}
    />,
  );
  expect(html).not.toContain('Preview');
  expect(html.match(/>Stop</g)?.length).toBe(1);
  expect(html).toContain('Finished');
});

test('no processes, no strip; processes alone keep the computer from looking empty', () => {
  expect(renderToStaticMarkup(<ProcessesPanel processes={[]} onChanged={() => {}} />)).toBe('');
  const computer = {
    browser: null,
    terminal: [],
    processes: [process({})],
    available: { browser: false, terminal: true },
  } as AgentComputer;
  const html = renderToStaticMarkup(
    <ComputerPanel
      agent={null}
      computer={computer}
      error={null}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Processes"');
  expect(html).not.toContain('Nothing on');
});

test('a preview is renewed in its last five minutes, and not before', () => {
  const now = Date.parse('2026-10-03T10:00:00Z');
  expect(previewDue(new Date(now + 6 * 60_000).toISOString(), now)).toBe(false);
  expect(previewDue(new Date(now + 4 * 60_000).toISOString(), now)).toBe(true);
  expect(previewDue(new Date(now - 1_000).toISOString(), now)).toBe(true);
});
