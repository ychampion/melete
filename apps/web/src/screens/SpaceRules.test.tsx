/**
 * Space rules: owners see the tab and members do not, and what is typed into a
 * list goes in once, in the form the service keeps it.
 */
import { expect, test } from 'bun:test';
import { settingsTab, showsTab } from './Settings.tsx';
import { addTo } from './SpaceRules.tsx';

test('the space rules tab is the owner’s, and a member is sent to their account', () => {
  expect(showsTab('space-rules', false)).toBe(true);
  expect(showsTab('space-rules', true)).toBe(false);
  expect(settingsTab('space-rules', false)).toBe('space-rules');
  expect(settingsTab('space-rules', true)).toBe('account');
});

test('a kind is kept in lower case and once; a model keeps its own case', () => {
  expect(addTo([], 'denied_tool_kinds', '  Email.Send ')).toEqual(['email.send']);
  expect(addTo(['email.send'], 'denied_tool_kinds', 'EMAIL.SEND')).toEqual(['email.send']);
  expect(addTo([], 'denied_connector_kinds', '   ')).toEqual([]);
  expect(addTo([], 'allowed_models', ' openai/GPT-Fixture ')).toEqual(['openai/GPT-Fixture']);
});
