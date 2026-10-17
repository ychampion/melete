/**
 * The Files screen: each file says where it is and where it came from, opens
 * in place only when the app can show it, downloads from the route that keeps
 * it, and offers Delete only where the service allows one.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { servesBrowser } from '../experience/adapter.ts';
import { AppContext, type AppContextValue } from '../experience/hooks.ts';
import type { PersonFile } from '../experience/types.ts';
import {
  deletedNote,
  FileRow,
  opensHere,
  StorageUse,
  storageAmount,
  storageLine,
  whereLine,
} from './Files.tsx';
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

test('a delete says until when it can be undone, and when the trash had to make room', () => {
  const until = '2026-10-18T15:00:00.000Z';
  expect(deletedNote(until, 0)).toBe('It’s in the trash until Oct 18.');
  expect(deletedNote(until, 1)).toBe(
    'It’s in the trash until Oct 18. The trash was full, so an earlier delete was taken out of it to make room and can no longer be put back.',
  );
  expect(deletedNote(until, 3)).toContain('3 earlier deletes were taken out of it');
});

test('a browser out of reach for a moment keeps the sites section; no browser route hides it', () => {
  expect(servesBrowser({ data: { sites: [] }, error: null, unavailable: null })).toBe(true);
  // The sites route answered, refusing for now: there is a browser, and Retry can reach it.
  expect(
    servesBrowser({
      data: null,
      error: 'Out of reach',
      unavailable: null,
      code: 'worker_unavailable',
    }),
  ).toBe(true);
  expect(
    servesBrowser({ data: null, error: 'No endpoint', unavailable: null, code: 'not_found' }),
  ).toBe(false);
  // A member of a shared space: its signed-in sites are its owner's, and no retry changes that.
  expect(
    servesBrowser({
      data: null,
      error: 'Not this space',
      unavailable: null,
      code: 'space_not_found',
    }),
  ).toBe(false);
  expect(
    servesBrowser({
      data: null,
      error: 'Signed out',
      unavailable: null,
      unauthorized: true,
      code: 'unauthorized',
    }),
  ).toBe(false);
  expect(servesBrowser({ data: null, error: 'Offline', unavailable: null })).toBe(false);
  expect(servesBrowser({ data: null, error: null, unavailable: 'Not here' })).toBe(false);
});

const GB = 1024 * 1024 * 1024;

test('storage use reads plainly against the limit, and says how to free space once full', () => {
  expect(storageAmount(300 * 1024 * 1024)).toBe('300 MB');
  expect(storageAmount(1.5 * GB)).toBe('1.5 GB');
  expect(storageLine({ used_bytes: 1.5 * GB, quota_bytes: 2 * GB })).toBe('Using 1.5 GB of 2 GB');
  const full = storageLine({ used_bytes: 2 * GB, quota_bytes: 2 * GB });
  expect(full).toContain('Your storage is full');
  expect(full).toContain('delete files you no longer need');
  const shown = renderToStaticMarkup(
    <StorageUse storage={{ used_bytes: 3 * GB, quota_bytes: 2 * GB }} />,
  );
  expect(shown).toContain('data-full="true"');
  expect(shown).toContain('width:100.0%');
});
