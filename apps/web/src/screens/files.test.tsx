/**
 * The Files screen: each file says where it is and where it came from, opens
 * in place only when the app can show it, downloads from the route that keeps
 * it, and offers Delete only where the service allows one.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue } from '../experience/hooks.ts';
import type { PersonFile } from '../experience/types.ts';
import { FileRow, opensHere, whereLine } from './Files.tsx';
import { lastUsed, SignedInSites } from './Privacy.tsx';

const NOW = Date.parse('2026-10-10T15:00:00.000Z');

const file = (over: Partial<PersonFile> = {}): PersonFile => ({
  id: 'act_01',
  name: 'budget.md',
  path: 'budget.md',
  place: 'files',
  mime: 'text/markdown',
  size: 2048,
  saved_at: '2026-10-08T09:00:00.000Z',
  chat: { id: 'job_01', title: 'Trip to Lisbon' },
  deletable: true,
  ...over,
});

const row = (value: PersonFile) =>
  renderToStaticMarkup(
    <ul>
      <FileRow file={value} now={NOW} onOpen={() => {}} onDelete={() => {}} />
    </ul>,
  );

test('the line under a file says where it is, its size and when it was saved', () => {
  expect(whereLine(file(), NOW)).toBe('In your Files · 2 KB · Oct 8');
  expect(whereLine(file({ path: 'reports/q3/budget.md' }), NOW)).toBe(
    'In your Files › reports/q3 · 2 KB · Oct 8',
  );
  expect(whereLine(file({ place: 'chat' }), NOW)).toStartWith('Made in a chat');
  expect(whereLine(file({ place: 'sent', size: 900 }), NOW)).toStartWith('You sent it · 900 bytes');
  expect(whereLine(file({ saved_at: '2025-12-01T09:00:00.000Z' }), NOW)).toEndWith('Dec 1, 2025');
});

test('only a PDF, a picture or text opens in place; anything else downloads', () => {
  for (const mime of ['application/pdf', 'image/png', 'text/markdown', 'text/csv'])
    expect(opensHere({ mime })).toBe(true);
  for (const mime of [
    'text/html',
    'image/svg+xml',
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])
    expect(opensHere({ mime })).toBe(false);
});

test('a saved file opens here, downloads, links its chat and can be deleted', () => {
  const html = row(file());
  expect(html).toContain('aria-label="Open budget.md"');
  expect(html).toContain('/files/act_01/content"');
  expect(html).toContain('aria-label="Download budget.md"');
  expect(html).toContain('aria-label="Delete budget.md"');
  expect(html).toContain('#/chat/job_01');
  expect(html).toContain('Trip to Lisbon');
});

test('a file the app cannot show is a download, and a sent file has no Delete', () => {
  const page = row(file({ id: 'art_01', name: 'site.html', mime: 'text/html' }));
  expect(page).not.toContain('aria-label="Open site.html"');
  expect(page).toContain('/artifacts/art_01/content"');
  const sent = row(
    file({
      id: 'file_01',
      name: 'passport.png',
      mime: 'image/png',
      place: 'sent',
      deletable: false,
    }),
  );
  expect(sent).toContain('/attachments/file_01/content"');
  expect(sent).not.toContain('Delete passport.png');
});

test('signed-in sites say when each was last used, and are not shown without a browser', () => {
  expect(lastUsed('2026-10-10T09:00:00.000Z', NOW)).toBe('Last used today');
  expect(lastUsed('2026-10-02T09:00:00.000Z', NOW)).toBe('Last used Oct 2');
  const app = { capabilities: { browser: false } } as unknown as AppContextValue;
  expect(
    renderToStaticMarkup(
      <AppContext.Provider value={app}>
        <SignedInSites />
      </AppContext.Provider>,
    ),
  ).toBe('');
});
