import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { EMPTY_COUNTS } from '@melete/contracts';
import { onlyHeldWorkspacesLeft } from './removal.ts';

const workRoot = resolve('work-root-that-is-not-on-disk');
const emptied = { kind: 'emptied' as const, jobIds: ['job_captured'] };
const left = (paths: string[]) => ({ ...EMPTY_COUNTS, paths });

describe('what an emptied space may open again with', () => {
  test('the workspace of a job captured at the fence', () => {
    expect(onlyHeldWorkspacesLeft(emptied, workRoot, left([join(workRoot, 'job_captured')]))).toBe(
      true,
    );
  });

  test('never another workspace under the same root, a new job included', () => {
    expect(onlyHeldWorkspacesLeft(emptied, workRoot, left([join(workRoot, 'job_new')]))).toBe(
      false,
    );
    expect(
      onlyHeldWorkspacesLeft(
        emptied,
        workRoot,
        left([join(workRoot, 'job_captured'), join(workRoot, 'job_new')]),
      ),
    ).toBe(false);
    // Nor the root itself, nor something inside a captured workspace.
    expect(onlyHeldWorkspacesLeft(emptied, workRoot, left([workRoot]))).toBe(false);
    expect(
      onlyHeldWorkspacesLeft(emptied, workRoot, left([join(workRoot, 'job_captured', 'inner')])),
    ).toBe(false);
  });

  test('never for a removed space, and never with anything else left', () => {
    const captured = left([join(workRoot, 'job_captured')]);
    expect(onlyHeldWorkspacesLeft({ ...emptied, kind: 'removed' }, workRoot, captured)).toBe(false);
    expect(onlyHeldWorkspacesLeft(emptied, workRoot, { ...captured, tables: { job: 1 } })).toBe(
      false,
    );
  });
});
