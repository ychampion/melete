/**
 * A card asking to send something from a connected account says what it does
 * first; the exact request it binds (address, text, headers) folds under
 * Details, still whole for anyone who opens it.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResultCard as ResultCardData } from '../experience/types.ts';
import { ResultCard } from './parts.tsx';

const issue: ResultCardData = {
  id: 'act_1',
  title: 'Open an issue: Printer jams on page two',
  meta: 'GitHub for the agent’s computer',
  facts: [
    { label: 'Request', value: 'POST https://api.github.com/graphql' },
    { label: 'Changes', value: 'createIssue' },
    {
      label: 'Details',
      value: 'mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { url } } }',
    },
    { label: 'Headers', value: 'accept: application/vnd.github.merge-info-preview+json' },
  ],
  primary_action: null,
  secondary_actions: [],
  source_connection: null,
};

test('the plain summary leads, and the raw request is behind Details', () => {
  const html = renderToStaticMarkup(<ResultCard card={issue} readOnly />);
  expect(html).toContain('Open an issue: Printer jams on page two');
  const [before, folded = ''] = html.split('<details class="raw-request">');
  expect(before).toContain('createIssue');
  expect(before).not.toContain('mutation(');
  expect(before).not.toContain('application/vnd.github');
  expect(folded).toStartWith('<summary>Details</summary>');
  expect(folded).toContain('mutation(');
  expect(folded).toContain('accept: application/vnd.github.merge-info-preview+json');
  expect(folded).toContain('POST https://api.github.com/graphql');
});

test('a card that sends no request keeps every fact in view', () => {
  const html = renderToStaticMarkup(
    <ResultCard
      card={{ ...issue, facts: [{ label: 'Details', value: 'Table for two at 8 pm' }] }}
      readOnly
    />,
  );
  expect(html).not.toContain('<details');
  expect(html).toContain('Table for two at 8 pm');
});
