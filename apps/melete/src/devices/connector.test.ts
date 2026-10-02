import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { saveScreenshot, unreadableReply } from './connector.ts';

const malformed = () => {
  const parsed = z
    .object({ content: z.string(), content_hash: z.string().regex(/^[0-9a-f]{64}$/) })
    .safeParse({ content: 'oat milk', content_hash: 'not-a-hash' });
  if (parsed.success) throw new Error('expected a malformed reply');
  return parsed.error;
};

describe('a companion answer that does not have its promised shape', () => {
  test('a reading tool fails with a reason that names the field, never raw validator output', () => {
    const result = unreadableReply('read_file', 'Laptop', malformed());
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.reason).toBe(
      'Laptop answered in a form Melete could not read: content_hash was not what this tool returns.',
    );
    expect(result.reason).not.toContain('[');
    expect(result.reason.length).toBeLessThanOrEqual(300);
  });

  test('a tool with an effect is unknown, because the computer may already have done it', () => {
    const result = unreadableReply('write_file', 'Laptop', malformed());
    expect(result).toMatchObject({ outcome: 'unknown' });
    if (result.outcome === 'unknown') expect(result.reason).toContain('It may have happened');
  });
});

describe('a screenshot kept in a workspace the computer can write to', () => {
  const JOB = 'job_shot1';
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const roots: string[] = [];
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const fixture = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'melete-shot-'));
    roots.push(root);
    const work = path.join(root, 'work');
    const outside = path.join(root, 'spaces', 'sp_other', 'artifacts');
    await mkdir(path.join(work, JOB), { recursive: true });
    await mkdir(outside, { recursive: true });
    return { work, job: path.join(work, JOB), outside };
  };

  test('is written under device/ with owner-only access', async () => {
    const { work, job } = await fixture();
    expect(await saveScreenshot(work, JOB, 'act_1', PNG)).toBe('device/screenshot-act_1.png');
    const file = path.join(job, 'device', 'screenshot-act_1.png');
    expect(new Uint8Array(await readFile(file))).toEqual(PNG);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test('is refused when device/ leads to another space', async () => {
    const { work, job, outside } = await fixture();
    await symlink(outside, path.join(job, 'device'), directoryLink);
    await expect(saveScreenshot(work, JOB, 'act_2', PNG)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test('is refused when the job workspace itself is a link', async () => {
    const { work, job, outside } = await fixture();
    await rm(job, { recursive: true });
    await symlink(outside, job, directoryLink);
    await expect(saveScreenshot(work, JOB, 'act_3', PNG)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'is refused when the screenshot name is a link to a file elsewhere',
    async () => {
      const { work, job, outside } = await fixture();
      const victim = path.join(outside, 'notes.md');
      await writeFile(victim, 'kept');
      await mkdir(path.join(job, 'device'));
      await symlink(victim, path.join(job, 'device', 'screenshot-act_4.png'), 'file');
      await expect(saveScreenshot(work, JOB, 'act_4', PNG)).rejects.toThrow();
      expect(await readFile(victim, 'utf8')).toBe('kept');
    },
  );

  test('is refused when the screenshot name is a second name for a file elsewhere', async () => {
    const { work, job, outside } = await fixture();
    const victim = path.join(outside, 'notes.md');
    await writeFile(victim, 'kept');
    await mkdir(path.join(job, 'device'));
    await link(victim, path.join(job, 'device', 'screenshot-act_5.png'));
    await expect(saveScreenshot(work, JOB, 'act_5', PNG)).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toBe('kept');
  });
});
