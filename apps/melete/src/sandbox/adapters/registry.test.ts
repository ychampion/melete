import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SANDBOX_ADAPTERS } from '@melete/contracts';
import { SANDBOX_ADAPTER_PLUGINS } from './registry.ts';

const SOURCE = path.resolve(import.meta.dir, '../..');

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

test('every sandbox adapter the contract names has one plugin entry', () => {
  expect(Object.keys(SANDBOX_ADAPTER_PLUGINS).sort()).toEqual([...SANDBOX_ADAPTERS].sort());
});

test('the Modal SDK is loaded only when a Modal connection is first used', async () => {
  const valueImports: string[] = [];
  const dynamicImports: string[] = [];
  for (const file of await sources(SOURCE)) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(SOURCE, file).replaceAll('\\', '/');
    // A type import is erased at build time; a value import would load the SDK at start.
    if (/^import (?!type )[^;]*from 'modal';/m.test(text)) valueImports.push(relative);
    if (text.includes("import('modal')")) dynamicImports.push(relative);
  }
  expect(valueImports).toEqual([]);
  expect(dynamicImports).toEqual(['sandbox/adapters/modal-sdk.ts']);
});
