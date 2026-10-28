import { afterAll, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// The contracts barrel also exports server code that runs node:crypto when it loads, so a value
// import from it breaks the browser bundle. The web app takes values from a subpath instead
// ('@melete/contracts/model-presets', '@melete/contracts/attachments', and so on); types are fine.
function valuesFromBarrel(source: string, file?: string): boolean {
  return runtimeImports(source, file).includes('@melete/contracts');
}

function runtimeImports(source: string, file = 'source.tsx'): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    // verbatimModuleSyntax keeps every declaration that lacks the statement-level `type` keyword,
    // so `import { type Value } from 'x'` still compiles to `import {} from 'x'` and loads it.
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (
        specifier &&
        (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))
      )
        imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}

function nodeDependencies(entry: string, visited = new Set<string>()): string[][] {
  if (visited.has(entry)) return [];
  visited.add(entry);
  return runtimeImports(readFileSync(entry, 'utf8'), entry).flatMap((specifier) => {
    if (specifier.startsWith('node:')) return [[entry, specifier]];
    if (
      !specifier.startsWith('.') &&
      specifier !== '@melete/contracts' &&
      !specifier.startsWith('@melete/contracts/')
    )
      return [];
    return nodeDependencies(Bun.resolveSync(specifier, dirname(entry)), visited).map((chain) => [
      entry,
      ...chain,
    ]);
  });
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test('the web app takes no values from the contracts barrel', () => {
  const offenders = sources(join(import.meta.dir)).filter((path) =>
    valuesFromBarrel(readFileSync(path, 'utf8'), path),
  );
  expect(offenders).toEqual([]);
});

test.each([
  "import { value } from '@melete/contracts';",
  "export { value } from '@melete/contracts';",
  "export * from '@melete/contracts';",
  "export * as contracts from '@melete/contracts';",
  "import * as contracts from '@melete/contracts';",
  "import '@melete/contracts';",
  "const contracts = import('@melete/contracts');",
  'const contracts = import(`@melete/contracts`);',
  "import contracts from '@melete/contracts';",
  "import contracts, { value } from '@melete/contracts';",
  "import contracts, { type Value } from '@melete/contracts';",
  "import { type Value, value } from '@melete/contracts';",
  "export { type Value, value } from '@melete/contracts';",
  "import { type Value, type Other as Alias } from '@melete/contracts';",
  "export { type Value, type Other as Alias } from '@melete/contracts';",
  'import { value } from "@melete/contracts";',
  "import /* a comment */ { value }\nfrom '@melete/contracts';",
  "import {} from '@melete/contracts';",
  "export {} from '@melete/contracts';",
])('rejects a runtime barrel dependency: %s', (source) => {
  expect(valuesFromBarrel(source)).toBe(true);
});

test.each([
  "import type { Value } from '@melete/contracts';",
  "import type * as Contracts from '@melete/contracts';",
  "import type Contracts from '@melete/contracts';",
  "export type { Value } from '@melete/contracts';",
  "export type * from '@melete/contracts';",
  "export type * as Contracts from '@melete/contracts';",
  "type Value = import('@melete/contracts').Value;",
  "import { value } from '@melete/contracts/model-presets';",
  "// import { value } from '@melete/contracts';",
  'const example = "import { value } from \'@melete/contracts\'";',
])('allows types, subpaths, and text: %s', (source) => {
  expect(valuesFromBarrel(source)).toBe(false);
});

test('checks imports after a generic arrow function in a TypeScript file', () => {
  expect(
    valuesFromBarrel(
      "const identity = <T>(value: T) => value; export * from '@melete/contracts';",
      'source.ts',
    ),
  ).toBe(true);
});

test('ignores import-looking JSX text in a TSX file', () => {
  expect(valuesFromBarrel("const note = <p>import '@melete/contracts'</p>;", 'source.tsx')).toBe(
    false,
  );
});

test('the contracts subpaths used by the web app have no Node dependencies', () => {
  const subpaths = new Set(
    sources(import.meta.dir).flatMap((path) =>
      runtimeImports(readFileSync(path, 'utf8'), path).filter((specifier) =>
        specifier.startsWith('@melete/contracts/'),
      ),
    ),
  );
  expect(subpaths.size).toBeGreaterThan(0);
  const offenders = [...subpaths].flatMap((specifier) =>
    nodeDependencies(Bun.resolveSync(specifier, import.meta.dir)).map((chain) => [
      specifier,
      ...chain,
    ]),
  );
  expect(offenders).toEqual([]);
});

const fixture = mkdtempSync(join(import.meta.dir, '../node_modules/.contracts-imports-'));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function fixtureModule(name: string, source: string): string {
  const path = join(fixture, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

test.each([
  "import './bridge.ts';",
  "export { value } from './bridge.ts';",
  "export * from './bridge.ts';",
  "const load = () => import('./bridge.ts');",
  "const identity = <T>(value: T) => value; import './bridge.ts';",
  "import { type Value } from './bridge.ts';",
  "export { type Value } from './bridge.ts';",
])('follows a transitive runtime dependency: %s', (source) => {
  const entry = fixtureModule('model-presets.ts', source);
  const bridge = fixtureModule('bridge.ts', "export * from './server.ts';");
  const server = fixtureModule('server.ts', "import 'node:crypto'; export const value = 1;");
  expect(nodeDependencies(entry)).toEqual([[entry, bridge, server, 'node:crypto']]);
});

test.each(['effects', 'broker', 'mcp'])('detects a dependency on contracts/%s', (name) => {
  const entry = fixtureModule(
    'entry.ts',
    `import '../../../../packages/contracts/src/${name}.ts';`,
  );
  const paths = nodeDependencies(entry);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths[0]?.at(-1)).toBe('node:crypto');
});

test('ignores type-only graph edges and terminates cycles', () => {
  const entry = fixtureModule(
    'safe.ts',
    `
    import type { Value } from './missing.ts';
    export type * from './missing.ts';
    import './cycle.ts';
  `,
  );
  fixtureModule('cycle.ts', "export * from './safe.ts';");
  expect(nodeDependencies(entry)).toEqual([]);
});

test('does not silently skip an unresolved relative dependency', () => {
  const entry = fixtureModule('unresolved.ts', "import './missing.ts';");
  expect(() => nodeDependencies(entry)).toThrow();
});
