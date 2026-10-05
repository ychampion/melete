import { expect, test } from 'bun:test';
import { NAV, sidebarNav } from './nav.ts';

test("a guest's sidebar lists the rooms and no personal surface", () => {
  expect(sidebarNav(true).map((item) => item.path)).toEqual(['/rooms']);
  const personal = sidebarNav(false).map((item) => item.path);
  expect(personal).toEqual(NAV.map((item) => item.path));
  for (const path of ['/', '/chat', '/runs', '/agents', '/apps', '/automations', '/companies'])
    expect(personal).toContain(path);
});

test('Rooms is listed only when the server has rooms switched on', () => {
  const off = sidebarNav(false, false).map((item) => item.path);
  expect(off).not.toContain('/rooms');
  expect(off).toEqual(NAV.map((item) => item.path).filter((path) => path !== '/rooms'));
  expect(sidebarNav(false, true).map((item) => item.path)).toContain('/rooms');
});
