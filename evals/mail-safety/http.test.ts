import { expect, test } from 'bun:test';
import corpus from './corpus.json' with { type: 'json' };
import { AppHttp, readFrames, submitNotice } from './http.ts';

test('photo upload sends bytes then attachment IDs, without OCR text', async () => {
  const requests: ReturnType<Request['clone']>[] = [];
  const http = new AppHttp('https://app.example.test', 'session=opaque', async (req) => {
    requests.push(req.clone());
    return Response.json(
      requests.length === 1
        ? { attachment: { id: 'file-1' } }
        : { thread: { id: 'thread-1' }, request_job_id: 'job-1' },
      { status: 201 },
    );
  });
  const c = corpus.cases.find((c) => c.format === 'image')!;
  await submitNotice(
    http,
    { roomId: 'room-1', helperLabel: 'Room helper' },
    c,
    new Uint8Array([137, 80, 78, 71]),
    'submission-1',
  );
  const data = await requests[0]!.formData();
  expect(new Uint8Array(await (data.get('file') as File).arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  );
  const posted = (await requests[1]!.json()) as { attachments: string[] };
  expect(posted.attachments).toEqual(['file-1']);
  expect(JSON.stringify(posted)).not.toContain(c.body);
});

test('credentials cannot cross origins or redirects', async () => {
  let count = 0;
  const http = new AppHttp('https://app.example.test', 'secret', async (req) => {
    count++;
    expect(req.redirect).toBe('error');
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } });
  });
  await expect(http.json('/rooms')).rejects.toThrow('redirect');
  await expect(http.json('https://elsewhere.example/rooms')).rejects.toThrow('origin');
  expect(count).toBe(1);
});

test('event reconnect resumes its cursor and records bounded polling fallback', async () => {
  let calls = 0;
  const http = new AppHttp('https://app.example.test', 'opaque', async (req) => {
    calls++;
    if (calls === 1)
      return new Response('id: 7\ndata: {"seq":7,"kind":"message"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    expect(new URL(req.url).searchParams.get('after')).toBe('7');
    if (calls === 2) throw new Error('disconnected');
    return Response.json({ frames: [{ seq: 8, kind: 'message' }], next_cursor: 8 });
  });
  const first = await readFrames(http, '/events', 0);
  const next = await readFrames(http, '/events', first.cursor);
  expect(first.cursor).toBe(7);
  expect(next).toMatchObject({ cursor: 8, mode: 'bounded-poll-fallback' });
  expect(next.frames.map((f) => f.seq)).toEqual([8]);
});
