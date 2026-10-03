/**
 * Documents and pictures in the files tools: a read gives the words of a PDF,
 * a Word document or a spreadsheet, and a plain note for any other binary
 * file; a file the person sent in chat can be saved into the job's workspace.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectorManifest } from '@melete/contracts';
import { docxWith, pdfWith, TINY_PNG, xlsxWith } from '../attachments/fixtures.ts';
import { createFilesConnector, filesManifest, type SentFiles } from './files.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-files-'));
  await mkdir(path.join(root, 'work', 'job_01'), { recursive: true });
  await mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true });
});
afterEach(async () => {
  if (path.basename(root).startsWith('melete-files-'))
    await rm(root, { recursive: true, force: true });
});

const LEASE = pdfWith(['The lease starts in May.', 'Rent is due on the first.']);
/** The chat's one sent file; any other id, or any other job, has none. */
const sent: SentFiles = {
  forJob: async (jobId, id) =>
    jobId === 'job_01' && id === 'file_LEASE' ? { name: 'lease.pdf', bytes: LEASE } : null,
};
const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
    attachments: sent,
  });
const run = async (kind: string, payload: Record<string, unknown>) => {
  const action = connectorAction(kind, payload);
  return connector().execute(action, connectorContext(action));
};
const detail = async (kind: string, payload: Record<string, unknown>) => {
  const result = await run(kind, payload);
  if (result.outcome !== 'succeeded') throw new Error(`expected ${kind} to succeed`);
  return result.receipt.detail;
};
const put = (name: string, bytes: Uint8Array | string) =>
  writeFile(path.join(root, 'work', 'job_01', name), bytes);

describe('files.read on documents and other binaries', () => {
  test('a PDF gives its text with page markers', async () => {
    await put('lease.pdf', LEASE);
    const read = await detail('files.read', { path: 'lease.pdf' });
    expect(read.format).toBe('pdf');
    expect(read.pages).toBe(2);
    expect(read.content).toContain('[Page 2]\nRent is due on the first.');
    expect(read.content_hash).toBe(createHash('sha256').update(LEASE).digest('hex'));
  });

  test('a Word document and a spreadsheet give their words', async () => {
    await put('report.docx', docxWith(['Water damage in the kitchen.']));
    await put('budget.xlsx', xlsxWith({ May: [['Rent', 2400]] }));
    expect(await detail('files.read', { path: 'report.docx' })).toMatchObject({
      format: 'docx',
      content: 'Water damage in the kitchen.',
    });
    expect(await detail('files.read', { path: 'budget.xlsx' })).toMatchObject({
      format: 'xlsx',
      content: '[Sheet: May]\nRent,2400',
    });
  });

  test('a picture or another binary succeeds with a note saying why there is no text', async () => {
    await put('photo.png', TINY_PNG);
    await put('blob.bin', Uint8Array.from([0, 1, 2, 3, 255]));
    const picture = await detail('files.read', { path: 'photo.png' });
    expect(picture.content).toBeNull();
    expect(String(picture.note)).toContain('"photo.png" is a picture');
    const binary = await detail('files.read', { path: 'blob.bin' });
    expect(binary.content).toBeNull();
    expect(String(binary.note)).toContain('is a binary file of 5 bytes');
  });

  test('a scanned PDF with no text says so', async () => {
    await put('scan.pdf', pdfWith(['']));
    const read = await detail('files.read', { path: 'scan.pdf' });
    expect(read.content).toBeNull();
    expect(String(read.note)).toContain('may be scanned');
  });
});

describe('files.save_attachment', () => {
  test('is a declared tool of the files connection', () => {
    connectorManifest.parse(filesManifest);
    const tool = filesManifest.tools.find((entry) => entry.name === 'files.save_attachment');
    expect(tool?.effect_class).toBe('write_reversible');
    expect(tool?.required_scopes).toEqual(['files.write']);
  });

  test("copies the chat's file into the workspace, readable by the agent's computer, and verifies it", async () => {
    const payload = { attachment_id: 'file_LEASE', path: 'in/lease.pdf' };
    const saved = await detail('files.save_attachment', payload);
    expect(saved).toMatchObject({
      path: 'in/lease.pdf',
      area: 'work',
      name: 'lease.pdf',
      bytes: LEASE.length,
    });
    const target = path.join(root, 'work', 'job_01', 'in', 'lease.pdf');
    expect(Buffer.from(await readFile(target)).equals(Buffer.from(LEASE))).toBe(true);
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o044).toBe(0o044);
    // A retry of the same save finds its own bytes and succeeds again.
    expect((await run('files.save_attachment', payload)).outcome).toBe('succeeded');
    const action = connectorAction('files.save_attachment', payload);
    expect((await connector().verify(action, connectorContext(action))).decision).toBe('succeeded');
    // And the agent can read it back as text.
    expect(String((await detail('files.read', { path: 'in/lease.pdf' })).content)).toContain(
      'The lease starts in May.',
    );
  });

  test("never replaces another file, and refuses a file that is not this chat's", async () => {
    await put('taken.pdf', 'something else');
    await expect(
      run('files.save_attachment', { attachment_id: 'file_LEASE', path: 'taken.pdf' }),
    ).rejects.toThrow('there is already a file at "taken.pdf"');
    expect(await readFile(path.join(root, 'work', 'job_01', 'taken.pdf'), 'utf8')).toBe(
      'something else',
    );
    await expect(
      run('files.save_attachment', { attachment_id: 'file_OTHER', path: 'x.pdf' }),
    ).rejects.toThrow('there is no attached file file_OTHER in this chat');
    await expect(
      run('files.save_attachment', { attachment_id: 'file_LEASE', path: '../x.pdf' }),
    ).rejects.toThrow();
  });
});
