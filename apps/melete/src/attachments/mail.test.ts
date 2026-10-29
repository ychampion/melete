import { describe, expect, test } from 'bun:test';
import type { AttachmentKind } from '@melete/contracts';
import { mailContext } from '../connectors/mail-fixtures.ts';
import type { InboxAttachment } from '../connectors/mail-transport.ts';
import { TINY_PNG } from './fixtures.ts';
import { createMailImageReader, type MailImagePersistence } from './mail.ts';

const file: InboxAttachment & { content: Buffer } = {
  id: '1',
  name: 'statement.png',
  media_type: 'image/png',
  size: TINY_PNG.length,
  content: Buffer.from(TINY_PNG),
};

function fixture() {
  let job: { spaceId: string; principalId: string | null } | null = {
    spaceId: 'spc_test',
    principalId: 'person_test',
  };
  const files = new Map<string, { jobId: string | null; principalId: string | null }>();
  const uploaded: Parameters<MailImagePersistence['upload']>[] = [];
  const discarded: string[][] = [];
  let afterUpload = () => {};
  let image: { kind: AttachmentKind; has_preview: boolean } = {
    kind: 'image',
    has_preview: true,
  };
  const persistence: MailImagePersistence = {
    scope: async (ctx) => (job?.spaceId === ctx.space_id ? { ...job } : null),
    upload: async (scope, input) => {
      uploaded.push([scope, input]);
      files.set('file_test', { jobId: null, principalId: scope.principalId });
      afterUpload();
      return { id: 'file_test', ...image };
    },
    bind: async (ctx, scope, id) => {
      if (job?.spaceId !== scope.spaceId || job.principalId !== scope.principalId) return false;
      const found = files.get(id);
      if (!found || found.jobId !== null || found.principalId !== scope.principalId) return false;
      found.jobId = ctx.job_id;
      return true;
    },
    discard: async (ids) => {
      discarded.push([...ids]);
      for (const id of ids) if (files.get(id)?.jobId === null) files.delete(id);
    },
  };
  return {
    persistence,
    files,
    uploaded,
    discarded,
    setJob: (value: typeof job) => {
      job = value;
    },
    afterUpload: (callback: () => void) => {
      afterUpload = callback;
    },
    setImage: (value: typeof image) => {
      image = value;
    },
  };
}

describe('mail pictures kept for their own job', () => {
  test('keeps the original bytes for the current job under its stored principal', async () => {
    const state = fixture();
    const read = createMailImageReader(state.persistence);
    expect(await read({ ...mailContext(), job_id: 'job_child' }, file)).toBe('file_test');
    expect(state.files.get('file_test')).toEqual({
      jobId: 'job_child',
      principalId: 'person_test',
    });
    expect(state.uploaded[0]).toEqual([
      { spaceId: 'spc_test', principalId: 'person_test' },
      { name: file.name, mediaType: file.media_type, bytes: file.content },
    ]);
    expect(state.discarded).toEqual([]);
  });

  test('a missing job or a job in another space stores no file', async () => {
    for (const job of [null, { spaceId: 'spc_other', principalId: 'person_other' }]) {
      const state = fixture();
      state.setJob(job);
      await expect(createMailImageReader(state.persistence)(mailContext(), file)).rejects.toThrow();
      expect(state.files.size).toBe(0);
      expect(state.uploaded).toEqual([]);
    }
  });

  test('a changed principal during upload refuses binding and removes the unsent file', async () => {
    const state = fixture();
    state.afterUpload(() => state.setJob({ spaceId: 'spc_test', principalId: 'person_other' }));
    await expect(createMailImageReader(state.persistence)(mailContext(), file)).rejects.toThrow();
    expect(state.files.size).toBe(0);
    expect(state.discarded).toEqual([['file_test']]);
  });

  test('a binding failure preserves its error and removes the unsent file', async () => {
    const state = fixture();
    state.persistence.bind = async () => {
      throw new Error('Job ended while its picture was read');
    };
    await expect(createMailImageReader(state.persistence)(mailContext(), file)).rejects.toThrow(
      'Job ended while its picture was read',
    );
    expect(state.files.size).toBe(0);
  });

  test('a file without a model-sized image copy is refused and removed', async () => {
    const state = fixture();
    state.setImage({ kind: 'image', has_preview: false });
    await expect(createMailImageReader(state.persistence)(mailContext(), file)).rejects.toThrow();
    expect(state.files.size).toBe(0);
  });

  test('an aborted read removes the upload without binding it', async () => {
    const state = fixture();
    const abort = new AbortController();
    state.afterUpload(() => abort.abort());
    await expect(
      createMailImageReader(state.persistence)({ ...mailContext(), signal: abort.signal }, file),
    ).rejects.toThrow();
    expect(state.files.size).toBe(0);
    expect(state.discarded).toEqual([['file_test']]);
  });

  test('upload quota and validation refusals propagate without binding a file', async () => {
    const state = fixture();
    state.persistence.upload = async () => {
      throw new Error('Storage is full');
    };
    await expect(createMailImageReader(state.persistence)(mailContext(), file)).rejects.toThrow(
      'Storage is full',
    );
    expect(state.files.size).toBe(0);
    expect(state.discarded).toEqual([]);
  });
});
