import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import { appendHistory, historyPath, lastDeployed, readHistory } from './history.ts';
import { downloadBytes, inspectRemote, repositoryOf } from './images.ts';

const ok = (value: unknown): CommandOutput => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});

describe('the registry reader', () => {
  test('an index is followed to the engine platform, and its layers pair with the configuration', () => {
    const calls: string[] = [];
    const run = (command: readonly string[]): CommandOutput => {
      const text = command.join(' ');
      calls.push(text);
      if (text.endsWith('{{json .Manifest}}'))
        return ok({
          mediaType: 'application/vnd.oci.image.index.v1+json',
          digest: 'sha256:index',
          manifests: [
            { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
            { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
            { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
          ],
        });
      if (text.endsWith('{{json .Image}}'))
        return ok({
          'linux/arm64': { rootfs: { diff_ids: ['x'] } },
          'linux/amd64': {
            config: { Labels: { 'org.opencontainers.image.revision': 'abc' } },
            rootfs: { diff_ids: ['sha256:one', 'sha256:two'] },
          },
        });
      if (text === 'docker buildx imagetools inspect --raw ghcr.io/o/melete-web@sha256:amd')
        return ok({ layers: [{ size: 10 }, { size: 20 }] });
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    expect(inspectRemote(run, 'ghcr.io/o/melete-web:main', 'amd64')).toEqual({
      ref: 'ghcr.io/o/melete-web:main',
      digest: 'sha256:index',
      revision: 'abc',
      layers: [
        { diffId: 'sha256:one', size: 10 },
        { diffId: 'sha256:two', size: 20 },
      ],
    });
  });

  test('a layer the engine has, or one counted already, is not counted again', () => {
    const remote = {
      ref: 'r',
      digest: 'd',
      revision: null,
      layers: [
        { diffId: 'a', size: 5 },
        { diffId: 'b', size: 7 },
        { diffId: 'b', size: 7 },
      ],
    };
    expect(downloadBytes(remote, new Set(['a']))).toBe(7);
  });

  test('a repository keeps its registry port and loses only its tag or digest', () => {
    expect(repositoryOf('registry.lan:5000/team/melete-web:v1')).toBe(
      'registry.lan:5000/team/melete-web',
    );
    expect(repositoryOf('ghcr.io/o/melete-web@sha256:abc')).toBe('ghcr.io/o/melete-web');
  });
});

describe('the deployment history', () => {
  test('entries are read back in order, a damaged line is skipped, and the last finished run is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melete-history-'));
    const entry = (result: 'deployed' | 'failed', to: string) => ({
      at: '2026-10-02T10:00:00.000Z',
      command: 'deploy' as const,
      from: { tag: 'main', revision: null },
      to: { tag: to, revision: null },
      checkout: null,
      migrations: { from: 1, to: 1 },
      backup: null,
      result,
      detail: '',
    });
    appendHistory(dir, entry('deployed', 'one'));
    appendFileSync(historyPath(dir), '{"not": "an entry"\n');
    appendHistory(dir, entry('failed', 'two'));
    const entries = readHistory(dir);
    expect(entries.map((item) => item.to.tag)).toEqual(['one', 'two']);
    expect(lastDeployed(entries)?.to.tag).toBe('one');
  });
});
