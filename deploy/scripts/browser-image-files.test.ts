import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const entry = 'apps/melete/src/workers/browser/entry.ts';

// Every module the worker loads at run time, followed from its entry. Node erases
// `import type`, so those are left out; any other import is loaded, even one whose
// names are all types.
function runtimeModules(): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    const specifiers = [
      ...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+'(\.{1,2}\/[^']+)'/gms),
      ...source.matchAll(/^import\s+'(\.{1,2}\/[^']+)'/gm),
    ].map((match) => match[1] as string);
    for (const specifier of specifiers)
      queue.push(relative(root, join(root, dirname(file), specifier)).replaceAll('\\', '/'));
  }
  return [...seen].sort();
}

test('the browser image copies every module its worker loads', () => {
  const image = readFileSync(join(root, 'deploy/Dockerfile.browser'), 'utf8');
  const copied = [...image.matchAll(/^COPY\s+(\S+)\s+\S+$/gm)].map((match) => match[1] as string);
  const missing = runtimeModules().filter(
    (file) =>
      !copied.some((source) => (source.endsWith('/') ? file.startsWith(source) : file === source)),
  );
  expect(missing).toEqual([]);
});
