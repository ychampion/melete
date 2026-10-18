import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFilesConnector } from './files.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

/**
 * Files the agent makes with code are often binary: a presentation, a
 * picture, an archive. Each must reach the person's Files the way a text file
 * does, including from a folder the agent's code made that the service may
 * read but not change.
 */

let root: string;
let unlock: (() => void) | null = null;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-deliver-'));
  await Promise.all([
    mkdir(path.join(root, 'work', 'job_01'), { recursive: true }),
    mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true }),
  ]);
});
afterEach(async () => {
  unlock?.();
  unlock = null;
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`) ||
    !path.basename(root).startsWith('melete-deliver-')
  ) {
    throw new Error('refusing fixture cleanup outside the temp root');
  }
  await rm(resolved, { recursive: true, force: true });
});

const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });
const work = (...parts: string[]) => path.join(root, 'work', 'job_01', ...parts);
const files = (...parts: string[]) => path.join(root, 'spaces', 'sp_01', 'artifacts', ...parts);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A small zip-based presentation, as python-pptx writes one: binary, with NUL bytes. */
function pptxBytes(): Buffer {
  const contentTypes = Buffer.from(
    '<?xml version="1.0"?><Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(contentTypes.length, 18);
  header.writeUInt32LE(contentTypes.length, 22);
  header.writeUInt16LE('[Content_Types].xml'.length, 26);
  return Buffer.concat([
    header,
    Buffer.from('[Content_Types].xml'),
    contentTypes,
    Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x80, 0x81]),
  ]);
}

/** The first bytes of a PNG and some that are not UTF-8. */
function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xc3, 0x28]),
  ]);
}

const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;

/**
 * Make `file` in `folder` one this process can read but not remove, as a
 * folder the agent's code made is to the service: on POSIX a folder without
 * write permission, on Windows a deny on deleting the file or its folder's children.
 */
async function lockAgainstRemoval(folder: string, file: string): Promise<void> {
  if (process.platform === 'win32') {
    const who = process.env.USERNAME ?? '';
    const run = (args: string[]) => {
      const done = spawnSync('icacls', args, { stdio: 'ignore' });
      if (done.status !== 0) throw new Error(`icacls ${args.join(' ')} failed`);
    };
    run([folder, '/deny', `${who}:(DC)`]);
    run([file, '/deny', `${who}:(DE)`]);
    unlock = () => {
      spawnSync('icacls', [file, '/remove:d', who], { stdio: 'ignore' });
      spawnSync('icacls', [folder, '/remove:d', who], { stdio: 'ignore' });
    };
    return;
  }
  await chmod(folder, 0o555);
  unlock = () => {
    spawnSync('chmod', ['755', folder], { stdio: 'ignore' });
  };
}

const cases = [
  { name: 'Book_Club_Intro.pptx', bytes: pptxBytes },
  { name: 'chart.png', bytes: pngBytes },
] as const;

for (const each of cases) {
  test(`a binary ${path.extname(each.name)} the agent made reaches the person's Files`, async () => {
    const bytes = each.bytes();
    await writeFile(work(each.name), bytes);
    const action = connectorAction('files.move', {
      from: `/work/${each.name}`,
      to: each.name,
      to_area: 'artifacts',
      content_hash: sha(bytes),
    });
    const result = await connector().execute(action, connectorContext(action));
    expect(result.outcome).toBe('succeeded');
    expect(sha(await readFile(files(each.name)))).toBe(sha(bytes));
    await expect(stat(work(each.name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.skipIf(asRoot)(
    `a binary ${path.extname(each.name)} in a folder the service cannot change still reaches the person's Files`,
    async () => {
      const bytes = each.bytes();
      await mkdir(work('output'));
      await writeFile(work('output', each.name), bytes);
      await lockAgainstRemoval(work('output'), work('output', each.name));
      const action = connectorAction('files.move', {
        from: `output/${each.name}`,
        to: each.name,
        to_area: 'artifacts',
        content_hash: sha(bytes),
      });
      const result = await connector().execute(action, connectorContext(action));
      expect(result.outcome).toBe('succeeded');
      if (result.outcome !== 'succeeded') return;
      expect(sha(await readFile(files(each.name)))).toBe(sha(bytes));
      expect(result.receipt.detail).toMatchObject({
        content_hash: sha(bytes),
        bytes: bytes.byteLength,
        workspace_copy: 'kept',
      });
      expect(String(result.receipt.detail.workspace_note)).toContain(`/work/output/${each.name}`);
      // The workspace copy is left as it was.
      expect(sha(await readFile(work('output', each.name)))).toBe(sha(bytes));
      // Checked again later, the move is delivered: the copy left behind was said on its receipt.
      const recorded = { ...action, receipt: result.receipt as unknown as typeof action.receipt };
      const verdict = await connector().verify(recorded, connectorContext(recorded));
      expect(verdict.decision).toBe('succeeded');
      if (verdict.decision === 'succeeded')
        expect(verdict.evidence).toMatchObject({
          content_hash: sha(bytes),
          workspace_copy: 'kept',
        });
      // Without that receipt, a source still there leaves the move undecided.
      expect((await connector().verify(action, connectorContext(action))).decision).toBe(
        'undecided',
      );
    },
  );
}
