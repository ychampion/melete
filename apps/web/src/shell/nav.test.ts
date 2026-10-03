import { expect, test } from 'bun:test';
import { NAV, sidebarNav } from './nav.ts';

test("a guest's sidebar lists the rooms and no personal surface", () => {
  expect(sidebarNav(true).map((item) => item.path)).toEqual(['/rooms']);
  const personal = sidebarNav(false).map((item) => item.path);
  expect(personal).toEqual(NAV.map((item) => item.path));
  for (const path of ['/', '/chat', '/runs', '/agents', '/apps', '/automations', '/companies'])
    expect(personal).toContain(path);
});
