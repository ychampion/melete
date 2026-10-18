/**
 * A job's workspace left set aside, or a spare's directory left behind, that
 * holds a folder the service cannot move or empty: a runtime made it without
 * the group's write bit. The start reports that one job and goes on, and a
 * spare never takes over a workspace it could not give back whole.
 *
 * On Linux as an ordinary user the folder is really made unwritable (mode
 * 555), which is what a runtime folder of mode 755 owned by another user is to
 * the service. Where that cannot stop a move (Windows, or as root) the same
 * refusal is injected into the file calls instead, for those paths only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const real = process.platform !== 'win32' && process.getuid?.() !== 0;
/** Folders this service cannot move or empty, when the refusal is injected. */
const stuck = new Set<string>();
const refused = (path: string) =>
  Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: 'EACCES' });
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);
const parent = (path: string) => path.slice(0, path.lastIndexOf(sep));

if (!real) {
  const original = { ...fs };
  mock.module('node:fs/promises', () => ({
    ...original,
    access: async (path: string, mode?: number) => {
      if (stuck.has(String(path)) && mode === fs.constants.W_OK) throw refused(String(path));
      return original.access(path, mode);
    },
    rename: async (from: string, to: string) => {
      // A folder moves within its own directory without writing to itself.
      if (stuck.has(String(from)) && parent(String(from)) !== parent(String(to)))
        throw refused(String(from));
      await original.rename(from, to);
      // A folder moved with its directory stays as it was.
      for (const folder of [...stuck])
        if (inside(folder, String(from))) {
          stuck.delete(folder);
          stuck.add(String(to) + folder.slice(String(from).length));
        }
    },
    rm: async (path: string, options?: Parameters<typeof fs.rm>[1]) => {
      for (const folder of stuck)
        if (inside(folder, String(path)) && folder !== String(path)) throw refused(folder);
      return original.rm(path, options);
    },
  }));
}

const { LocalWorkspaceFs, WorkspaceRestoreError } = await import('./workspace-fs.ts');

const job = (index: number) => `job_01J0000000000000000000000${index}`;
let root = '';
let logged: string[] = [];
let write: ReturnType<typeof spyOn> | undefined;

/** A folder with a file in it that the service can neither move elsewhere nor empty. */
async function unmovableFolder(path: string) {
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'letter.md'), 'Dear Hiring Manager');
  if (real) await fs.chmod(path, 0o555);
  else stuck.add(path);
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'melete-restore-'));
});

afterEach(async () => {
  write?.mockRestore();
  stuck.clear();
  // Give every folder back its write bit so the next test starts clean.
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isDirectory()) await fs.chmod(join(entry.parentPath, entry.name), 0o755);
  for (const entry of await fs.readdir(root))
    await fs.rm(join(root, entry), { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function captureLog() {
  logged = [];
  write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
}

describe(`a start with leftovers it cannot put back (${real ? 'real permissions' : 'injected EACCES'})`, () => {
  test('reports the one job, puts back everything else, and starts', async () => {
    const workspace = new LocalWorkspaceFs(root);
    // Job 1 was stopped between the renames: its files set aside, the spare's
    // directory in its place, and the runtime's output folder unwritable.
    const aside = join(root, `.adopt-local.${job(1)}`);
    await fs.mkdir(join(root, job(1)));
    await fs.mkdir(aside);
    await fs.writeFile(join(aside, 'notes.md'), 'kept');
    await unmovableFolder(join(aside, 'out'));
    // Job 2 was stopped the same way, with nothing in the way.
    await fs.mkdir(join(root, job(2)));
    await fs.mkdir(join(root, `.adopt-local.${job(2)}`));
    await fs.writeFile(join(root, `.adopt-local.${job(2)}`, 'plan.md'), 'kept too');

    captureLog();
    await workspace.reconcileCellDirectories(async () => true, 'local');
    write?.mockRestore();

    // Job 2 is whole again; job 1 has what could move.
    expect(await fs.readFile(join(root, job(2), 'plan.md'), 'utf8')).toBe('kept too');
    expect(await fs.readFile(join(root, job(1), 'notes.md'), 'utf8')).toBe('kept');
    // Job 1's output folder is still set aside, under a claimed name, with its file.
    const left = (await fs.readdir(root)).filter((entry) => entry.startsWith('.adopt-'));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(new RegExp(`^\\.adopt-local~[a-f0-9]{12}\\.${job(1)}$`));
    expect(await fs.readFile(join(root, left[0] as string, 'out', 'letter.md'), 'utf8')).toBe(
      'Dear Hiring Manager',
    );
    const line = logged.join('');
    expect(line).toContain(`workspace_restore_failed job=${job(1)}`);
    expect(line).toContain('error=EACCES left=1');
    expect(line).not.toContain('letter.md');
    expect(line).not.toContain(job(2));
  });

  test('the next start tries that job again, and finishes once the folder can move', async () => {
    const workspace = new LocalWorkspaceFs(root);
    const aside = join(root, `.adopt-local.${job(3)}`);
    await fs.mkdir(join(root, job(3)));
    await unmovableFolder(join(aside, 'out'));
    captureLog();
    await workspace.reconcileCellDirectories(async () => true, 'local');
    write?.mockRestore();
    expect(logged.join('')).toContain(`workspace_restore_failed job=${job(3)}`);
    // An operator gives the folder its write bit back.
    const [claimed] = (await fs.readdir(root)).filter((entry) => entry.startsWith('.adopt-'));
    const out = join(root, claimed as string, 'out');
    if (real) await fs.chmod(out, 0o775);
    stuck.clear();
    await workspace.reconcileCellDirectories(async () => true, 'local');
    expect(await fs.readFile(join(root, job(3), 'out', 'letter.md'), 'utf8')).toBe(
      'Dear Hiring Manager',
    );
    expect((await fs.readdir(root)).sort()).toEqual([job(3)]);
  });

  test("a spare's directory it cannot empty is reported and left, and the start goes on", async () => {
    const workspace = new LocalWorkspaceFs(root);
    await unmovableFolder(join(root, '.spare-local.aaaaaaaaaaaaaaaaaaaaaaaa', 'out'));
    await fs.mkdir(join(root, '.spare-local.bbbbbbbbbbbbbbbbbbbbbbbb'));
    await fs.mkdir(join(root, job(4)));
    await fs.mkdir(join(root, `.adopt-local.${job(4)}`));
    await fs.writeFile(join(root, `.adopt-local.${job(4)}`, 'kept.txt'), 'kept');
    captureLog();
    await workspace.reconcileCellDirectories(async () => true, 'local');
    write?.mockRestore();
    expect(logged.join('')).toContain(
      'spare_directory_remove_failed directory=.spare-local.aaaaaaaaaaaaaaaaaaaaaaaa error=EACCES',
    );
    expect(await fs.readFile(join(root, job(4), 'kept.txt'), 'utf8')).toBe('kept');
    expect((await fs.readdir(root)).sort()).toEqual([
      '.spare-local.aaaaaaaaaaaaaaaaaaaaaaaa',
      job(4),
    ]);
  });

  test('a set-aside under a name that is no job is reported and skipped', async () => {
    const workspace = new LocalWorkspaceFs(root);
    await fs.mkdir(join(root, '.adopt-local.not-a-job'));
    captureLog();
    await workspace.reconcileCellDirectories(async () => true, 'local');
    write?.mockRestore();
    expect(logged.join('')).toContain(
      'workspace_restore_failed job=unknown directory=.adopt-local.not-a-job',
    );
  });
});

describe(`a spare taking over a workspace (${real ? 'real permissions' : 'injected EACCES'})`, () => {
  test('is refused, with nothing moved, when the workspace has a folder that could not come back', async () => {
    const workspace = new LocalWorkspaceFs(root);
    const spare = '.spare-local.cccccccccccccccccccccccc';
    await fs.mkdir(join(root, spare));
    await fs.mkdir(join(root, job(5)));
    await fs.writeFile(join(root, job(5), 'notes.md'), 'kept');
    await unmovableFolder(join(root, job(5), 'out'));
    const refusal = await workspace
      .adopt(spare, job(5), `.adopt-local.${job(5)}`)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WorkspaceRestoreError);
    expect((refusal as InstanceType<typeof WorkspaceRestoreError>).code).toBe('EACCES');
    // The workspace is as it was, and the spare's directory is still its own.
    expect((await fs.readdir(root)).sort()).toEqual([spare, job(5)]);
    expect((await fs.readdir(join(root, job(5)))).sort()).toEqual(['notes.md', 'out']);
  });

  test('takes over a workspace whose folders can all move, as before', async () => {
    const workspace = new LocalWorkspaceFs(root);
    const spare = '.spare-local.dddddddddddddddddddddddd';
    await fs.mkdir(join(root, spare));
    await fs.writeFile(join(root, spare, 'scratch'), 'x');
    await fs.mkdir(join(root, job(6), 'out'), { recursive: true });
    await fs.writeFile(join(root, job(6), 'out', 'letter.md'), 'Dear Hiring Manager');
    await workspace.adopt(spare, job(6), `.adopt-local.${job(6)}`);
    expect((await fs.readdir(root)).sort()).toEqual([job(6)]);
    expect(await fs.readFile(join(root, job(6), 'out', 'letter.md'), 'utf8')).toBe(
      'Dear Hiring Manager',
    );
    expect(await fs.readFile(join(root, job(6), 'scratch'), 'utf8')).toBe('x');
  });
});
