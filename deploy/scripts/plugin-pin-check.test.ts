import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRuntimePluginPin,
  declaredPluginSha,
  PLUGIN_DIRECTORY,
  pluginDigest,
  RUNTIME_DOCKERFILE,
  storedBytes,
  trackedPluginDigest,
  trackedPluginFiles,
} from './plugin-pin-check.ts';

const root = join(import.meta.dir, '..', '..');
const created: string[] = [];
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

const STALE = '0'.repeat(64);

/** A repository holding a plugin directory and a Dockerfile that pins it. */
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'melete-plugin-pin-'));
  created.push(directory);
  mkdirSync(join(directory, 'plugin', 'inner'), { recursive: true });
  mkdirSync(join(directory, 'plugin', '__pycache__'), { recursive: true });
  // first.py is written with CRLF, the endings a Windows checkout can produce.
  // The digest must follow the bytes git stores, not the bytes on this disk.
  writeFileSync(join(directory, 'plugin', 'first.py'), 'one\r\ntwo\r\n');
  writeFileSync(join(directory, 'plugin', 'inner', 'second.py'), 'three\n');
  writeFileSync(join(directory, 'plugin', '__pycache__', 'first.cpython-312.pyc'), 'compiled\n');
  writeFileSync(join(directory, 'plugin', 'untracked.py'), 'four\n');
  writeFileSync(join(directory, 'Dockerfile'), `ARG MELETE_PLUGIN_SHA=${STALE}\n`);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: directory });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  run('init', '--quiet');
  run('add', 'Dockerfile', 'plugin/first.py', 'plugin/inner/second.py');
  run('add', '--force', 'plugin/__pycache__/first.cpython-312.pyc');
  return directory;
}

const check = (directory: string) => checkRuntimePluginPin(directory, 'Dockerfile', 'plugin')[0];
const digest = (directory: string) => trackedPluginDigest(directory, 'plugin');
const pin = (directory: string, value: string) =>
  writeFileSync(join(directory, 'Dockerfile'), `ARG MELETE_PLUGIN_SHA=${value}\n`);

describe('the plugin content pin', () => {
  test('a stale pin fails, and the failure names the value to paste', () => {
    const repository = fixture();
    const result = check(repository);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toBe(`ARG MELETE_PLUGIN_SHA=${digest(repository)} (declared: ${STALE})`);
  });

  test('the pin the failure names passes', () => {
    const repository = fixture();
    pin(repository, digest(repository));
    expect(check(repository)?.ok).toBe(true);
  });

  test('the digest is the one the build computes over the same content', () => {
    // What build-metadata.py hashes: files sorted by relative path, each with
    // its LF bytes, path and content separated and terminated by NUL. Compiled
    // and untracked files reach neither the image nor the digest.
    const repository = fixture();
    expect(trackedPluginFiles(repository, 'plugin').map((file) => file.path)).toEqual([
      'first.py',
      'inner/second.py',
    ]);
    expect(digest(repository)).toBe(
      pluginDigest([
        { path: 'inner/second.py', bytes: Buffer.from('three\n') },
        { path: 'first.py', bytes: Buffer.from('one\ntwo\n') },
      ]),
    );
  });

  test('the endings in the working tree do not move the digest', () => {
    const repository = fixture();
    const before = digest(repository);
    writeFileSync(join(repository, 'plugin', 'first.py'), 'one\ntwo\n');
    expect(digest(repository)).toBe(before);
  });

  test('a changed plugin file fails the pin that described the old one', () => {
    const repository = fixture();
    pin(repository, digest(repository));
    writeFileSync(join(repository, 'plugin', 'inner', 'second.py'), 'four\n');
    expect(check(repository)?.ok).toBe(false);
    pin(repository, digest(repository));
    expect(check(repository)?.ok).toBe(true);
  });

  test('a Dockerfile without the ARG declares no pin', () => {
    expect(declaredPluginSha('FROM python:3.12-slim\n')).toBeUndefined();
    expect(declaredPluginSha(`ARG MELETE_PLUGIN_SHA=${'a'.repeat(63)}\n`)).toBeUndefined();
    expect(declaredPluginSha(`ARG MELETE_PLUGIN_SHA=${'a'.repeat(64)}\r\n`)).toBe('a'.repeat(64));
  });

  test('only a text file has its endings rewritten', () => {
    expect([...storedBytes(Buffer.from('a\r\nb\r'))]).toEqual([...Buffer.from('a\nb\r')]);
    expect([...storedBytes(Buffer.from('a\r\n\0'))]).toEqual([...Buffer.from('a\r\n\0')]);
  });
});

describe('the shipped runtime image', () => {
  test('its Dockerfile pins the plugin directory as tracked', () => {
    expect(
      checkRuntimePluginPin(root)
        .filter((result) => !result.ok)
        .map((result) => `${result.name}: ${result.detail}`),
    ).toEqual([]);
  });

  test('the declared pin is the digest over the tracked plugin directory', () => {
    const declared = declaredPluginSha(readFileSync(join(root, RUNTIME_DOCKERFILE), 'utf8'));
    expect(declared).toMatch(/^[0-9a-f]{64}$/);
    expect(declared).toBe(trackedPluginDigest(root, PLUGIN_DIRECTORY));
  });
});
