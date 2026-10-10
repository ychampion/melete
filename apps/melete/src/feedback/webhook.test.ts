import { expect, test } from 'bun:test';
import type { FeedbackReport } from '@melete/contracts';
import { reportMarkdown } from './markdown.ts';
import { feedbackWebhook } from './routes.ts';

const report: FeedbackReport = {
  id: 'FB-7K3Q',
  status: 'open',
  message: 'The plan list is empty\nIt was full yesterday.',
  summary: 'The plan list is empty',
  route: '#/plans',
  app_version: '0.0.0',
  context: {},
  reporter: { principal_id: null, email: 'member@example.test' },
  note: null,
  created_at: '2026-09-30T10:00:00.000Z',
  updated_at: '2026-09-30T10:00:00.000Z',
};

test('a new report is posted as JSON, with a line a chat shows and the report itself', async () => {
  const sent: Request[] = [];
  const forward = feedbackWebhook(
    'https://hooks.example.test/melete',
    'https://melete.example.com',
    async (request) => {
      sent.push(request);
      return new Response(null, { status: 204 });
    },
  );
  await forward(report);
  expect(sent).toHaveLength(1);
  const request = sent[0] as Request;
  expect(request.method).toBe('POST');
  expect(request.url).toBe('https://hooks.example.test/melete');
  expect(request.headers.get('content-type')).toBe('application/json');
  expect(await request.json()).toEqual({
    text: 'New Melete problem report FB-7K3Q on https://melete.example.com: The plan list is empty',
    service: 'melete',
    installation: 'https://melete.example.com',
    report,
    markdown: reportMarkdown(report),
  });
});

test('an endpoint that refuses the report is an error the caller logs', async () => {
  const forward = feedbackWebhook(
    'https://hooks.example.test/melete',
    null,
    async () => new Response('no', { status: 500 }),
  );
  await expect(forward(report)).rejects.toThrow('feedback webhook answered 500');
});
