import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The contracts barrel also exports server code that runs node:crypto when it loads, so a value
// import from it breaks the browser bundle. The web app takes values from a subpath instead
// ('@melete/contracts/model-presets', '@melete/contracts/attachments', and so on); types are fine.
const VALUE_FROM_BARREL = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+'@melete\/contracts'/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test('the web app takes no values from the contracts barrel', () => {
  const offenders = sources(join(import.meta.dir)).filter((path) =>
    [...readFileSync(path, 'utf8').matchAll(VALUE_FROM_BARREL)].some((match) =>
      (match[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .some((name) => name !== '' && !name.startsWith('type ')),
    ),
  );
  expect(offenders).toEqual([]);
});
