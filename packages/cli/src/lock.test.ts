import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, type LockAccess, LockRefusal, withLock } from './lock.ts';

const access = (
  pid: number,
  host = 'box',
  alive: (pid: number) => boolean = () => true,
): LockAccess => ({
  pid,
  host,
  now: () => new Date('2026-10-02T10:00:00Z'),
  alive,
});

const deployDir = () => mkdtempSync(join(tmpdir(), 'melete-lock-'));
const lockDir = (dir: string) => join(dir, '.melete', 'lock');

describe('the deployment lock', () => {
  test('a second command is refused while the first holds the lock, and admitted after', () => {
    const dir = deployDir();
    const release = acquireLock(dir, 'set', access(100));
    expect(() => acquireLock(dir, 'init', access(200))).toThrow(
      /Another melete command holds .*: set \(process 100 on box/,
    );
    release();
    expect(existsSync(lockDir(dir))).toBe(false);
    acquireLock(dir, 'init', access(200))();
  });

  test('a lock left by a process that has ended on this machine is taken over', () => {
    const dir = deployDir();
    acquireLock(dir, 'set', access(100));
    const release = acquireLock(
      dir,
      'init',
      access(200, 'box', (pid) => pid !== 100),
    );
    expect(JSON.parse(readFileSync(join(lockDir(dir), 'holder'), 'utf8'))).toMatchObject({
      pid: 200,
      command: 'init',
    });
    release();
  });

  test("a lock written on another machine is never taken over, since its process can't be seen", () => {
    const dir = deployDir();
    acquireLock(dir, 'set', access(100, 'other-host'));
    expect(() =>
      acquireLock(
        dir,
        'init',
        access(200, 'box', () => false),
      ),
    ).toThrow(LockRefusal);
  });

  test('a lock without a holder is refused and named', () => {
    const dir = deployDir();
    mkdirSync(lockDir(dir), { recursive: true });
    expect(() => acquireLock(dir, 'set', access(1))).toThrow(/exists without a holder/);
  });

  test('releasing does not remove a lock someone else took over', () => {
    const dir = deployDir();
    const release = acquireLock(dir, 'set', access(100));
    writeFileSync(
      join(lockDir(dir), 'holder'),
      JSON.stringify({ pid: 300, host: 'box', command: 'init', since: '' }),
    );
    release();
    expect(existsSync(lockDir(dir))).toBe(true);
  });

  test('the lock is released when the action throws', async () => {
    const dir = deployDir();
    await expect(
      withLock(
        dir,
        'set',
        async () => {
          throw new Error('boom');
        },
        access(100),
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(lockDir(dir))).toBe(false);
  });
});
