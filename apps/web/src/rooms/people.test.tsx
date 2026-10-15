/**
 * The line under "Add people" says what the search found: nobody with that
 * email, someone already in the room, or how to find someone else.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Person } from './api.ts';
import { AddPeopleHint } from './People.tsx';

const priya: Person = { id: 'own_1', display_name: 'Priya Shah', email: 'priya@example.com' };
const hint = (query: string, people: Person[], inRoom: string[] = []) =>
  renderToStaticMarkup(<AddPeopleHint query={query} people={people} inRoom={new Set(inRoom)} />);

test('a whole email with no account here offers a guest invite instead', () => {
  const html = hint('nobody@example.com', []);
  expect(html).toContain('No account here uses that email. You can invite them as a guest below.');
  expect(html).not.toContain('type their whole email');
});

test('someone the search found who is already in the room is said to be there', () => {
  const html = hint('priya@example.com', [priya], [priya.id]);
  expect(html).toContain('They are already in this room.');
  expect(html).not.toContain('type their whole email');
});

test('a name that matches nobody still says how to find someone else', () => {
  expect(hint('pri', [])).toContain(
    'Nobody you share a space with matches that. To add someone else, type their whole email address.',
  );
  expect(hint('', [priya], [priya.id])).toContain(
    'Everyone you share a space with is already in the room.',
  );
});
