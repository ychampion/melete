import { expect, test } from 'bun:test';
import type { AgentInput } from '../experience/types.ts';
import { draftKey, followSaved } from './agent-draft.ts';

const saved = (over: Partial<AgentInput> = {}): AgentInput => ({
  name: 'Nova',
  role: 'Concierge',
  colour: '#3a6ea5',
  surface: 'blob',
  eye_colour: '#ffffff',
  tone: 'Warm',
  standing_instruction: 'Confirm before paying.',
  allowed_connection_ids: null,
  asks_before_acting: true,
  ...over,
});

test('a rebuilt copy of the same agent keeps the same key, so a refresh changes nothing', () => {
  expect(draftKey('ag_1', saved())).toBe(draftKey('ag_1', saved()));
  expect(draftKey('ag_1', saved())).not.toBe(draftKey('ag_1', saved({ tone: 'Brisk' })));
  expect(draftKey('ag_1', saved())).not.toBe(draftKey('ag_2', saved()));
  expect(draftKey('ag_1', null)).toBeNull();
});

test('an untouched draft follows the saved agent', () => {
  const next = saved({ tone: 'Brisk', allowed_connection_ids: ['conn_1'] });
  expect(followSaved(saved(), saved(), next)).toEqual(next);
});

test('what the person typed survives a change to the saved agent', () => {
  const draft = saved({ name: 'Nova the Great', standing_instruction: 'Ask me first.' });
  const next = saved({ tone: 'Brisk' });
  expect(followSaved(draft, saved(), next)).toEqual({
    ...next,
    name: 'Nova the Great',
    standing_instruction: 'Ask me first.',
  });
});

test('an edited list stays as the person left it', () => {
  const draft = saved({ allowed_connection_ids: ['conn_1'] });
  const next = saved({ allowed_connection_ids: ['conn_2'] });
  expect(followSaved(draft, saved(), next).allowed_connection_ids).toEqual(['conn_1']);
});

test('a face picked for a new agent applies without clearing the name being typed', () => {
  const draft = saved({ name: 'Iris' });
  const next = saved({ colour: '#aa3355', surface: 'gear' });
  const merged = followSaved(draft, saved(), next);
  expect(merged.name).toBe('Iris');
  expect(merged.colour).toBe('#aa3355');
  expect(merged.surface).toBe('gear');
});

test('a photo removed from the saved agent leaves an untouched draft too', () => {
  const withPhoto = saved({ face_image: 'https://example.test/face.png' });
  expect('face_image' in followSaved(withPhoto, withPhoto, saved())).toBe(false);
});
