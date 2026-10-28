/**
 * A person in a room reads by their name, with a tell in angle brackets where
 * it matters who they are, and wherever two names in the room read alike. The
 * tell stays theirs in every room, unlike the handle the service labels them with.
 */
import { expect, test } from 'bun:test';
import { accountCode, nameText, roomNames, shownName } from './names.ts';

const alice = {
  principal_id: 'own_alice',
  display_name: 'Alice <k7q2mxwa>',
  email: 'alice.w@x.test',
};
const priya = { principal_id: 'own_priya', display_name: 'Priya Shah <h4ndl3ab>' };
const text = (label: string, names: ReturnType<typeof roomNames>, trust = false) =>
  nameText(shownName(label, names, { trust }));

test('a name nobody else in the room shares shows alone, and with its tell where it matters', () => {
  const names = roomNames([alice, priya]);
  expect(text(alice.display_name, names)).toBe('Alice');
  expect(text(alice.display_name, names, true)).toBe('Alice <alice.w>');
  // Without an email the tell is a code from the account.
  expect(text(priya.display_name, names, true)).toBe(`Priya Shah <${accountCode('own_priya')}>`);
  // Hovered or read aloud, the tell is there either way.
  expect(shownName(alice.display_name, names).code).toBe('alice.w');
});

test('a Cyrillic or fullwidth look-alike sets both apart, everywhere', () => {
  for (const lookalike of ['Аlice', 'Ａlice', 'ALıCE']) {
    const impostor = {
      principal_id: 'own_eve',
      display_name: `${lookalike} <p3vz8ndr>`,
      email: 'eve@y.test',
    };
    const names = roomNames([alice, impostor]);
    expect(text(alice.display_name, names)).toBe('Alice <alice.w>');
    expect(text(impostor.display_name, names)).toBe(`${lookalike} <eve>`);
  }
});

test('a name in brackets of its own does not pass for a tell', () => {
  const designer = {
    principal_id: 'own_bob',
    display_name: 'Alice (alice.w) <p3vz8ndr>',
    email: 'bob@y.test',
  };
  const names = roomNames([alice, designer]);
  // Not the same name, so neither shows a tell in passing; where it matters, each shows its own.
  expect(text(designer.display_name, names)).toBe('Alice (alice.w)');
  expect(text(designer.display_name, names, true)).toBe('Alice (alice.w) <bob>');
  expect(text(alice.display_name, names, true)).toBe('Alice <alice.w>');
});

test('people who have left count too, and their tell is a code from their account', () => {
  const left = { principal_id: 'own_old', display_name: 'alice <zz9yy8xx>' };
  const names = roomNames([alice], [left]);
  expect(text(alice.display_name, names)).toBe('Alice <alice.w>');
  expect(text(left.display_name, names)).toBe(`alice <${accountCode('own_old')}>`);
  // Two former members with one name are set apart from each other.
  const other = { principal_id: 'own_old2', display_name: 'Sam <aaaaaaaa>' };
  const again = { principal_id: 'own_old3', display_name: 'Sam <bbbbbbbb>' };
  const formers = roomNames([], [other, again]);
  expect(shownName(other.display_name, formers).tell).toBe(accountCode('own_old2'));
  expect(shownName(again.display_name, formers).tell).toBe(accountCode('own_old3'));
  // A member listed again among the thread's people is still one person.
  expect(shownName(alice.display_name, roomNames([alice], [alice])).tell).toBeNull();
});

test('the code is the same in every room, and emails that start the same fall back to it', () => {
  const here = roomNames([
    { principal_id: 'own_a', display_name: 'Ana <aaaaaaaa>', email: 'ana@one.test' },
    { principal_id: 'own_b', display_name: 'Ana <bbbbbbbb>', email: 'ana@two.test' },
  ]);
  const there = roomNames([
    { principal_id: 'own_a', display_name: 'Ana <cccccccc>' },
    { principal_id: 'own_b', display_name: 'Ana <dddddddd>' },
  ]);
  expect(shownName('Ana <aaaaaaaa>', here).tell).toBe(accountCode('own_a'));
  expect(shownName('Ana <cccccccc>', there).tell).toBe(accountCode('own_a'));
  expect(shownName('Ana <bbbbbbbb>', here).tell).toBe(accountCode('own_b'));
  expect(accountCode('own_a')).toMatch(/^[a-km-z2-9]{4}$/);
});

test('outside a room a name shows alone, and where it matters with its account code', () => {
  expect(nameText(shownName('Lena <zz9yy8xx>', null))).toBe('Lena');
  expect(nameText(shownName('Lena <zz9yy8xx>', null, { id: 'own_l', trust: true }))).toBe(
    `Lena <${accountCode('own_l')}>`,
  );
  expect(nameText(shownName('Lena <zz9yy8xx>', null, { trust: true }))).toBe('Lena <zz9yy8xx>');
});
