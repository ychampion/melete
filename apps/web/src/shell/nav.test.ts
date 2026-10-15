import { expect, test } from 'bun:test';
import { NAV, sidebarNav } from './nav.ts';

test("a guest's sidebar lists the rooms and no personal surface", () => {
  expect(sidebarNav(true).map((item) => item.path)).toEqual(['/rooms']);
  const personal = sidebarNav(false).map((item) => item.path);
  expect(personal).toEqual(NAV.map((item) => item.path));
  for (const path of [
    '/',
    '/chat',
    '/runs',
    '/agents',
    '/apps',
    '/automations',
    '/companies',
    '/files',
  ])
    expect(personal).toContain(path);
});

test('Rooms is listed only when the server has rooms switched on', () => {
  const off = sidebarNav(false, false).map((item) => item.path);
  expect(off).not.toContain('/rooms');
  expect(off).toEqual(NAV.map((item) => item.path).filter((path) => path !== '/rooms'));
  expect(sidebarNav(false, true).map((item) => item.path)).toContain('/rooms');
});

test("a member of someone else's space has no Agents or Memory section, and keeps the rest", () => {
  const member = sidebarNav(false, true, true).map((item) => item.path);
  expect(member).not.toContain('/agents');
  expect(member).not.toContain('/settings/memory');
  expect(member).toEqual(
    NAV.map((item) => item.path).filter(
      (path) => path !== '/agents' && path !== '/settings/memory',
    ),
  );
  expect(sidebarNav(false, false, true).map((item) => item.path)).not.toContain('/rooms');
});
