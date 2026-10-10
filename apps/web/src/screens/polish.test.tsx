/**
 * Small readings across the app: days said the way a person says them, the
 * same detail shown once, a routine's repeats folded, a result opening at its
 * own answer, and a disconnected computer that can be taken off the list.
 */
import { expect, test } from 'bun:test';
import { MORNING_BRIEF_TITLE } from '@melete/contracts/morning-brief';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewWords } from '../chat/parts.tsx';
import { pastDay } from '../experience/past-day.ts';
import type {
  ActionReview,
  Automation,
  AutomationRun,
  Belief,
  Conversation,
  Device,
  Run,
} from '../experience/types.ts';
import { lineUnderStatus } from '../runs/words.ts';
import { sourceLine } from './Activity.tsx';
import { distinctRuns } from './Automations.tsx';
import { sameDetailOnce } from './Beliefs.tsx';
import { withFresh } from './Chats.tsx';
import { DeviceCard } from './Devices.tsx';
import { endedMorningBrief } from './MorningBrief.tsx';
import { categoryOf, PLAN_CATEGORIES } from './Plans.tsx';
import { resultPath } from './RoutineResults.tsx';

test('a past day reads Today, Yesterday, a weekday this week, then a date', () => {
  const now = new Date(2026, 9, 10, 15, 0).getTime();
  expect(pastDay(new Date(2026, 9, 10, 8, 0), now)).toBe('Today');
  expect(pastDay(new Date(2026, 9, 9, 23, 0), now)).toBe('Yesterday');
  expect(pastDay(new Date(2026, 9, 6, 12, 0), now)).toBe('Tue');
  expect(pastDay(new Date(2026, 9, 1, 12, 0), now)).toBe('Oct 1');
  expect(pastDay(new Date(2025, 11, 30, 12, 0), now)).toBe('Dec 30, 2025');
});

test('the same words saved twice show once, the first kept and the copy behind it', () => {
  const belief = (id: string, value: string) => ({ id, value }) as Belief;
  const rows = sameDetailOnce([
    belief('b1', 'Can be home Thursday afternoon'),
    belief('b2', 'can be home thursday afternoon.'),
    belief('b3', 'Prefers aisle seats'),
  ]);
  expect(rows.map((row) => row.belief.id)).toEqual(['b1', 'b3']);
  expect(rows[0]?.twins).toEqual(['b2']);
  expect(rows[1]?.twins).toEqual([]);
});

test('two runs that ended the same way in the same minute read as one', () => {
  const run = (id: string, started_at: string, summary: string) =>
    ({ id, status: 'done', started_at, summary, reason: null }) as unknown as AutomationRun;
  const runs = distinctRuns([
    run('r1', '2026-10-09T08:30:05.000Z', 'Sent your brief'),
    run('r2', '2026-10-09T08:30:40.000Z', 'Sent your brief'),
    run('r3', '2026-10-08T08:30:05.000Z', 'Sent your brief'),
  ]);
  expect(runs.map((item) => item.id)).toEqual(['r1', 'r3']);
});

test('Open result goes to the run’s own answer in the routine’s chat', () => {
  expect(resultPath('job_1', 'turn_9')).toBe('/chat/job_1?turn=turn_9');
  expect(resultPath('job_1', null)).toBe('/chat/job_1');
});

test('an ended morning brief is offered to start again rather than set up twice', () => {
  const brief = (ended: boolean) =>
    ({ id: 'trg_1', title: MORNING_BRIEF_TITLE, ended }) as Automation;
  expect(endedMorningBrief([brief(true)])?.id).toBe('trg_1');
  expect(endedMorningBrief([brief(false)])).toBeNull();
});

test('the chat list takes in chats started or renamed since it was read', () => {
  const chat = (id: string, title: string, updated_at: string) =>
    ({ id, title, updated_at }) as Conversation;
  const paged = [chat('a', 'Old name', '2026-10-09T08:00:00.000Z')];
  const fresh = [
    chat('b', 'New chat', '2026-10-09T09:00:00.000Z'),
    chat('a', 'New name', '2026-10-09T08:30:00.000Z'),
  ];
  expect(withFresh(paged, fresh, true).map((item) => [item.id, item.title])).toEqual([
    ['b', 'New chat'],
    ['a', 'New name'],
  ]);
  expect(withFresh(paged, [], true)).toEqual(paged);
});

test('the line under a status pill does not repeat the pill', () => {
  const run = (status: Run['status'], status_line: string, report: string | null = null) =>
    ({
      status,
      status_line,
      latest_report: report ? { title: report } : null,
    }) as Pick<Run, 'status' | 'status_line' | 'latest_report'>;
  expect(lineUnderStatus(run('done', 'Done · checked'), 'Done')).toBe('Checked');
  expect(lineUnderStatus(run('done', 'Done'), 'Done')).toBeNull();
  expect(lineUnderStatus(run('working', 'Working on it', 'Found three flights'), 'Working')).toBe(
    'Found three flights',
  );
});

test('a plan about the house or the job gets its own category', () => {
  expect(categoryOf('Renovate the kitchen')).toBe('home');
  expect(categoryOf('Find a new job')).toBe('work');
  expect(PLAN_CATEGORIES).toContain('home');
  expect(PLAN_CATEGORIES).toContain('work');
});

test('why Melete went ahead reads as one plain sentence', () => {
  const review = (outcome: ActionReview['outcome'], reason: string) =>
    ({
      outcome,
      by: 'policy',
      reason,
      risk: null,
      reviewed_at: '2026-10-09T08:00:00.000Z',
    }) as ActionReview;
  expect(reviewWords(review('auto_approved', 'It only reads a file you shared.'))).toBe(
    'Went ahead without asking you, because it only reads a file you shared.',
  );
  expect(reviewWords(review('escalated', 'Sending email needs you'))).toBe(
    'Asking you, because sending email needs you.',
  );
});

test('Activity says the chat an entry came from was deleted', () => {
  expect(
    sourceLine({ where: 'Gmail', source: 'Trip to Kyoto', reference: 'A12', undone_at: null }),
  ).toBe('Gmail · from “Trip to Kyoto”, since deleted · ref A12');
});

const device = (status: Device['status']) =>
  ({
    id: 'dev_1',
    name: 'Studio laptop',
    platform: 'macos',
    status,
    browser_connected: false,
    last_seen_at: '2026-10-09T08:00:00.000Z',
    revoked_at: status === 'revoked' ? '2026-10-09T08:30:00.000Z' : null,
    folders: [],
    capabilities: {
      commands: false,
      files: true,
      open_url: true,
      screenshot: false,
      browser: false,
    },
    local_capabilities: {
      commands: false,
      files: true,
      open_url: true,
      screenshot: false,
      browser: false,
    },
    cloud_screenshots: null,
  }) as unknown as Device;
const card = (status: Device['status']) =>
  renderToStaticMarkup(
    <DeviceCard device={device(status)} onChanged={() => {}} screensByDefault={false} />,
  );

test('a disconnected computer can be removed; a connected one is disconnected first', () => {
  const gone = card('revoked');
  expect(gone).toContain('aria-label="Remove Studio laptop"');
  expect(gone).not.toContain('>Disconnect<');
  const online = card('online');
  expect(online).not.toContain('Remove Studio laptop');
  expect(online).toContain('Disconnect');
});
