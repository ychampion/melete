/**
 * A person in a room reads by their name alone. Only two people in the same
 * room with the same name get something after it, and that stays theirs in
 * every room, unlike the handle the service labels them with.
 */
import { expect, test } from 'bun:test';
import { accountCode, nameText, roomNames, shownName } from './names.ts';

const sam = { principal_id: 'own_sam', display_name: 'Sam <k7q2mxwa>', email: 'sam.okafor@x.test' };
const otherSam = {
  principal_id: 'own_sam2',
  display_name: 'sam  <p3vz8ndr>',
  email: 'sam.lee@y.test',
};
const priya = { principal_id: 'own_priya', display_name: 'Priya Shah <h4ndl3ab>' };

test('a name nobody else in the room has shows alone, with no handle', () => {
  const names = roomNames([sam, priya]);
  expect(shownName(sam.display_name, names)).toEqual({ name: 'Sam', tell: null });
  expect(nameText(shownName(priya.display_name, names))).toBe('Priya Shah');
  // A label from outside the room still drops the handle.
  expect(nameText(shownName('Lena <zz9yy8xx>', names))).toBe('Lena');
  expect(nameText(shownName('Lena <zz9yy8xx>', null))).toBe('Lena');
});

test('two people with the same name are told apart by their email before the @', () => {
  const names = roomNames([sam, otherSam, priya]);
  expect(nameText(shownName(sam.display_name, names))).toBe('Sam (sam.okafor)');
  expect(nameText(shownName(otherSam.display_name, names))).toBe('sam (sam.lee)');
  expect(shownName(priya.display_name, names).tell).toBeNull();
});

test('without emails, the tell is a code from the account, the same in every room', () => {
  const guestView = [
    { principal_id: 'own_sam', display_name: 'Sam <aaaaaaaa>' },
    { principal_id: 'own_sam2', display_name: 'Sam <bbbbbbbb>' },
  ];
  // The same two people in another room: other handles, the same tells.
  const elsewhere = [
    { principal_id: 'own_sam', display_name: 'Sam <cccccccc>' },
    { principal_id: 'own_sam2', display_name: 'Sam <dddddddd>' },
  ];
  const here = roomNames(guestView);
  const there = roomNames(elsewhere);
  const first = shownName('Sam <aaaaaaaa>', here).tell;
  expect(first).toBe(accountCode('own_sam'));
  expect(shownName('Sam <cccccccc>', there).tell).toBe(first);
  expect(shownName('Sam <bbbbbbbb>', here).tell).toBe(accountCode('own_sam2'));
  expect(first).not.toBe(accountCode('own_sam2'));
  expect(first).toMatch(/^[a-km-z2-9]{4}$/);
});

test('emails that start the same fall back to the account code', () => {
  const names = roomNames([
    { principal_id: 'own_a', display_name: 'Ana <aaaaaaaa>', email: 'ana@one.test' },
    { principal_id: 'own_b', display_name: 'Ana <bbbbbbbb>', email: 'ana@two.test' },
  ]);
  expect(shownName('Ana <aaaaaaaa>', names).tell).toBe(accountCode('own_a'));
  expect(shownName('Ana <bbbbbbbb>', names).tell).toBe(accountCode('own_b'));
});
