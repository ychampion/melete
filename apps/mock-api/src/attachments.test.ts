import { describe, expect, test } from 'bun:test';
import {
  attachmentResponse,
  conversationResponse,
  errorResponse,
  messageAcceptance,
  turnList,
} from '@melete/contracts';
import { createMock } from './index.ts';

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

async function upload(app: ReturnType<typeof createMock>['app'], file: File) {
  const form = new FormData();
  form.append('file', file);
  return app.request('/attachments', { method: 'POST', body: form });
}

describe('files in the mock', () => {
  test('an upload answers as the service does, and a message carries its files', async () => {
    const { app } = createMock({ speed: 0 });
    const refused = await upload(
      app,
      new File([new Uint8Array(4)], 'archive.zip', { type: 'application/zip' }),
    );
    expect(refused.status).toBe(415);
    expect(errorResponse.parse(await refused.json()).error.message).toStartWith(
      "Melete can't read .zip files.",
    );
    const made = await upload(app, new File([PNG], 'photo.png', { type: 'image/png' }));
    expect(made.status).toBe(201);
    const photo = attachmentResponse.parse(await made.json()).attachment;
    expect(photo).toMatchObject({ kind: 'image', has_preview: true });
    const preview = await app.request(`/attachments/${photo.id}/content?variant=preview`);
    expect(preview.headers.get('content-type')).toBe('image/png');

    const agents = (await (await app.request('/agents')).json()) as { agents: { id: string }[] };
    const created = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Photo', agent_id: agents.agents[0]?.id }),
    });
    const id = conversationResponse.parse(await created.json()).conversation.id;
    const sent = await app.request(`/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: JSON.stringify({ text: '', attachments: [photo.id] }),
    });
    expect(sent.status).toBe(200);
    const turnId = messageAcceptance.parse(await sent.json()).turn_id;
    const turns = turnList.parse(await (await app.request(`/conversations/${id}/messages`)).json());
    expect(turns.turns.find((turn) => turn.id === turnId)?.attachments?.[0]?.id).toBe(photo.id);
    // Sent, it goes with its chat and cannot be taken back alone.
    expect((await app.request(`/attachments/${photo.id}`, { method: 'DELETE' })).status).toBe(409);
  });
});
